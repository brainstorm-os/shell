import { describe, expect, it } from "vitest";
import { agentDisplayName, authorshipMeta, createdByAgentOf } from "./entity-authorship";

const STAMP = { agent: "io.brainstorm.agent", conversationId: "c", createdAt: 1 };

describe("entity authorship (Agent-16 / Collab-C7)", () => {
	it("reads the creating agent from the derived key or the stamp", () => {
		expect(createdByAgentOf({ createdByAgent: "io.brainstorm.agent" })).toBe("io.brainstorm.agent");
		expect(createdByAgentOf({ agentProvenance: STAMP })).toBe("io.brainstorm.agent");
		expect(createdByAgentOf({ title: "x" })).toBeNull();
		expect(createdByAgentOf(null)).toBeNull();
	});

	it("names an agent: host name, then app-id segment, then a short fingerprint", () => {
		expect(agentDisplayName("io.brainstorm.agent", { "io.brainstorm.agent": "Scout" })).toBe("Scout");
		expect(agentDisplayName("io.brainstorm.agent")).toBe("Agent");
		expect(agentDisplayName("ed25519:0123456789abcdef")).toBe("ed25519:01234567…");
	});

	it("builds the panel rows, empty for a plain unshared object", () => {
		expect(authorshipMeta({ properties: { title: "x" } })).toEqual([]);
		expect(
			authorshipMeta({
				properties: { agentProvenance: STAMP },
				lastEdit: { name: "Mara", at: 5 },
				formatTime: () => "today",
			}),
		).toEqual([
			{ label: "Created by", value: "Agent", title: "io.brainstorm.agent" },
			{ label: "Last edited", value: "Mara · today" },
		]);
	});
});
