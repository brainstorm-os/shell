import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BackgroundPrefsStore,
	DEFAULT_BACKGROUND_PREFS,
	backgroundPrefsPath,
	shouldQuitWhenAllWindowsClosed,
	supportsCloseToTray,
} from "./background-prefs";

describe("background prefs (7.16)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bg-prefs-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("is off by default and when the file is missing or corrupt", async () => {
		const store = new BackgroundPrefsStore(backgroundPrefsPath(dir));
		expect(store.cached).toEqual(DEFAULT_BACKGROUND_PREFS);
		expect(await store.load()).toEqual({ keepRunning: false });
		await writeFile(backgroundPrefsPath(dir), "{not json", "utf8");
		expect(await store.load()).toEqual({ keepRunning: false });
		await writeFile(backgroundPrefsPath(dir), JSON.stringify({ keepRunning: "yes" }), "utf8");
		expect(await store.load()).toEqual({ keepRunning: false });
	});

	it("persists across instances", async () => {
		await new BackgroundPrefsStore(backgroundPrefsPath(dir)).set(true);
		const reopened = new BackgroundPrefsStore(backgroundPrefsPath(dir));
		expect(await reopened.load()).toEqual({ keepRunning: true });
		expect(reopened.cached.keepRunning).toBe(true);
	});

	it("quits on the last window off macOS unless keep-running is on; macOS never quits", () => {
		expect(shouldQuitWhenAllWindowsClosed("win32", { keepRunning: false })).toBe(true);
		expect(shouldQuitWhenAllWindowsClosed("linux", { keepRunning: true })).toBe(false);
		expect(shouldQuitWhenAllWindowsClosed("darwin", { keepRunning: false })).toBe(false);
		expect(shouldQuitWhenAllWindowsClosed("darwin", { keepRunning: true })).toBe(false);
		expect(supportsCloseToTray("darwin")).toBe(false);
		expect(supportsCloseToTray("win32")).toBe(true);
	});
});
