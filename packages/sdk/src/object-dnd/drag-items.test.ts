import type { ObjectDragItem } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { dragItemsForSelection } from "./drag-items";

type Row = { id: string; label: string };
const a: Row = { id: "a", label: "A" };
const b: Row = { id: "b", label: "B" };
const c: Row = { id: "c", label: "C" };
const rows: Row[] = [a, b, c];
const toItem = (r: Row): ObjectDragItem => ({ entityId: r.id, entityType: "T", label: r.label });
const ids = (items: ObjectDragItem[]) => items.map((i) => i.entityId);

describe("dragItemsForSelection", () => {
	it("carries only the dragged item when it is not in the selection", () => {
		expect(ids(dragItemsForSelection(a, new Set(["b", "c"]), rows, (r) => r.id, toItem))).toEqual([
			"a",
		]);
	});

	it("carries the whole selection in list order when the dragged item is selected", () => {
		expect(ids(dragItemsForSelection(c, new Set(["c", "a"]), rows, (r) => r.id, toItem))).toEqual([
			"a",
			"c",
		]);
	});

	it("carries just the dragged item for a single-selection drag", () => {
		expect(ids(dragItemsForSelection(b, new Set(["b"]), rows, (r) => r.id, toItem))).toEqual(["b"]);
	});
});
