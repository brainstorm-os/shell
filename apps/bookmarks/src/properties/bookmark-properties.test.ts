import {
	DateGranularity,
	type Dictionary,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../types/bookmark";
import {
	BOOKMARK_PROPERTY_DEFS,
	BOOKMARK_PROP_KEY,
	BOOKMARK_TAGS_DICTIONARY_ID,
	READONLY_BOOKMARK_PROP_KEYS,
	applyBookmarkPropertyValue,
	bookmarkToValues,
	ensureBookmarkTagsDictionary,
	tagsFromCellValue,
	tagsToCellValue,
} from "./bookmark-properties";

const BASE: Bookmark = {
	id: "b1",
	url: "https://en.wikipedia.org/wiki/Pope_Leo_XIV",
	title: "Pope Leo XIV - Wikipedia",
	siteName: "Wikipedia",
	icon: null,
	faviconUrl: null,
	coverImageUrl: null,
	tags: ["history"],
	savedAt: 1700000000000,
	readAt: null,
	archivedAt: null,
	colorHint: null,
	createdAt: 1700000000000,
	updatedAt: 1700000000000,
};

describe("bookmarkToValues", () => {
	it("synthesises a value per property def", () => {
		const v = bookmarkToValues(BASE);
		expect(v[BOOKMARK_PROP_KEY.url]).toBe(BASE.url);
		expect(v[BOOKMARK_PROP_KEY.site]).toBe("Wikipedia");
		expect(v[BOOKMARK_PROP_KEY.read]).toBe(false);
		expect(v[BOOKMARK_PROP_KEY.archived]).toBe(false);
		expect((v[BOOKMARK_PROP_KEY.saved] as { at: number }).at).toBe(BASE.savedAt);
		// Every def has a value.
		for (const def of BOOKMARK_PROPERTY_DEFS) expect(v[def.key]).toBeDefined();
	});

	it("falls back to the domain for site when no siteName", () => {
		const { siteName: _omit, ...noSite } = BASE;
		const v = bookmarkToValues(noSite);
		expect(v[BOOKMARK_PROP_KEY.site]).toBe("en.wikipedia.org");
	});

	it("reflects read/archived status", () => {
		const v = bookmarkToValues({ ...BASE, readAt: 123, archivedAt: 456 });
		expect(v[BOOKMARK_PROP_KEY.read]).toBe(true);
		expect(v[BOOKMARK_PROP_KEY.archived]).toBe(true);
	});

	it("surfaces og:description and folds og:type to a friendly label", () => {
		const v = bookmarkToValues({
			...BASE,
			description: "The 267th pope.",
			mediaType: "video.movie",
		});
		expect(v[BOOKMARK_PROP_KEY.description]).toBe("The 267th pope.");
		// The raw dotted og:type ("video.movie") reads as the friendly kind (9.18.14).
		expect(v[BOOKMARK_PROP_KEY.type]).toBe("Video");
	});

	it("leaves description / type empty when the page declared none", () => {
		const v = bookmarkToValues(BASE);
		expect(v[BOOKMARK_PROP_KEY.description]).toBe("");
		// The generic "page" default reads as no value, not the literal "Page".
		expect(v[BOOKMARK_PROP_KEY.type]).toBe("");
	});

	it("surfaces the user's freeform notes; empty when absent", () => {
		expect(
			bookmarkToValues({ ...BASE, notes: "remember the third chapter" })[BOOKMARK_PROP_KEY.notes],
		).toBe("remember the third chapter");
		expect(bookmarkToValues(BASE)[BOOKMARK_PROP_KEY.notes]).toBe("");
	});

	it("surfaces scraped author + publishedAt (9.18.6)", () => {
		const v = bookmarkToValues({ ...BASE, author: "Jane Doe", publishedAt: 1699999999000 });
		expect(v[BOOKMARK_PROP_KEY.author]).toBe("Jane Doe");
		expect((v[BOOKMARK_PROP_KEY.published] as { at: number }).at).toBe(1699999999000);
	});

	it("leaves author empty and published null when the page declared none", () => {
		const v = bookmarkToValues(BASE);
		expect(v[BOOKMARK_PROP_KEY.author]).toBe("");
		expect(v[BOOKMARK_PROP_KEY.published]).toBeNull();
	});

	it("keeps author + published editable (F-204: citation basics the scraper may miss)", () => {
		expect(READONLY_BOOKMARK_PROP_KEYS.has(BOOKMARK_PROP_KEY.author)).toBe(false);
		expect(READONLY_BOOKMARK_PROP_KEYS.has(BOOKMARK_PROP_KEY.published)).toBe(false);
	});
});

describe("applyBookmarkPropertyValue", () => {
	it("toggles readAt / archivedAt to a timestamp or null", () => {
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.read, true, 999)).toEqual({ readAt: 999 });
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.read, false, 999)).toEqual({ readAt: null });
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.archived, true, 999)).toEqual({
			archivedAt: 999,
		});
	});

	it("writes back an edited site name, trimmed; clearing drops it to resume the domain", () => {
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.site, "  The Times  ", 1)).toEqual({
			siteName: "The Times",
		});
		// An empty value clears siteName (undefined) so the domain fallback resumes.
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.site, "  ", 1)).toEqual({
			siteName: undefined,
		});
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.site, 42, 1)).toEqual({
			siteName: undefined,
		});
	});

	it("keeps site editable (not in the read-only set)", () => {
		expect(READONLY_BOOKMARK_PROP_KEYS.has(BOOKMARK_PROP_KEY.site)).toBe(false);
		const def = BOOKMARK_PROPERTY_DEFS.find((d) => d.key === BOOKMARK_PROP_KEY.site);
		expect(def?.valueType).toBe(ValueType.Text);
	});

	it("writes back an edited author, trimmed; clearing drops it (undefined)", () => {
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.author, "  Jane Doe  ", 1)).toEqual({
			author: "Jane Doe",
		});
		// An empty value clears author so the row hides again.
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.author, "  ", 1)).toEqual({
			author: undefined,
		});
		// A non-string also clears it.
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.author, 42, 1)).toEqual({
			author: undefined,
		});
	});

	it("keeps author editable (not in the read-only set)", () => {
		expect(READONLY_BOOKMARK_PROP_KEYS.has(BOOKMARK_PROP_KEY.author)).toBe(false);
		const def = BOOKMARK_PROPERTY_DEFS.find((d) => d.key === BOOKMARK_PROP_KEY.author);
		expect(def?.valueType).toBe(ValueType.Text);
	});

	it("writes back an edited description, trimmed", () => {
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.description, "  hello  ", 1)).toEqual({
			description: "hello",
		});
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.description, "", 1)).toEqual({
			description: "",
		});
	});

	it("writes back edited notes, trimmed; non-string clears to empty", () => {
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.notes, "  jot  ", 1)).toEqual({
			notes: "jot",
		});
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.notes, 42, 1)).toEqual({ notes: "" });
	});

	it("keeps notes editable (not in the read-only set)", () => {
		expect(READONLY_BOOKMARK_PROP_KEYS.has(BOOKMARK_PROP_KEY.notes)).toBe(false);
		const def = BOOKMARK_PROPERTY_DEFS.find((d) => d.key === BOOKMARK_PROP_KEY.notes);
		expect(def?.valueType).toBe(ValueType.Text);
		expect(def?.display?.view).toBe(PropertyView.Multiline);
	});

	it("writes back an edited author, trimmed; clearing drops the field (F-204)", () => {
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.author, "  Jane Doe  ", 1)).toEqual({
			author: "Jane Doe",
		});
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.author, "   ", 1)).toEqual({
			author: undefined,
		});
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.author, 42, 1)).toEqual({
			author: undefined,
		});
	});

	it("writes back a picked published date; clearing drops the field (F-204)", () => {
		const picked = { at: 1699999999000, granularity: DateGranularity.Date };
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.published, picked, 1)).toEqual({
			publishedAt: 1699999999000,
		});
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.published, null, 1)).toEqual({
			publishedAt: undefined,
		});
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.published, "soon", 1)).toEqual({
			publishedAt: undefined,
		});
	});

	it("round-trips a hand-added author + published through bookmarkToValues (F-204)", () => {
		const edited: Bookmark = {
			...BASE,
			...applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.author, "Jane Doe", 1),
			...applyBookmarkPropertyValue(
				BOOKMARK_PROP_KEY.published,
				{ at: 1699999999000, granularity: DateGranularity.Date },
				1,
			),
		};
		const v = bookmarkToValues(edited);
		expect(v[BOOKMARK_PROP_KEY.author]).toBe("Jane Doe");
		expect((v[BOOKMARK_PROP_KEY.published] as { at: number }).at).toBe(1699999999000);
	});

	it("keeps og:type read-only (scrape-only, no write-back)", () => {
		expect(applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.type, "video.movie", 1)).toBeNull();
	});

	it("returns null for read-only properties", () => {
		for (const key of READONLY_BOOKMARK_PROP_KEYS) {
			expect(applyBookmarkPropertyValue(key, "x", 1)).toBeNull();
		}
	});
});

describe("tags ⇄ TagList cell bridge", () => {
	const DICT = {
		id: "io.brainstorm.bookmarks/tags-dictionary",
		name: "Bookmark tags",
		items: [
			{ id: "history", label: "history", icon: null, sortIndex: 0 },
			{ id: "dict_x1", label: "reading list", icon: null, sortIndex: 1 },
		],
	};

	it("declares a multi-valued, vocabulary-backed Tags def", () => {
		const def = BOOKMARK_PROPERTY_DEFS.find((d) => d.key === BOOKMARK_PROP_KEY.tags);
		expect(def?.vocabulary).toEqual({ dictionaryId: BOOKMARK_TAGS_DICTIONARY_ID });
		expect(def?.count?.max).toBeGreaterThan(1);
		expect(READONLY_BOOKMARK_PROP_KEYS.has(BOOKMARK_PROP_KEY.tags)).toBe(false);
	});

	it("maps label tags to item ids; unknown tags pass through", () => {
		expect(tagsToCellValue(["history", "reading list", "novel"], DICT)).toEqual([
			{ value: "history" },
			{ value: "dict_x1" },
			{ value: "novel" },
		]);
		// No dictionary yet → verbatim values (chips still render).
		expect(tagsToCellValue(["history"], undefined)).toEqual([{ value: "history" }]);
	});

	it("maps edited item ids back to label tags, deduped + blanks dropped", () => {
		expect(
			tagsFromCellValue([{ value: "dict_x1" }, { value: "history" }, { value: "history" }], DICT),
		).toEqual(["reading list", "history"]);
		expect(tagsFromCellValue([{ value: "  " }], DICT)).toEqual([]);
		expect(tagsFromCellValue("nope", DICT)).toEqual([]);
	});

	it("applyBookmarkPropertyValue writes the tags field through the dictionary", () => {
		expect(
			applyBookmarkPropertyValue(BOOKMARK_PROP_KEY.tags, [{ value: "dict_x1" }], 1, DICT),
		).toEqual({ tags: ["reading list"] });
	});

	it("bookmarkToValues carries the bridged tag ids", () => {
		const v = bookmarkToValues({ ...BASE, tags: ["history", "reading list"] }, DICT);
		expect(v[BOOKMARK_PROP_KEY.tags]).toEqual([{ value: "history" }, { value: "dict_x1" }]);
	});
});

describe("ensureBookmarkTagsDictionary", () => {
	function io(existing: Dictionary | null) {
		const writes: Dictionary[] = [];
		return {
			io: {
				getDictionary: () => Promise.resolve(existing),
				setDictionary: (dict: Dictionary) => {
					writes.push(dict);
					return Promise.resolve();
				},
			},
			writes,
		};
	}

	it("creates the dictionary with one item per in-use tag (id == label)", async () => {
		const { io: ports, writes } = io(null);
		await ensureBookmarkTagsDictionary(ports, "Bookmark tags", ["b", "a", " a ", ""]);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.id).toBe(BOOKMARK_TAGS_DICTIONARY_ID);
		expect(writes[0]?.items.map((it) => it.id)).toEqual(["a", "b"]);
		expect(writes[0]?.items.map((it) => it.sortIndex)).toEqual([0, 1]);
	});

	it("backfills only missing tags, preserving existing items", async () => {
		const existing: Dictionary = {
			id: BOOKMARK_TAGS_DICTIONARY_ID,
			name: "Bookmark tags",
			items: [{ id: "dict_x1", label: "reading list", icon: null, sortIndex: 4 }],
		};
		const { io: ports, writes } = io(existing);
		await ensureBookmarkTagsDictionary(ports, "Bookmark tags", ["reading list", "new"]);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.items.map((it) => it.id)).toEqual(["dict_x1", "new"]);
		expect(writes[0]?.items[1]?.sortIndex).toBe(5);
	});

	it("no-ops when every in-use tag is already known", async () => {
		const existing: Dictionary = {
			id: BOOKMARK_TAGS_DICTIONARY_ID,
			name: "Bookmark tags",
			items: [{ id: "history", label: "history", icon: null, sortIndex: 0 }],
		};
		const { io: ports, writes } = io(existing);
		await ensureBookmarkTagsDictionary(ports, "Bookmark tags", ["history"]);
		expect(writes).toHaveLength(0);
	});
});
