import type { SettingsService } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { sourceKeyFor } from "./scheduled-item";
import { defaultHiddenSources, loadHiddenSources, saveHiddenSources } from "./source-prefs";

function fakeSettings(
	initial: Record<string, unknown> = {},
): SettingsService & { store: Map<string, unknown> } {
	const store = new Map<string, unknown>(Object.entries(initial));
	return {
		store,
		async get<T = unknown>(key: string) {
			return store.has(key) ? (store.get(key) as T) : null;
		},
		async put(key: string, value: unknown) {
			store.set(key, value);
		},
		async delete(key: string) {
			return store.delete(key);
		},
		async list(prefix = "") {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, value]) => ({ key, value }));
		},
	};
}

const COMPLETED = sourceKeyFor("brainstorm/Task/v1", "completedAt");

describe("defaultHiddenSources", () => {
	it("hides the sources marked defaultHidden (e.g. Task completion dates)", () => {
		expect(defaultHiddenSources().has(COMPLETED)).toBe(true);
	});
});

describe("loadHiddenSources", () => {
	it("returns the defaults when no service is present", async () => {
		expect(await loadHiddenSources(undefined)).toEqual(defaultHiddenSources());
	});

	it("returns the defaults when nothing is stored yet", async () => {
		expect(await loadHiddenSources(fakeSettings())).toEqual(defaultHiddenSources());
	});

	it("returns exactly the stored set once persisted (defaults no longer forced)", async () => {
		const settings = fakeSettings({ "calendar.hidden-sources": ["a::b"] });
		const loaded = await loadHiddenSources(settings);
		expect([...loaded]).toEqual(["a::b"]);
		expect(loaded.has(COMPLETED)).toBe(false);
	});

	it("ignores a malformed stored value", async () => {
		const settings = fakeSettings({ "calendar.hidden-sources": "not-an-array" });
		expect(await loadHiddenSources(settings)).toEqual(defaultHiddenSources());
	});
});

describe("saveHiddenSources", () => {
	it("round-trips the hidden set", async () => {
		const settings = fakeSettings();
		await saveHiddenSources(settings, new Set(["x::y", "z::w"]));
		expect(settings.store.get("calendar.hidden-sources")).toEqual(["x::y", "z::w"]);
		expect([...(await loadHiddenSources(settings))]).toEqual(["x::y", "z::w"]);
	});

	it("is a no-op without a service", async () => {
		await expect(saveHiddenSources(undefined, new Set(["x"]))).resolves.toBeUndefined();
	});
});
