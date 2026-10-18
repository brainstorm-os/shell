import {
	FilterNodeKind,
	GENERIC_OBJECT_TYPE,
	type ListView,
	ListViewKind,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedRow, planEmbeddedRow } from "./create-row";
import type { BpEntity } from "./resolve-rows";

const VIEW: ListView = {
	id: "v1",
	listId: "l1",
	name: "By author",
	icon: null,
	kind: ListViewKind.Grid,
	filters: {
		kind: FilterNodeKind.Predicate,
		predicate: { $contains: { authors: { $host: true } } },
	},
	sorts: [],
	groupBy: null,
	coverProperty: null,
	cardSubtitleProperty: null,
	columns: [],
	defaultTypeUrl: null,
	defaultTemplate: null,
	pageSize: 50,
	layoutOptions: { rowHeight: "comfortable", showRowNumbers: false, pinFirstColumn: false },
};

function list(properties: Record<string, unknown>): BpEntity {
	return { entityId: "l1", entityTypeId: "brainstorm/List/v1", properties, updatedAt: 0 };
}

describe("embedded block New (9.12.24 follow-up)", () => {
	it("pre-fills the host relation and types the row from the source", () => {
		const typed = list({ source: { kind: "byType", types: ["io.test/Book/v1"] } });
		expect(planEmbeddedRow(typed, VIEW, "page_1")).toEqual({
			entityTypeId: "io.test/Book/v1",
			properties: { authors: ["page_1"] },
			addToMembers: false,
		});
	});

	it("creates a generic object in a manual collection and pins it into members", async () => {
		const manual = list({ source: null, members: { include: [], exclude: [] } });
		const graph = vi.fn(async (message: string, data: unknown) => {
			if (message === "createEntity") {
				const d = data as { entityTypeId: string; properties: Record<string, unknown> };
				return {
					entityId: "new_1",
					entityTypeId: d.entityTypeId,
					properties: d.properties,
					updatedAt: 0,
				};
			}
			return {};
		});
		const created = await createEmbeddedRow(
			graph as unknown as Parameters<typeof createEmbeddedRow>[0],
			manual,
			VIEW,
			"page_1",
		);
		expect(created.entityId).toBe("new_1");
		expect(graph).toHaveBeenNthCalledWith(1, "createEntity", {
			entityTypeId: GENERIC_OBJECT_TYPE,
			properties: { authors: ["page_1"] },
		});
		const update = graph.mock.calls[1];
		expect(update?.[0]).toBe("updateEntity");
		const members = (update?.[1] as { properties: { members: { include: { entityId: string }[] } } })
			.properties.members;
		expect(members.include.map((m) => m.entityId)).toEqual(["new_1"]);
	});
});
