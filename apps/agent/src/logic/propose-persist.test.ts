import {
	GENERIC_OBJECT_TYPE,
	MEMBERS_HARD_CAP,
	ProposeKind,
	type ProposedArtifact,
	ValueType,
	buildProposal,
	proposalToEntityProperties,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { buildCodeFileProposal } from "./propose-code-file";
import { memberPinPatch, persistApprovedProposal } from "./propose-persist";

const NOW = 1_700_000_000_000;

function stage(verb: string, args: Record<string, unknown>): ProposedArtifact {
	const r = buildProposal({ verb, args, id: "p1" });
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.artifact;
}

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

describe("proposalToEntityProperties — code files (AppForge-3)", () => {
	const codeArtifact = (content: string): ProposedArtifact => {
		const r = buildCodeFileProposal({
			verb: "propose-code-file",
			args: { path: "hello-app/index.html", language: "html", content },
			id: "p-code",
		});
		if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
		return r.artifact;
	};

	it("mirrors the Code editor's own new-file shape: path + content + language", () => {
		const plan = proposalToEntityProperties(codeArtifact("<h1>hi</h1>\n"), NOW);
		expect(plan.entityType).toBe("brainstorm/CodeFile/v1");
		expect(plan.properties).toEqual({
			path: "hello-app/index.html",
			content: "<h1>hi</h1>\n",
			language: "html",
			sizeBytes: 12,
			lineCount: 2,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	it("derives byte-accurate sizeBytes for multi-byte content; empty = 0 lines", () => {
		const plan = proposalToEntityProperties(codeArtifact("é"), NOW);
		expect(plan.properties.sizeBytes).toBe(2);
		expect(plan.properties.lineCount).toBe(1);
		const empty = proposalToEntityProperties(codeArtifact(""), NOW);
		expect(empty.properties.sizeBytes).toBe(0);
		expect(empty.properties.lineCount).toBe(0);
	});

	it("approve = EXACTLY ONE entities.create, provenance-stamped, no membership patch", async () => {
		const create = vi.fn(async () => ({ id: "ent_code" }));
		const update = vi.fn(async () => undefined);
		await persistApprovedProposal({ create, update }, codeArtifact("body {}"), {
			conversationId: "conv_1",
			now: NOW,
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith(
			"brainstorm/CodeFile/v1",
			expect.objectContaining({ path: "hello-app/index.html", content: "body {}" }),
			undefined,
			{ conversationId: "conv_1" },
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("injection-shaped content persists as plain data, untouched", async () => {
		const payload = "<script>alert(1)</script><img src=x onerror=x>";
		const plan = proposalToEntityProperties(codeArtifact(payload), NOW);
		expect(plan.properties.content).toBe(payload);
	});
});
