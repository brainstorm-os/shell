/**
 * Agent teams wire-type pins (Agent-Teams-1) — the `Agent/v1` member shape +
 * its trait enums. Types-only module: these tests lock the string wire values
 * (never renumber) and prove a well-formed `AgentDef` typechecks. Per doc 69.
 */

import { describe, expect, it } from "vitest";
import {
	AGENT_TYPE,
	AgentAutonomy,
	type AgentDef,
	AgentMemoryScope,
	AgentRouting,
	AgentSkillKind,
	RosterMemberKind,
} from "./index";

describe("Agent/v1 wire types", () => {
	it("pins the type id and trait enum wire values", () => {
		expect(AGENT_TYPE).toBe("brainstorm/Agent/v1");
		expect(AgentRouting.LocalOnly).toBe("local-only");
		expect(AgentRouting.CloudAllowed).toBe("cloud-allowed");
		expect(AgentAutonomy.ConfirmOnWrite).toBe("confirm-on-write");
		expect(AgentAutonomy.AutonomousWithinCaps).toBe("autonomous-within-caps");
		expect(AgentMemoryScope.PerConversation).toBe("per-conversation");
		expect(AgentMemoryScope.LongTerm).toBe("long-term");
		expect(AgentSkillKind.Intent).toBe("intent");
		expect(AgentSkillKind.Workflow).toBe("workflow");
		expect(RosterMemberKind.Human).toBe("human");
		expect(RosterMemberKind.Agent).toBe("agent");
	});

	it("accepts a well-formed AgentDef", () => {
		const agent: AgentDef = {
			pubkey: "cHVia2V5",
			fingerprint: "ed25519:abcd1234",
			displayName: "Researcher",
			avatarRef: null,
			persona: "You research leads and draft briefs.",
			skills: [{ kind: AgentSkillKind.Intent, ref: "propose-note" }],
			routing: AgentRouting.LocalOnly,
			autonomy: AgentAutonomy.ConfirmOnWrite,
			memoryScope: AgentMemoryScope.PerConversation,
		};
		expect(agent.skills[0]?.kind).toBe(AgentSkillKind.Intent);
		expect(agent.avatarRef).toBeNull();
	});
});
