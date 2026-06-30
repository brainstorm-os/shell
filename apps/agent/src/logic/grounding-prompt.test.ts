import { describe, expect, it } from "vitest";
import { AGENT_GROUNDING_GUIDANCE, AGENT_SYSTEM_PROMPT } from "./transcript";
import { AGENT_TOOL_SYSTEM_PROMPT } from "./turn";

describe("agent grounding guard", () => {
	it("ships the anti-fabrication contract on both the plain-chat and tool prompts", () => {
		// One source, two consumers: if either prompt drops the clause the agent
		// can hallucinate vault content again (the F-372 regression).
		expect(AGENT_SYSTEM_PROMPT).toContain(AGENT_GROUNDING_GUIDANCE);
		expect(AGENT_TOOL_SYSTEM_PROMPT).toContain(AGENT_GROUNDING_GUIDANCE);
	});

	it("instructs the model to refuse rather than invent unknown specifics", () => {
		const lower = AGENT_GROUNDING_GUIDANCE.toLowerCase();
		expect(lower).toContain("never invent");
		expect(lower).toContain("don't have it");
	});
});
