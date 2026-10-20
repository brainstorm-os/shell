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
			if (message === "getEntity") return manual;
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
		expect(graph.mock.calls.map((c) => c[0])).toEqual(["createEntity", "getEntity", "updateEntity"]);
		const update = graph.mock.calls[2];
		const members = (update?.[1] as { properties: { members: { include: { entityId: string }[] } } })
			.properties.members;
		expect(members.include.map((m) => m.entityId)).toEqual(["new_1"]);
	});

	it("refuses to create into a locked List — no row, no members write", async () => {
		const locked = list({ source: null, members: { include: [], exclude: [] }, locked: true });
		const graph = vi.fn(async () => ({}));
		await expect(createEmbeddedRow(graph as never, locked, VIEW, null)).rejects.toThrow();
		expect(graph).not.toHaveBeenCalled();
	});

	it("leaves the new row unpinned when the List locked between create and the members write", async () => {
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
			if (message === "getEntity") return list({ ...manual.properties, locked: true });
			return {};
		});
		await expect(createEmbeddedRow(graph as never, manual, VIEW, null)).rejects.toThrow(/new_1/);
		expect(graph.mock.calls.map((c) => c[0])).toEqual(["createEntity", "getEntity"]);
	});

	it("refuses the members write when the List cannot be re-read (fail closed)", async () => {
		const manual = list({ source: null, members: { include: [], exclude: [] } });
		const graph = vi.fn(async (message: string) => {
			if (message === "createEntity") {
				return { entityId: "new_2", entityTypeId: "x", properties: {}, updatedAt: 0 };
			}
			throw new Error("graph down");
		});
		await expect(createEmbeddedRow(graph as never, manual, VIEW, null)).rejects.toThrow(/new_2/);
		expect(graph.mock.calls.map((c) => c[0])).toEqual(["createEntity", "getEntity"]);
	});
});
