import { LIST_ENTITY_TYPE, LIST_VIEW_ENTITY_TYPE } from "@brainstorm-os/sdk";
import { GENERIC_OBJECT_TYPE, ListViewKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { PROPOSE_DATABASE_VERB, buildDatabaseProposal } from "./propose-database";
import { persistProposedDatabase } from "./propose-database-persist";

const NOW = 1_700_000_000_000;

function stage(args: Record<string, unknown>) {
	const r = buildDatabaseProposal({ verb: PROPOSE_DATABASE_VERB, args, id: "d1", existing: [] });
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.artifact;
}

function stubEntities() {
	let n = 0;
	const create = vi.fn(
		async (
			_type: string,
			_properties: Record<string, unknown>,
			_id?: string,
			_provenance?: { conversationId: string },
		) => {
			n += 1;
			return { id: `ent_${n}` };
		},
	);
	return {
		create,
		update: vi.fn(async (_id: string, _patch: Record<string, unknown>) => undefined),
	};
}

const READING_LIST = {
	name: "Reading list",
	columns: [
		{ name: "Author", type: "text" },
		{ name: "Pages", type: "number" },
	],
	rows: [
		{ Name: "Dune", Author: "Herbert", Pages: "412" },
		{ Name: "Solaris", Author: "Lem", Pages: "204" },
	],
};

describe("persistProposedDatabase (Agent-11e)", () => {
	it("creates one row entity per seed row, with cells coerced to column types", async () => {
		const entities = stubEntities();
		await persistProposedDatabase(entities, stage(READING_LIST), {
			conversationId: "conv_1",
			now: NOW,
		});
		const rowCreates = entities.create.mock.calls.filter((c) => c[0] === GENERIC_OBJECT_TYPE);
		expect(rowCreates).toHaveLength(2);
		expect(rowCreates[0]?.[1]).toMatchObject({ name: "Dune", author: "Herbert", pages: 412 });
		expect(rowCreates[1]?.[1]).toMatchObject({ name: "Solaris", author: "Lem", pages: 204 });
	});

	it("creates the Grid view with one column spec per proposed column", async () => {
		const entities = stubEntities();
		await persistProposedDatabase(entities, stage(READING_LIST), {
			conversationId: "conv_1",
			now: NOW,
		});
		const viewCall = entities.create.mock.calls.find((c) => c[0] === LIST_VIEW_ENTITY_TYPE);
		expect(viewCall?.[1]).toMatchObject({ kind: ListViewKind.Grid });
		expect(
			(viewCall?.[1] as { columns: { propertyId: string }[] }).columns.map((c) => c.propertyId),
		).toEqual(["name", "author", "pages"]);
	});

	it("creates the Collection LAST, already pointing at its view and its rows", async () => {
		const entities = stubEntities();
		const result = await persistProposedDatabase(entities, stage(READING_LIST), {
			conversationId: "conv_1",
			now: NOW,
		});
		const kinds = entities.create.mock.calls.map((c) => c[0]);
		expect(kinds[kinds.length - 1]).toBe(LIST_ENTITY_TYPE);

		const listCall = entities.create.mock.calls.find((c) => c[0] === LIST_ENTITY_TYPE);
		const props = listCall?.[1] as {
			name: string;
			views: string[];
			defaultViewId: string;
			members: { include: { entityId: string }[] };
		};
		expect(props.name).toBe("Reading list");
		expect(props.views).toEqual([result?.viewId]);
		expect(props.defaultViewId).toBe(result?.viewId);
		expect(props.members.include.map((m) => m.entityId)).toEqual(["ent_1", "ent_2"]);
		// No second write to fix up membership — the Collection lands complete.
		expect(entities.update).not.toHaveBeenCalled();
	});

	it("stamps every created entity with the source conversation (provenance)", async () => {
		const entities = stubEntities();
		await persistProposedDatabase(entities, stage(READING_LIST), {
			conversationId: "conv_1",
			now: NOW,
		});
		for (const call of entities.create.mock.calls) {
			expect(call[3]).toEqual({ conversationId: "conv_1" });
		}
	});

	it("creates an empty database when the proposal seeded no rows", async () => {
		const entities = stubEntities();
		await persistProposedDatabase(entities, stage({ name: "Empty", columns: ["Stage"] }), {
			conversationId: null,
			now: NOW,
		});
		expect(entities.create.mock.calls.filter((c) => c[0] === GENERIC_OBJECT_TYPE)).toHaveLength(0);
		const listCall = entities.create.mock.calls.find((c) => c[0] === LIST_ENTITY_TYPE);
		expect((listCall?.[1] as { members: { include: unknown[] } }).members.include).toEqual([]);
	});

	it("skips a row the service failed to mint an id for, and still lands the database", async () => {
		const entities = stubEntities();
		entities.create.mockImplementationOnce(async () => null as unknown as { id: string });
		const result = await persistProposedDatabase(entities, stage(READING_LIST), {
			conversationId: null,
			now: NOW,
		});
		const listCall = entities.create.mock.calls.find((c) => c[0] === LIST_ENTITY_TYPE);
		expect(
			(listCall?.[1] as { members: { include: { entityId: string }[] } }).members.include,
		).toHaveLength(1);
		expect(result?.listId).toBeTruthy();
	});

	it("mints distinct list + view ids that reference each other", async () => {
		const entities = stubEntities();
		const result = await persistProposedDatabase(entities, stage({ name: "X" }), {
			conversationId: null,
			now: NOW,
		});
		const viewCall = entities.create.mock.calls.find((c) => c[0] === LIST_VIEW_ENTITY_TYPE);
		expect(result?.listId).not.toBe(result?.viewId);
		expect((viewCall?.[1] as { listId: string }).listId).toBe(result?.listId);
		expect(viewCall?.[2]).toBe(result?.viewId);
	});
});
