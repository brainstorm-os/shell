import { type AiChatMessage, MessageRole } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DEMO_AGENT_APPFORGE_MODE,
	DEMO_AGENT_APPFORGE_SCRIPT,
	DEMO_AGENT_PROVIDER_ID,
	DEMO_AGENT_SCRIPT,
	createDemoAgentProvider,
	demoScriptForMode,
	demoScriptIndex,
	nextDemoReply,
} from "./demo-agent-provider";

const sys: AiChatMessage = { role: MessageRole.System, content: "tools…" };
const user: AiChatMessage = { role: MessageRole.User, content: "follow up on my call" };
const toolAck = (i: number): AiChatMessage => ({
	role: MessageRole.Tool,
	content: `[propose] ${i}`,
});

function transcriptWithAcks(n: number): AiChatMessage[] {
	return [sys, user, ...Array.from({ length: n }, (_, i) => toolAck(i))];
}

describe("demo-agent-provider — scripted propose sequence", () => {
	it("walks the script by counting fed-back tool acks, then finalizes", () => {
		expect(demoScriptIndex([sys, user])).toBe(0);
		expect(demoScriptIndex(transcriptWithAcks(1))).toBe(1);
		expect(demoScriptIndex(transcriptWithAcks(2))).toBe(2);
		expect(demoScriptIndex(transcriptWithAcks(3))).toBe(3);
	});

	it("clamps past the end so the loop always reaches the final answer", () => {
		expect(demoScriptIndex(transcriptWithAcks(99))).toBe(DEMO_AGENT_SCRIPT.length - 1);
	});

	it("emits a propose-contact, then -task, then -event, then a final", () => {
		expect(JSON.parse(nextDemoReply([sys, user])).tool).toBe("propose-contact");
		expect(JSON.parse(nextDemoReply(transcriptWithAcks(1))).tool).toBe("propose-task");
		expect(JSON.parse(nextDemoReply(transcriptWithAcks(2))).tool).toBe("propose-event");
		const final = JSON.parse(nextDemoReply(transcriptWithAcks(3)));
		expect(typeof final.final).toBe("string");
		expect(final.final).toMatch(/approve|saved/i);
		expect(final.tool).toBeUndefined();
	});

	it("every scripted tool call uses a real propose verb and required primary", () => {
		const verbs = new Set(["propose-contact", "propose-task", "propose-event"]);
		for (const line of DEMO_AGENT_SCRIPT.slice(0, -1)) {
			const call = JSON.parse(line);
			expect(verbs.has(call.tool)).toBe(true);
			// each carries its primary field so buildProposal accepts it
			expect(call.args.name ?? call.args.title).toBeTruthy();
		}
	});

	it("the provider returns the scripted content under the demo id, no cost", async () => {
		const p = createDemoAgentProvider();
		expect(p.id).toBe(DEMO_AGENT_PROVIDER_ID);
		const res = await p.generate({ messages: [sys, user] });
		expect(JSON.parse(res.content).tool).toBe("propose-contact");
		expect(res.provider).toBe(DEMO_AGENT_PROVIDER_ID);
		expect(res.usage?.totalTokens).toBe(0);
	});
});

describe("demo-agent-provider — the AppForge propose-code-file script", () => {
	it("mode selection: 'appforge' picks the code-file script, anything else the default", () => {
		expect(demoScriptForMode(DEMO_AGENT_APPFORGE_MODE)).toBe(DEMO_AGENT_APPFORGE_SCRIPT);
		expect(demoScriptForMode("1")).toBe(DEMO_AGENT_SCRIPT);
		expect(demoScriptForMode(undefined)).toBe(DEMO_AGENT_SCRIPT);
	});

	it("proposes manifest.json, then index.html, then finalizes without claiming a save", () => {
		const first = JSON.parse(nextDemoReply([sys, user], DEMO_AGENT_APPFORGE_SCRIPT));
		expect(first.tool).toBe("propose-code-file");
		expect(first.args.path).toBe("hello-app/manifest.json");
		const second = JSON.parse(nextDemoReply(transcriptWithAcks(1), DEMO_AGENT_APPFORGE_SCRIPT));
		expect(second.tool).toBe("propose-code-file");
		expect(second.args.path).toBe("hello-app/index.html");
		const final = JSON.parse(nextDemoReply(transcriptWithAcks(2), DEMO_AGENT_APPFORGE_SCRIPT));
		expect(typeof final.final).toBe("string");
		expect(final.final).toMatch(/approve/i);
		expect(final.tool).toBeUndefined();
	});

	it("each scripted call carries a stageable shape (path + string content, in-bounds)", () => {
		for (const line of DEMO_AGENT_APPFORGE_SCRIPT.slice(0, -1)) {
			const call = JSON.parse(line);
			expect(call.tool).toBe("propose-code-file");
			expect(typeof call.args.path).toBe("string");
			expect(call.args.path.length).toBeGreaterThan(0);
			expect(typeof call.args.content).toBe("string");
			expect(call.args.content.length).toBeLessThan(256 * 1024);
		}
	});

	it("the provider in appforge mode walks the code-file script and clamps at the final", async () => {
		const p = createDemoAgentProvider(DEMO_AGENT_APPFORGE_MODE);
		const res = await p.generate({ messages: [sys, user] });
		expect(JSON.parse(res.content).args.path).toBe("hello-app/manifest.json");
		const done = await p.generate({ messages: transcriptWithAcks(99) });
		expect(JSON.parse(done.content).final).toBeTruthy();
	});
});
