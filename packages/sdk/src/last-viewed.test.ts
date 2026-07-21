import type { SettingsService } from "@brainstorm-os/sdk-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recallLastViewed, rememberLastViewed } from "./last-viewed";

function fakeSettings(): SettingsService & { store: Map<string, unknown> } {
	const store = new Map<string, unknown>();
	const settings: SettingsService = {
		get: (key) => Promise.resolve((store.has(key) ? store.get(key) : null) as never),
		put: (key, value) => {
			store.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => Promise.resolve(store.delete(key)),
		list: () => Promise.resolve([...store.entries()].map(([key, value]) => ({ key, value }))),
	};
	return Object.assign(settings, { store });
}

describe("last-viewed", () => {
	let settings: ReturnType<typeof fakeSettings>;
	beforeEach(() => {
		settings = fakeSettings();
	});

	it("round-trips the recorded id under the default key", async () => {
		await rememberLastViewed(settings, "ent_123");
		expect(settings.store.get("last-viewed")).toBe("ent_123");
		expect(await recallLastViewed(settings)).toBe("ent_123");
	});

	it("scopes independent locations by key", async () => {
		await rememberLastViewed(settings, "ent_a", "left");
		await rememberLastViewed(settings, "ent_b", "right");
		expect(await recallLastViewed(settings, "left")).toBe("ent_a");
		expect(await recallLastViewed(settings, "right")).toBe("ent_b");
	});

	it("clears the hint when id is null", async () => {
		await rememberLastViewed(settings, "ent_123");
		await rememberLastViewed(settings, null);
		expect(settings.store.has("last-viewed")).toBe(false);
		expect(await recallLastViewed(settings)).toBeNull();
	});

	it("returns null when nothing was recorded", async () => {
		expect(await recallLastViewed(settings)).toBeNull();
	});

	it("returns null for a non-string / empty stored value", async () => {
		settings.store.set("last-viewed", "");
		expect(await recallLastViewed(settings)).toBeNull();
		settings.store.set("last-viewed", 42);
		expect(await recallLastViewed(settings)).toBeNull();
	});

	it("is a no-op when the settings service is absent (preview shell)", async () => {
		await expect(rememberLastViewed(undefined, "ent_123")).resolves.toBeUndefined();
		await expect(recallLastViewed(undefined)).resolves.toBeNull();
	});

	it("swallows a settings-service throw rather than surfacing it", async () => {
		const broken: SettingsService = {
			get: vi.fn(async () => {
				throw new Error("Unavailable");
			}),
			put: vi.fn(async () => {
				throw new Error("Unavailable");
			}),
			delete: vi.fn(async () => {
				throw new Error("Unavailable");
			}),
			list: vi.fn(async () => []),
		};
		await expect(rememberLastViewed(broken, "ent_123")).resolves.toBeUndefined();
		await expect(recallLastViewed(broken)).resolves.toBeNull();
	});
});
