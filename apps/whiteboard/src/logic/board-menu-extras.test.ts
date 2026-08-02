import { describe, expect, it, vi } from "vitest";
import { boardMenuExtras } from "./board-menu-extras";

const labels = { rename: "Rename", changeIcon: "Change icon" };

describe("boardMenuExtras", () => {
	it("contributes rename + change-icon so the header ⋯ isn't just Open/Pin", () => {
		const items = boardMenuExtras({
			locked: false,
			labels,
			onRename: () => {},
			onChangeIcon: () => {},
		});
		expect(items.map((i) => i.id)).toEqual(["rename", "change-icon"]);
		for (const item of items) expect(item.icon).toBeTruthy();
	});

	it("offers nothing on a locked board — a read-only board has no mutating verb", () => {
		const items = boardMenuExtras({
			locked: true,
			labels,
			onRename: () => {},
			onChangeIcon: () => {},
		});
		expect(items).toEqual([]);
	});

	it("routes each row to its handler", () => {
		const onRename = vi.fn();
		const onChangeIcon = vi.fn();
		const items = boardMenuExtras({ locked: false, labels, onRename, onChangeIcon });
		items.find((i) => i.id === "rename")?.run();
		items.find((i) => i.id === "change-icon")?.run();
		expect(onRename).toHaveBeenCalledTimes(1);
		expect(onChangeIcon).toHaveBeenCalledTimes(1);
	});
});
