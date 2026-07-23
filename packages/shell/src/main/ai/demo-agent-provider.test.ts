import { type AiChatMessage, MessageRole } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DEMO_AGENT_PROVIDER_ID,
	DEMO_AGENT_SCRIPT,
	createDemoAgentProvider,
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
