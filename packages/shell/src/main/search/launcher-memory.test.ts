import { describe, expect, it } from "vitest";
import {
	LAUNCHER_SETTINGS_SCOPE,
	LauncherMemory,
	type LauncherSettingsStore,
	MAX_RECENTS,
	MAX_SAVED_SEARCHES,
	MAX_SAVED_SEARCH_CHARS,
	RECENTS_KEY,
	SAVED_SEARCHES_KEY,
	addSavedSearch,
	normalizeSavedSearchText,
	parseRecents,
	parseSavedSearches,
	pushRecent,
} from "./launcher-memory";

function memoryStore(): LauncherSettingsStore & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		get: (appId, key) => data.get(`${appId}|${key}`) ?? null,
		set: (appId, key, value) => {
			data.set(`${appId}|${key}`, value);
		},
	};
}

describe("pushRecent", () => {
	it("moves a reopened id to the front without duplicating it", () => {
		const list = pushRecent(pushRecent(pushRecent([], "a", 1), "b", 2), "a", 3);
		expect(list).toEqual([
			{ entityId: "a", openedAt: 3 },
			{ entityId: "b", openedAt: 2 },
		]);
	});

	it("keeps only the newest `cap` entries", () => {
		let list = pushRecent([], "x0", 0);
		for (let i = 1; i < MAX_RECENTS + 5; i += 1) list = pushRecent(list, `x${i}`, i);
		expect(list).toHaveLength(MAX_RECENTS);
		expect(list[0]?.entityId).toBe(`x${MAX_RECENTS + 4}`);
	});
});

describe("parsing", () => {
	it("reads corrupt or foreign values as empty lists", () => {
		expect(parseRecents(null)).toEqual([]);
		expect(parseRecents("{not json")).toEqual([]);
		expect(parseRecents('{"a":1}')).toEqual([]);
		expect(parseSavedSearches("[1, null, {}]")).toEqual([]);
	});

	it("drops malformed entries but keeps valid ones", () => {
		const raw = JSON.stringify([
			{ entityId: "ok", openedAt: 5 },
			{ entityId: "", openedAt: 5 },
			{ entityId: "nan", openedAt: "x" },
		]);
		expect(parseRecents(raw)).toEqual([{ entityId: "ok", openedAt: 5 }]);
	});
});

describe("saved searches", () => {
	it("normalises whitespace, rejects empty text and clamps length", () => {
		expect(normalizeSavedSearchText("  a   b ")).toBe("a b");
		expect(normalizeSavedSearchText("   ")).toBeNull();
		expect(normalizeSavedSearchText(42)).toBeNull();
		expect(normalizeSavedSearchText("x".repeat(500))).toHaveLength(MAX_SAVED_SEARCH_CHARS);
	});

	it("dedupes case-insensitively and caps the list", () => {
		const first = addSavedSearch([], "Plan", 1, "s1");
		const again = addSavedSearch(first.list, "plan", 2, "s2");
		expect(again.list).toHaveLength(1);
		expect(again.saved.id).toBe("s1");
		let list = first.list;
		for (let i = 0; i < MAX_SAVED_SEARCHES + 3; i += 1) {
			list = addSavedSearch(list, `q${i}`, i, `id${i}`).list;
		}
		expect(list).toHaveLength(MAX_SAVED_SEARCHES);
		expect(list[0]?.text).toBe(`q${MAX_SAVED_SEARCHES + 2}`);
	});
});

describe("LauncherMemory", () => {
	it("persists recents and saved searches under the reserved shell scope", () => {
		const store = memoryStore();
		let n = 0;
		const memory = new LauncherMemory(store, () => `id${++n}`);
		memory.recordOpen("e1", 10);
		memory.recordOpen("e2", 20);
		expect(memory.recents().map((r) => r.entityId)).toEqual(["e2", "e1"]);
		const saved = memory.saveSearch(" roadmap ", 30);
		expect(saved).toEqual({ id: "id1", text: "roadmap", createdAt: 30 });
		expect(memory.saveSearch("   ")).toBeNull();
		expect(store.data.has(`${LAUNCHER_SETTINGS_SCOPE}|${RECENTS_KEY}`)).toBe(true);
		expect(store.data.has(`${LAUNCHER_SETTINGS_SCOPE}|${SAVED_SEARCHES_KEY}`)).toBe(true);
		expect(LAUNCHER_SETTINGS_SCOPE).toContain("/");

		const reopened = new LauncherMemory(store);
		expect(reopened.savedSearches().map((s) => s.text)).toEqual(["roadmap"]);
		expect(reopened.deleteSavedSearch("nope")).toBe(false);
		expect(reopened.deleteSavedSearch(42)).toBe(false);
		expect(reopened.deleteSavedSearch("id1")).toBe(true);
		expect(reopened.savedSearches()).toEqual([]);
	});

	it("ignores an empty entity id", () => {
		const store = memoryStore();
		new LauncherMemory(store).recordOpen("");
		expect(store.data.size).toBe(0);
	});
});
