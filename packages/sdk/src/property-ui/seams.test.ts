/**
 * The property-ui seam DEFAULTS — these stand in whenever a host
 * (Notes) doesn't override them, so a bare cell render / a non-Notes
 * consumer / a unit test gets a working surface with zero Notes deps.
 * They are the contract: cover them directly.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_DICTIONARY_EDITOR_MATCHERS,
	DEFAULT_PROPERTY_UI_LABELS,
	EMPTY_ENTITY_TITLE_SOURCE,
	defaultCommitMatcher,
	defaultEscapeMatcher,
} from "./seams";

describe("default labels", () => {
	it("matches the English strings Notes shipped pre-VP-7", () => {
		const l = DEFAULT_PROPERTY_UI_LABELS;
		expect(l.cellEmpty).toBe("");
		expect(l.cellEditValueFor("Status")).toBe("Edit value for Status");
		expect(l.cellToggleValueFor("Done")).toBe("Toggle Done");
		expect(l.tagRemove("Doing")).toBe("Remove Doing");
		expect(l.tagManageValues).toBe("Manage values…");
		expect(l.dateHint).toBe("Type a date or a phrase like “in 3 days”.");
		expect(l.formatInvalidUrl).toBe("Not a valid URL");
		expect(l.dictCount(3)).toBe("3 values");
		expect(l.dictUsage(0)).toBe("0 notes");
		expect(l.dictShowArchived(2)).toBe("Show archived (2)");
		expect(l.dictImportFailed("bad")).toBe("Couldn’t import: bad");
		expect(l.dictImportTruncated(5000)).toBe(
			"Imported the first 5000 values; the rest were skipped (too many rows).",
		);
		expect(l.dictReorder("Todo")).toBe("Reorder Todo");
	});
});

describe("default chord matchers", () => {
	it("escape matcher recognises only Escape (native + React event shapes)", () => {
		expect(defaultEscapeMatcher({ key: "Escape" })).toBe(true);
		expect(defaultEscapeMatcher({ key: "Enter" })).toBe(false);
		expect(defaultEscapeMatcher({ key: "x", nativeEvent: { key: "Escape" } })).toBe(true);
	});

	it("commit matcher recognises only Enter", () => {
		expect(defaultCommitMatcher({ key: "Enter" })).toBe(true);
		expect(defaultCommitMatcher({ key: "Escape" })).toBe(false);
		expect(defaultCommitMatcher({ key: "x", nativeEvent: { key: "Enter" } })).toBe(true);
	});

	it("dictionary-editor matchers cover close / focus / reorder", () => {
		const m = DEFAULT_DICTIONARY_EDITOR_MATCHERS;
		expect(m.closeEditor({ key: "Escape" })).toBe(true);
		expect(m.focusSearch({ key: "f", metaKey: true } as never)).toBe(true);
		expect(m.focusSearch({ key: "F", ctrlKey: true } as never)).toBe(true);
		expect(m.focusSearch({ key: "f" } as never)).toBe(false);
		expect(m.reorderToggle({ key: " " })).toBe(true);
		expect(m.reorderUp({ key: "ArrowUp" })).toBe(true);
		expect(m.reorderDown({ key: "ArrowDown" })).toBe(true);
		expect(m.reorderUp({ key: "ArrowDown" })).toBe(false);
	});
});

describe("empty entity-title source", () => {
	it("lists nothing and resolves no titles, but still display-titles an entity", () => {
		const s = EMPTY_ENTITY_TITLE_SOURCE;
		expect(s.list()).toEqual([]);
		expect(s.snapshotTick()).toBe(0);
		expect(s.titleOf("n_x")).toBeUndefined();
		expect(typeof s.subscribe(() => undefined)).toBe("function");

		const titled: VaultEntity = {
			id: "n_a",
			type: "Note",
			properties: { title: "Hello" },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
			ownerAppId: "x",
		};
		expect(s.displayTitle(titled)).toBe("Hello");
		const named: VaultEntity = { ...titled, properties: { name: "Ada" } };
		expect(s.displayTitle(named)).toBe("Ada");
		const bare: VaultEntity = { ...titled, properties: {} };
		expect(s.displayTitle(bare)).toBe("n_a");
	});
});
