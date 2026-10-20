// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { type Entity, FILE_TYPE, FOLDER_TYPE, NOTE_TYPE } from "../types/entity";
import { ViewMode } from "../view-mode";
import { RowGlyph } from "./row-glyph";

let root: Root | null = null;

function render(node: React.ReactNode): HTMLElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	act(() => root?.render(node));
	return el;
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

function entity(type: string, properties: Record<string, unknown>): Entity {
	return { id: `e_${type}`, type, properties, createdAt: 1, updatedAt: 1, deletedAt: null };
}

/** Every row kind the Files browser can show: the two native kinds, an
 *  object carrying its own icon, and foreign objects with / without a known
 *  opener app. None of them may render an EMPTY glyph host — an empty host
 *  is what let the name slide into the icon track. */
const ROW_KINDS: ReadonlyArray<[string, Entity, string | null]> = [
	["folder without an icon", entity(FOLDER_TYPE, { name: "Docs", members: [] }), null],
	["imported pdf", entity(FILE_TYPE, { name: "a.pdf", mime: "application/pdf" }), "preview"],
	[
		"imported image",
		entity(FILE_TYPE, { name: "a.png", assetId: "as_1", assetMime: "image/png" }),
		"preview",
	],
	["note with its own emoji icon", entity(NOTE_TYPE, { name: "n", icon: "emoji:😀" }), "notes"],
	["bookmark with an opener", entity("brainstorm/Bookmark/v1", { name: "b" }), "bookmarks"],
	["event without an opener", entity("brainstorm/Event/v1", { name: "ev" }), null],
];

describe("RowGlyph", () => {
	for (const mode of [ViewMode.List, ViewMode.IconList, ViewMode.Grid, ViewMode.Gallery]) {
		for (const [label, row, opener] of ROW_KINDS) {
			it(`${mode}: ${label} renders a non-empty glyph`, () => {
				const el = render(<RowGlyph entity={row} mode={mode} iconSize={20} openerAppId={opener} />);
				const host = el.querySelector(".content-row__glyph");
				expect(host, "glyph host missing").not.toBeNull();
				expect(host?.childElementCount, `${label} rendered an empty glyph host`).toBeGreaterThan(0);
			});
		}
	}
});
