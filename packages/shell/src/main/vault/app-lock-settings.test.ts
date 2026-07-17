import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";
import {
	DEFAULT_AUTO_LOCK_MINUTES,
	appLockSettingsPath,
	readAppLockSettings,
	validateAppLockSettings,
	writeAppLockSettings,
} from "./app-lock-settings";

describe("validateAppLockSettings", () => {
	it("accepts an allowed interval", () => {
		expect(validateAppLockSettings({ autoLockMinutes: 15 })).toEqual({ autoLockMinutes: 15 });
		expect(validateAppLockSettings({ autoLockMinutes: 0 })).toEqual({ autoLockMinutes: 0 });
	});

	it("falls back to the default for an out-of-set / wrong-typed / missing value", () => {
		const def = { autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES };
		expect(validateAppLockSettings({ autoLockMinutes: 7 })).toEqual(def);
		expect(validateAppLockSettings({ autoLockMinutes: "5" })).toEqual(def);
		expect(validateAppLockSettings({})).toEqual(def);
		expect(validateAppLockSettings(null)).toEqual(def);
	});
});

describe("readAppLockSettings / writeAppLockSettings", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "brainstorm-als-"));
	});
	afterEach(async () => {
		await removeTestDir(dir);
	});

	it("round-trips a written value", async () => {
		await writeAppLockSettings(dir, { autoLockMinutes: 30 });
		expect(await readAppLockSettings(dir)).toEqual({ autoLockMinutes: 30 });
	});

	it("default-on-first-read writes the default so the next read is a clean parse", async () => {
		expect(await readAppLockSettings(dir)).toEqual({ autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES });
		// The file now exists with the default.
		const raw = JSON.parse(await readFile(appLockSettingsPath(dir), "utf8"));
		expect(raw).toEqual({ autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES });
	});

	it("clamps a hand-edited out-of-set value back to the default on write", async () => {
		await writeAppLockSettings(dir, { autoLockMinutes: 999 });
		expect(await readAppLockSettings(dir)).toEqual({ autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES });
	});
});
