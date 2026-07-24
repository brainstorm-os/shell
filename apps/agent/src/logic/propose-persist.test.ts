import { GENERIC_OBJECT_TYPE, MEMBERS_HARD_CAP, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { ProposeKind, type ProposedArtifact, buildProposal } from "./propose-artifacts";
import {
	memberPinPatch,
	persistApprovedProposal,
	proposalToEntityProperties,
} from "./propose-persist";

const NOW = 1_700_000_000_000;

function stage(verb: string, args: Record<string, unknown>): ProposedArtifact {
	const r = buildProposal({ verb, args, id: "p1" });
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.artifact;
}

describe("proposalToEntityProperties — schema-aware coercion", () => {
	it("maps a note to title + plain body + synthesized timestamps", () => {
		const plan = proposalToEntityProperties(
			stage("propose-note", { title: "Ideas", body: "- one\n- two" }),
			NOW,
		);
		expect(plan.entityType).toBe("io.brainstorm.notes/Note/v1");
		expect(plan.properties).toEqual({
			title: "Ideas",
			body: "- one\n- two",
			values: {},
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("renames a task's title→name, parses dueDate→dueAt(ms), and defaults status", () => {
		const plan = proposalToEntityProperties(
			stage("propose-task", { title: "Ship release", notes: "cut the tag", dueDate: "2026-08-01" }),
			NOW,
		);
		expect(plan.entityType).toBe("brainstorm/Task/v1");
		expect(plan.properties.name).toBe("Ship release");
		expect(plan.properties.notes).toBe("cut the tag");
		expect(plan.properties.dueAt).toBe(Date.parse("2026-08-01"));
		expect(plan.properties.statusKey).toBeNull();
		expect(plan.properties.priority).toBe("none");
		expect(plan.properties.createdAt).toBe(NOW);
	});

	it("leaves dueAt null when the model's date is unparseable (never a bogus timestamp)", () => {
		const plan = proposalToEntityProperties(
			stage("propose-task", { title: "Someday", dueDate: "next week-ish" }),
			NOW,
		);
		expect(plan.properties.dueAt).toBeNull();
	});

	it("maps an event: notes→description, start parsed, allDay synthesized, end null when absent", () => {
		const plan = proposalToEntityProperties(
			stage("propose-event", { title: "Sync", start: "2026-08-02T15:00:00Z", notes: "weekly" }),
			NOW,
		);
		expect(plan.entityType).toBe("brainstorm/Event/v1");
		expect(plan.properties.title).toBe("Sync");
		expect(plan.properties.description).toBe("weekly");
		expect(plan.properties.start).toBe(Date.parse("2026-08-02T15:00:00Z"));
		expect(plan.properties.end).toBeNull();
		expect(plan.properties.allDay).toBe(false);
		expect("location" in plan.properties).toBe(false);
	});

	it("degrades an event with an unparseable start to `now` (schema requires start)", () => {
		const plan = proposalToEntityProperties(
			stage("propose-event", { title: "Someday sync", start: "whenever" }),
			NOW,
		);
		expect(plan.properties.start).toBe(NOW);
	});

	it("maps a bookmark: note→notes, synthesizes tags[]/savedAt/timestamps", () => {
		const plan = proposalToEntityProperties(
			stage("propose-bookmark", { url: "https://x.dev", title: "X", note: "read later" }),
			NOW,
		);
		expect(plan.entityType).toBe("brainstorm/Bookmark/v1");
		expect(plan.properties).toEqual({
			url: "https://x.dev",
			title: "X",
			notes: "read later",
			tags: [],
			savedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("maps a contact: notes→bio, only supplied optionals present, no timestamps", () => {
		const plan = proposalToEntityProperties(
			stage("propose-contact", { name: "Mira", email: "mira@northbound.co", notes: "lead" }),
			NOW,
		);
		expect(plan.entityType).toBe("brainstorm/Person/v1");
		expect(plan.properties).toEqual({
			name: "Mira",
			email: "mira@northbound.co",
			bio: "lead",
		});
		expect("phone" in plan.properties).toBe(false);
		expect("createdAt" in plan.properties).toBe(false);
	});

	it("every fixed-schema kind produces its canonical owner-app type", () => {
		// A Row's type is the target database's, not a build-time constant — it is
		// covered by the database-row cases below.
		const byKind: Record<
			Exclude<ProposeKind, typeof ProposeKind.Row | typeof ProposeKind.Database>,
			string
		> = {
			[ProposeKind.Note]: "io.brainstorm.notes/Note/v1",
			[ProposeKind.Task]: "brainstorm/Task/v1",
			[ProposeKind.Event]: "brainstorm/Event/v1",
			[ProposeKind.Bookmark]: "brainstorm/Bookmark/v1",
			[ProposeKind.Contact]: "brainstorm/Person/v1",
		};
		for (const [verb, primary] of [
			["propose-note", { title: "n" }],
			["propose-task", { title: "t" }],
			["propose-event", { title: "e", start: "2026-01-01" }],
			["propose-bookmark", { url: "https://a.b", title: "b" }],
			["propose-contact", { name: "c" }],
		] as const) {
			const artifact = stage(verb, primary);
			const plan = proposalToEntityProperties(artifact, NOW);
			expect(plan.entityType).toBe(
				byKind[
					artifact.kind as Exclude<ProposeKind, typeof ProposeKind.Row | typeof ProposeKind.Database>
				],
			);
		}
	});
});

describe("proposalToEntityProperties — database rows (Agent-11d)", () => {
	const rowArtifact = (fields: Record<string, string>): ProposedArtifact => ({
		id: "p-row",
		kind: ProposeKind.Row,
		entityType: GENERIC_OBJECT_TYPE,
		fields,
		summary: fields.name ?? "",
		row: {
			databaseId: "list_crm",
			databaseName: "Pipeline",
			addToMembers: true,
			columns: [
				{ key: "name", label: "Name", valueType: ValueType.Text },
				{ key: "amount", label: "Amount", valueType: ValueType.Number },
				{ key: "closed", label: "Closed", valueType: ValueType.Boolean },
				{ key: "signedAt", label: "Signed at", valueType: ValueType.Date },
			],
		},
	});

	it("coerces each cell to its column's type and stamps the timestamps", () => {
		const plan = proposalToEntityProperties(
			rowArtifact({ name: "Globex", amount: "5400", closed: "yes", signedAt: "2026-08-01" }),
			NOW,
		);
		expect(plan.entityType).toBe(GENERIC_OBJECT_TYPE);
		expect(plan.properties).toEqual({
			name: "Globex",
			amount: 5400,
			closed: true,
			signedAt: Date.parse("2026-08-01"),
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("omits a cell whose value can't be coerced (an empty cell, never a wrong one)", () => {
		const plan = proposalToEntityProperties(
			rowArtifact({ name: "Initech", amount: "a lot", signedAt: "soon" }),
			NOW,
		);
		expect(plan.properties.amount).toBeUndefined();
		expect(plan.properties.signedAt).toBeUndefined();
		expect(plan.properties.name).toBe("Initech");
	});

	it("writes ONLY the target database's columns — never a key the model invented", () => {
		const artifact = rowArtifact({ name: "Acme" });
		artifact.fields.ownerAppId = "io.brainstorm.evil";
		const plan = proposalToEntityProperties(artifact, NOW);
		expect(plan.properties.ownerAppId).toBeUndefined();
	});
});

describe("memberPinPatch (Agent-11d — manual collections)", () => {
	it("appends exactly one include entry, preserving the existing overrides", () => {
		const patch = memberPinPatch(
			{ include: [{ entityId: "ent_a", addedAt: 1, by: "user" }], exclude: [] },
			"ent_new",
			NOW,
		);
		expect(patch?.members.include).toEqual([
			{ entityId: "ent_a", addedAt: 1, by: "user" },
			{ entityId: "ent_new", addedAt: NOW, by: "app:io.brainstorm.agent" },
		]);
	});

	it("is a no-op when the row is already a member", () => {
		expect(
			memberPinPatch(
				{ include: [{ entityId: "ent_a", addedAt: 1, by: "user" }], exclude: [] },
				"ent_a",
				NOW,
			),
		).toBeNull();
	});

	it("refuses to grow a collection past the hard cap", () => {
		const include = Array.from({ length: MEMBERS_HARD_CAP }, (_, i) => ({
			entityId: `ent_${i}`,
			addedAt: 1,
			by: "user" as const,
		}));
		expect(memberPinPatch({ include, exclude: [] }, "ent_new", NOW)).toBeNull();
	});

	it("handles a collection with no members block yet", () => {
		expect(memberPinPatch(undefined, "ent_new", NOW)?.members.include).toHaveLength(1);
	});
});

describe("persistApprovedProposal (the approve gesture's write path)", () => {
	const rowArtifact = (addToMembers: boolean): ProposedArtifact => ({
		id: "p-row",
		kind: ProposeKind.Row,
		entityType: addToMembers ? GENERIC_OBJECT_TYPE : "brainstorm/Task/v1",
		fields: { name: "Globex", amount: "5400" },
		summary: "Globex",
		row: {
			databaseId: "list_crm",
			databaseName: "Pipeline",
			addToMembers,
			columns: [
				{ key: "name", label: "Name", valueType: ValueType.Text },
				{ key: "amount", label: "Amount", valueType: ValueType.Number },
			],
		},
	});

	function stubEntities() {
		const create = vi.fn(async () => ({ id: "ent_new" }));
		const update = vi.fn(async () => undefined);
		return { create, update };
	}

	it("creates the row with coerced values and the conversation as provenance", async () => {
		const entities = stubEntities();
		await persistApprovedProposal(entities, rowArtifact(false), {
			conversationId: "conv_1",
			now: NOW,
		});
		expect(entities.create).toHaveBeenCalledWith(
			"brainstorm/Task/v1",
			expect.objectContaining({ name: "Globex", amount: 5400 }),
			undefined,
			{ conversationId: "conv_1" },
		);
	});

	it("pins the created row into a manual collection's members", async () => {
		const entities = stubEntities();
		await persistApprovedProposal(entities, rowArtifact(true), {
			conversationId: "conv_1",
			collectionMembers: { include: [{ entityId: "ent_a", addedAt: 1, by: "user" }], exclude: [] },
			now: NOW,
		});
		expect(entities.update).toHaveBeenCalledWith("list_crm", {
			members: {
				include: [
					{ entityId: "ent_a", addedAt: 1, by: "user" },
					{ entityId: "ent_new", addedAt: NOW, by: "app:io.brainstorm.agent" },
				],
				exclude: [],
			},
		});
	});

	it("never touches membership for a typed database (the source picks the row up)", async () => {
		const entities = stubEntities();
		await persistApprovedProposal(entities, rowArtifact(false), {
			conversationId: "conv_1",
			now: NOW,
		});
		expect(entities.update).not.toHaveBeenCalled();
	});

	it("omits provenance when there is no active conversation", async () => {
		const entities = stubEntities();
		await persistApprovedProposal(entities, stage("propose-note", { title: "Solo" }), {
			conversationId: null,
			now: NOW,
		});
		expect(entities.create).toHaveBeenCalledWith(
			"io.brainstorm.notes/Note/v1",
			expect.objectContaining({ title: "Solo" }),
			undefined,
			undefined,
		);
	});
});

describe("proposalToEntityProperties — the database guard", () => {
	it("refuses to map a new-database proposal (its persist path is multi-entity)", () => {
		expect(() =>
			proposalToEntityProperties(
				{
					id: "d1",
					kind: ProposeKind.Database,
					entityType: "brainstorm/List/v1",
					fields: { name: "CRM" },
					summary: "CRM",
					database: { columns: [], rowCount: 0 },
				},
				NOW,
			),
		).toThrow(/persistProposedDatabase/);
	});
});
