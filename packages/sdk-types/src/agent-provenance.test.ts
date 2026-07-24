import { describe, expect, it } from "vitest";
import {
	AGENT_PROVENANCE_PROPERTY_KEY,
	buildAgentProvenance,
	parseProvenanceRequest,
	readAgentProvenance,
	stripAgentProvenance,
} from "./agent-provenance";

describe("agent-provenance", () => {
	describe("parseProvenanceRequest", () => {
		it("accepts a well-formed conversation id, trimming whitespace", () => {
			expect(parseProvenanceRequest({ conversationId: "  ent_conv_1 " })).toEqual({
				conversationId: "ent_conv_1",
			});
		});

		it("fails closed on non-objects, missing/blank/oversized ids", () => {
			expect(parseProvenanceRequest(null)).toBeNull();
			expect(parseProvenanceRequest("ent_conv_1")).toBeNull();
			expect(parseProvenanceRequest({})).toBeNull();
			expect(parseProvenanceRequest({ conversationId: 42 })).toBeNull();
			expect(parseProvenanceRequest({ conversationId: "   " })).toBeNull();
			expect(parseProvenanceRequest({ conversationId: "x".repeat(257) })).toBeNull();
		});
	});

	describe("buildAgentProvenance / readAgentProvenance round-trip", () => {
		it("stamps and reads back agent + conversation + createdAt", () => {
			const stamp = buildAgentProvenance("io.brainstorm.agent", "ent_conv_1", 1000);
			expect(stamp).toEqual({
				agent: "io.brainstorm.agent",
				conversationId: "ent_conv_1",
				createdAt: 1000,
			});
			const props = { title: "N", [AGENT_PROVENANCE_PROPERTY_KEY]: stamp };
			expect(readAgentProvenance(props)).toEqual(stamp);
		});

		it("reads null from missing / malformed stamps", () => {
			expect(readAgentProvenance(null)).toBeNull();
			expect(readAgentProvenance({})).toBeNull();
			expect(readAgentProvenance({ [AGENT_PROVENANCE_PROPERTY_KEY]: "nope" })).toBeNull();
			expect(
				readAgentProvenance({
					[AGENT_PROVENANCE_PROPERTY_KEY]: { agent: "", conversationId: "c", createdAt: 1 },
				}),
			).toBeNull();
			expect(
				readAgentProvenance({ [AGENT_PROVENANCE_PROPERTY_KEY]: { agent: "a", conversationId: "c" } }),
			).toBeNull();
			expect(
				readAgentProvenance({
					[AGENT_PROVENANCE_PROPERTY_KEY]: { agent: "a", conversationId: "c", createdAt: Number.NaN },
				}),
			).toBeNull();
		});
	});

	describe("stripAgentProvenance", () => {
		it("drops a caller-supplied provenance key (forge prevention)", () => {
			const forged = {
				title: "N",
				[AGENT_PROVENANCE_PROPERTY_KEY]: { agent: "io.evil.app", conversationId: "c", createdAt: 1 },
			};
			const stripped = stripAgentProvenance(forged);
			expect(AGENT_PROVENANCE_PROPERTY_KEY in stripped).toBe(false);
			expect(stripped).toEqual({ title: "N" });
		});

		it("returns the same reference when the key is absent", () => {
			const props = { title: "N" };
			expect(stripAgentProvenance(props)).toBe(props);
		});
	});
});
