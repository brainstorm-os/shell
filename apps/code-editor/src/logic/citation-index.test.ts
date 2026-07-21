import { OpenQuestionStatus, SelfHostingEntityType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { VaultEntity, VaultSnapshot } from "../runtime";
import { CitationKind, buildCitationIndex, lookupCitation, normalizeCode } from "./citation-index";

function entity(partial: Partial<VaultEntity> & Pick<VaultEntity, "id" | "type">): VaultEntity {
	return {
		properties: {},
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
		ownerAppId: "io.brainstorm.dev",
		...partial,
	};
}

function snapshot(entities: VaultEntity[]): VaultSnapshot {
	return { entities, links: [] };
}

describe("normalizeCode", () => {
	it("trims and upper-cases", () => {
		expect(normalizeCode(" oq-gr-1 ")).toBe("OQ-GR-1");
		expect(normalizeCode("9.14.1.5")).toBe("9.14.1.5");
	});
});

describe("buildCitationIndex", () => {
	it("indexes iterations and open questions by code", () => {
		const index = buildCitationIndex(
			snapshot([
				entity({
					id: "iter-9-14-1",
					type: SelfHostingEntityType.Iteration,
					properties: {
						code: "9.14.1",
						title: "Tasks scaffold",
						status: "done",
						summary: "Frozen contract",
					},
				}),
				entity({
					id: "oq-gr-1",
					type: SelfHostingEntityType.OpenQuestion,
					properties: {
						code: "OQ-GR-1",
						title: "Graph SQL compiler",
						status: OpenQuestionStatus.Resolved,
						resolution: "Live compiler landed at 9.13.3",
					},
				}),
			]),
		);
		expect(index.size).toBe(2);
		const iter = lookupCitation(index, "9.14.1");
		expect(iter).toMatchObject({
			kind: CitationKind.Iteration,
			code: "9.14.1",
			title: "Tasks scaffold",
			status: "done",
			summary: "Frozen contract",
		});
		const oq = lookupCitation(index, "oq-gr-1");
		expect(oq).toMatchObject({
			kind: CitationKind.OpenQuestion,
			code: "OQ-GR-1",
			summary: "Live compiler landed at 9.13.3",
		});
	});

	it("falls back an open question's gloss to its question when unresolved", () => {
		const index = buildCitationIndex(
			snapshot([
				entity({
					id: "oq-42",
					type: SelfHostingEntityType.OpenQuestion,
					properties: {
						code: "OQ-42",
						title: "Sync model",
						status: OpenQuestionStatus.Open,
						question: "CRDT vs OT?",
					},
				}),
			]),
		);
		expect(lookupCitation(index, "OQ-42")?.summary).toBe("CRDT vs OT?");
	});

	it("defaults a missing title to the code and an OQ status to open", () => {
		const index = buildCitationIndex(
			snapshot([
				entity({ id: "oq-1", type: SelfHostingEntityType.OpenQuestion, properties: { code: "OQ-1" } }),
			]),
		);
		expect(lookupCitation(index, "OQ-1")).toMatchObject({
			title: "OQ-1",
			status: OpenQuestionStatus.Open,
			summary: "",
		});
	});

	it("skips soft-deleted rows, rows with no code, and unrelated types", () => {
		const index = buildCitationIndex(
			snapshot([
				entity({
					id: "gone",
					type: SelfHostingEntityType.Iteration,
					properties: { code: "9.9.9" },
					deletedAt: 123,
				}),
				entity({ id: "nocode", type: SelfHostingEntityType.Iteration, properties: { title: "x" } }),
				entity({ id: "note", type: "brainstorm/CodeFile/v1", properties: { code: "9.1.1" } }),
			]),
		);
		expect(index.size).toBe(0);
	});

	it("keeps the most-recently-updated row when a code is claimed twice", () => {
		const index = buildCitationIndex(
			snapshot([
				entity({
					id: "stale",
					type: SelfHostingEntityType.Iteration,
					properties: { code: "9.1", title: "Old" },
					updatedAt: 100,
				}),
				entity({
					id: "fresh",
					type: SelfHostingEntityType.Iteration,
					properties: { code: "9.1", title: "New" },
					updatedAt: 200,
				}),
			]),
		);
		expect(lookupCitation(index, "9.1")?.title).toBe("New");
		expect(lookupCitation(index, "9.1")?.entityId).toBe("fresh");
	});

	it("is empty for a null/empty snapshot", () => {
		expect(buildCitationIndex(null).size).toBe(0);
		expect(buildCitationIndex({ entities: [], links: [] }).size).toBe(0);
	});
});
