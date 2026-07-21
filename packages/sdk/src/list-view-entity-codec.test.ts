/**
 * Tests for the ListView ⇄ `brainstorm/ListView/v1` entity codec (9.12.8).
 * Round-trip fidelity, defensive coercion of partial rows, and the two
 * hard invalidity gates (missing `listId`, unknown `kind`).
 */

import {
	EmptyPlacement,
	type Entity,
	type ListView,
	ListViewKind,
	SortDirection,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	LIST_VIEW_ENTITY_TYPE,
	entityToListView,
	listViewToEntityProperties,
} from "./list-view-entity-codec";

const FULL_VIEW: ListView = {
	id: "view_1",
	listId: "list_1",
	name: "Board",
	icon: null,
	kind: ListViewKind.Board,
	filters: null,
	sorts: [{ propertyId: "dueAt", direction: SortDirection.Asc, emptyPlacement: EmptyPlacement.End }],
	groupBy: { propertyId: "statusKey" },
	coverProperty: null,
	cardSubtitleProperty: "priority",
	columns: [{ propertyId: "name", width: 280, visible: true }],
	manualOrder: ["a", "b"],
	defaultTypeUrl: null,
	defaultTemplate: null,
	pageSize: 50,
	layoutOptions: { columnWidth: 320, collapseEmptyColumns: false, cardPreview: "rich" },
};

function entityFor(view: ListView): Entity {
	return {
		id: view.id,
		type: LIST_VIEW_ENTITY_TYPE,
		properties: listViewToEntityProperties(view) as unknown as Record<string, unknown>,
		createdBy: "io.brainstorm.database",
		createdAt: 1,
		updatedAt: 2,
	};
}

describe("listViewToEntityProperties / entityToListView", () => {
	it("round-trips a full view (id carried by the entity, not the bag)", () => {
		const props = listViewToEntityProperties(FULL_VIEW);
		expect("id" in props).toBe(false);
		const back = entityToListView(entityFor(FULL_VIEW));
		expect(back).toEqual(FULL_VIEW);
	});

	it("omits manualOrder from the bag when the view has none", () => {
		const { manualOrder: _drop, ...rest } = FULL_VIEW;
		const view: ListView = rest;
		const props = listViewToEntityProperties(view);
		expect("manualOrder" in props).toBe(false);
		const back = entityToListView(entityFor(view));
		expect(back).toEqual(view);
		expect(back && "manualOrder" in back).toBe(false);
	});

	it("returns null for a non-ListView entity type", () => {
		const entity = { ...entityFor(FULL_VIEW), type: "brainstorm/List/v1" };
		expect(entityToListView(entity)).toBeNull();
	});

	it("returns null when listId is missing (a view must belong to a List)", () => {
		const entity = entityFor(FULL_VIEW);
		const { listId: _dropped, ...withoutListId } = entity.properties as Record<string, unknown>;
		expect(entityToListView({ ...entity, properties: withoutListId })).toBeNull();
	});

	it("returns null for an unknown kind (cannot render)", () => {
		const entity = entityFor(FULL_VIEW);
		(entity.properties as Record<string, unknown>).kind = "kanban-3d";
		expect(entityToListView(entity)).toBeNull();
	});

	it("coerces a sparse row to safe defaults", () => {
		const entity: Entity = {
			id: "view_sparse",
			type: LIST_VIEW_ENTITY_TYPE,
			properties: { listId: "list_1", kind: ListViewKind.Grid },
			createdBy: "io.brainstorm.database",
			createdAt: 1,
			updatedAt: 2,
		};
		const view = entityToListView(entity);
		expect(view).not.toBeNull();
		expect(view?.name).toBe("");
		expect(view?.sorts).toEqual([]);
		expect(view?.columns).toEqual([]);
		expect(view?.filters).toBeNull();
		expect(view?.groupBy).toBeNull();
		expect(view?.pageSize).toBe(50);
		expect(view?.layoutOptions).toEqual({});
	});

	it("drops malformed array members and a legacy array filters shape", () => {
		const entity: Entity = {
			id: "view_messy",
			type: LIST_VIEW_ENTITY_TYPE,
			properties: {
				listId: "list_1",
				kind: ListViewKind.List,
				sorts: [null, "x", { propertyId: "name" }],
				columns: [42, { propertyId: "name", width: 100, visible: true }],
				manualOrder: ["a", 7, "b"],
				filters: [],
			},
			createdBy: "io.brainstorm.database",
			createdAt: 1,
			updatedAt: 2,
		};
		const view = entityToListView(entity);
		expect(view?.sorts).toEqual([{ propertyId: "name" }]);
		expect(view?.columns).toEqual([{ propertyId: "name", width: 100, visible: true }]);
		expect(view?.manualOrder).toEqual(["a", "b"]);
		expect(view?.filters).toBeNull();
	});
});
