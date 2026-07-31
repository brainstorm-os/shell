/**
 * `Agent/v1` codec (Agent-Teams-1) — identity fails closed (a mangled pubkey /
 * fingerprint drops the record), traits degrade CONSERVATIVE (unknown routing
 * can never widen to cloud / autonomous), and prompt-bound strings are
 * control-stripped + clamped.
 */

import { describe, expect, it } from "vitest";
import {
	AGENT_PERSONA_MAX_LENGTH,
	AgentAutonomy,
	AgentMemoryScope,
	AgentRouting,
	AgentSkillKind,
	agentDefToEntityProperties,
	readAgentDef,
} from "./agent-def";

const IDENTITY = {
	pubkey: "AAAAC3NzaC1lZDI1NTE5AAAAIF5C+GRnlKOydN8ZDeJdCUUuHTo0zXC0hoOIWLNwiTst",
	fingerprint: "ed25519:0123456789abcdef",
};

function fullDef() {
	return {
		...IDENTITY,
		displayName: "Researcher",
		avatarRef: null,
		persona: "You research things.",
		skills: [{ kind: AgentSkillKind.Intent, ref: "propose-note" }],
		routing: AgentRouting.CloudAllowed,
		autonomy: AgentAutonomy.AutonomousWithinCaps,
		memoryScope: AgentMemoryScope.LongTerm,
	};
}

describe("agent-def codec", () => {
	it("round-trips a full definition (name persisted as the entity title key)", () => {
		const props = agentDefToEntityProperties(fullDef());
		expect(props.name).toBe("Researcher");
		expect(props).not.toHaveProperty("displayName");
		const back = readAgentDef(props);
		expect(back).toEqual(fullDef());
	});

	it("drops a record whose identity does not parse", () => {
		const props = agentDefToEntityProperties(fullDef());
		expect(readAgentDef({ ...props, pubkey: "" })).toBeNull();
		expect(readAgentDef({ ...props, pubkey: "not base64 !!" })).toBeNull();
		expect(readAgentDef({ ...props, fingerprint: "ed25519:XYZ" })).toBeNull();
		const { pubkey: _p, ...noPubkey } = props;
		expect(readAgentDef(noPubkey)).toBeNull();
	});

	it("degrades unknown trait values to the conservative floor, never wider", () => {
		const props = {
			...agentDefToEntityProperties(fullDef()),
			routing: "cloud-please",
			autonomy: 42,
			memoryScope: null,
		};
		const back = readAgentDef(props);
		expect(back?.routing).toBe(AgentRouting.LocalOnly);
		expect(back?.autonomy).toBe(AgentAutonomy.ConfirmOnWrite);
		expect(back?.memoryScope).toBe(AgentMemoryScope.PerConversation);
	});

	it("filters malformed skills and keeps well-formed ones", () => {
		const props = {
			...agentDefToEntityProperties(fullDef()),
			skills: [
				{ kind: AgentSkillKind.Workflow, ref: "wf_1" },
				{ kind: "exec", ref: "rm -rf" },
				{ kind: AgentSkillKind.Intent },
				"junk",
				null,
			],
		};
		expect(readAgentDef(props)?.skills).toEqual([{ kind: AgentSkillKind.Workflow, ref: "wf_1" }]);
	});

	it("strips control characters and clamps the persona", () => {
		const def = {
			...fullDef(),
			displayName: "Resea\u0007rcher\u001b[31m",
			persona: "x".repeat(AGENT_PERSONA_MAX_LENGTH + 100),
		};
		const props = agentDefToEntityProperties(def);
		expect(props.name).toBe("Researcher[31m");
		expect((props.persona as string).length).toBe(AGENT_PERSONA_MAX_LENGTH);
	});

	it("keeps newlines and tabs in persona prose", () => {
		const def = { ...fullDef(), persona: "Line one.\n\tIndented line two." };
		const props = agentDefToEntityProperties(def);
		expect(props.persona).toBe("Line one.\n\tIndented line two.");
	});
});
