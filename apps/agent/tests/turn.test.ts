/**
 * Agent-3 — the tool-enabled turn runner wiring. Verifies the ports thread the
 * shared loop correctly: `generate` reaches the broker, `dispatchTool` routes
 * through the cap-checked intents service carrying the DECLARED verb/type, and
 * the loop's transcript surfaces as the "used tool" summary.
 */

import {
	type AgentTool,
	type AiGenerateRequest,
	type AiGenerateResult,
	type Intent,
	type IntentResult,
	MessageRole,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { makeDispatchTool, makeGenerate, runAgentTurn, usedToolNames } from "../src/logic/turn";

const openTool: AgentTool = { verb: "open", label: "Open an object" };

function fakeAi(replies: readonly string[]): {
	generate: (req: AiGenerateRequest) => Promise<AiGenerateResult>;
	calls: AiGenerateRequest[];
} {
	const calls: AiGenerateRequest[] = [];
	let i = 0;
	return {
		calls,
		generate: async (req) => {
			calls.push(req);
			const content = replies[Math.min(i, replies.length - 1)] ?? '{"final":"done"}';
			i++;
			return { content, provider: "ollama", model: "llama3.2" };
		},
	};
}

function fakeIntents(value: unknown = { ok: true }): {
	dispatch: (i: Omit<Intent, "source">) => Promise<IntentResult | null>;
	suggest: () => Promise<never[]>;
	dispatched: Array<Omit<Intent, "source">>;
} {
	const dispatched: Array<Omit<Intent, "source">> = [];
	return {
		dispatched,
		dispatch: async (intent) => {
			dispatched.push(intent);
			return { handled: true, value };
		},
		suggest: async () => [],
	};
}

describe("makeGenerate", () => {
	it("maps a broker result to the loop's generate shape with provenance", async () => {
		const ai = fakeAi(['{"final":"hi"}']);
		const generate = makeGenerate(ai);
		const out = await generate([{ role: MessageRole.User, content: "hi" }]);
		expect(out.content).toBe('{"final":"hi"}');
		expect(out.provenance?.provider).toBe("ollama");
		expect(out.provenance?.model).toBe("llama3.2");
	});

	it("threads a pinned provider/model onto the request (Agent-5)", async () => {
		const ai = fakeAi(['{"final":"hi"}']);
		const generate = makeGenerate(ai, { provider: "anthropic", model: "claude" });
		await generate([{ role: MessageRole.User, content: "hi" }]);
		expect(ai.calls[0]?.provider).toBe("anthropic");
		expect(ai.calls[0]?.model).toBe("claude");
	});

	it("omits provider/model when unpinned (AUTO — broker routes)", async () => {
		const ai = fakeAi(['{"final":"hi"}']);
		const generate = makeGenerate(ai);
		await generate([{ role: MessageRole.User, content: "hi" }]);
		expect(ai.calls[0]?.provider).toBeUndefined();
		expect(ai.calls[0]?.model).toBeUndefined();
	});
});

describe("makeDispatchTool (security mapping)", () => {
	it("dispatches the declared verb through the intents service", async () => {
		const intents = fakeIntents({ opened: true });
		const dispatch = makeDispatchTool(intents, [openTool]);
		const out = await dispatch({ tool: "open", args: { entityId: "ent_1" } });
		expect(intents.dispatched).toEqual([{ verb: "open", payload: { entityId: "ent_1" } }]);
		expect(out).toEqual({ opened: true });
	});

	it("fails closed on a verb not in the curated set", async () => {
		const intents = fakeIntents();
		const dispatch = makeDispatchTool(intents, [openTool]);
		await expect(dispatch({ tool: "delete", args: {} })).rejects.toThrow(/unknown tool/);
		expect(intents.dispatched).toEqual([]);
	});
});

describe("runAgentTurn", () => {
	it("runs a tool call then a final answer; surfaces the used tool", async () => {
		const ai = fakeAi([
			'{"tool":"open","args":{"entityId":"ent_42"}}',
			'{"final":"Opened it for you.","citations":["ent_42"]}',
		]);
		const intents = fakeIntents();
		const result = await runAgentTurn(
			{ ai, intents },
			{
				tools: [openTool],
				frozenCapabilities: ["intents.dispatch:open"],
				transcript: [{ role: MessageRole.User, content: "open ent_42" }],
			},
		);
		expect(result.finalAnswer).toBe("Opened it for you.");
		expect(result.citations).toEqual(["ent_42"]);
		expect(intents.dispatched).toEqual([{ verb: "open", payload: { entityId: "ent_42" } }]);
		expect(usedToolNames(result)).toEqual(["open"]);
	});

	it("threads the conversation's pinned provider/model onto every generate (Agent-5)", async () => {
		const ai = fakeAi(['{"final":"done"}']);
		const intents = fakeIntents();
		await runAgentTurn(
			{ ai, intents },
			{
				tools: [openTool],
				frozenCapabilities: ["intents.dispatch:open"],
				transcript: [{ role: MessageRole.User, content: "hi" }],
				provider: "anthropic",
				model: "claude",
			},
		);
		expect(ai.calls.every((c) => c.provider === "anthropic" && c.model === "claude")).toBe(true);
	});

	it("never offers a tool the frozen caps do not cover (fail-closed)", async () => {
		const ai = fakeAi(['{"tool":"open","args":{"entityId":"ent_9"}}', '{"final":"done"}']);
		const intents = fakeIntents();
		const result = await runAgentTurn(
			{ ai, intents },
			{
				// caps DROP intents.dispatch:open → the open tool is not offered, and
				// the model's call for it is refused at dispatch (re-check).
				tools: [openTool],
				frozenCapabilities: ["ai.use"],
				transcript: [{ role: MessageRole.User, content: "open ent_9" }],
			},
		);
		expect(intents.dispatched).toEqual([]);
		expect(usedToolNames(result)).toEqual([]);
		expect(result.finalAnswer).toBe("done");
	});

	it("threads the retrieval context block into the loop's system region (Agent-4)", async () => {
		const ai = fakeAi(['{"final":"grounded","citations":["ent_42"]}']);
		const intents = fakeIntents();
		await runAgentTurn(
			{ ai, intents },
			{
				tools: [openTool],
				frozenCapabilities: ["intents.dispatch:open"],
				transcript: [{ role: MessageRole.User, content: "what are the renewals?" }],
				retrievalContext: "Relevant objects from the user's vault:\n- [ent_42] Renewals plan",
			},
		);
		const system = ai.calls[0]?.messages.find((m) => m.role === MessageRole.System);
		expect(system?.content).toContain("[ent_42] Renewals plan");
	});

	it("plain-chat parity: a non-protocol reply ends the turn as the final answer", async () => {
		const ai = fakeAi(["Just a friendly reply, no tools needed."]);
		const intents = fakeIntents();
		const generateSpy = vi.spyOn(ai, "generate");
		const result = await runAgentTurn(
			{ ai, intents },
			{
				tools: [openTool],
				frozenCapabilities: ["intents.dispatch:open"],
				transcript: [{ role: MessageRole.User, content: "hello" }],
			},
		);
		expect(result.finalAnswer).toBe("Just a friendly reply, no tools needed.");
		expect(intents.dispatched).toEqual([]);
		expect(generateSpy).toHaveBeenCalledOnce();
	});
});
