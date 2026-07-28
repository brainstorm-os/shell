/**
 * Device-local LAN host prefs. The read path is the security-relevant part:
 * nothing on disk may be able to turn the listener ON.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LanHostMode } from "./lan-host-policy";
import { LanHostPrefsStore, defaultLanHostPrefs, lanHostPrefsPath } from "./lan-host-prefs-store";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "lan-host-prefs-"));
});

const storeIn = (d: string) => new LanHostPrefsStore({ path: lanHostPrefsPath(d) });

describe("LanHostPrefsStore", () => {
	it("defaults to Off on a fresh install, and seeds the file", async () => {
		const store = storeIn(dir);
		expect(await store.load()).toEqual({ mode: LanHostMode.Off });
		// Seeded rather than implicit, so the mode is inspectable on disk.
		const raw = JSON.parse(await fs.readFile(lanHostPrefsPath(dir), "utf8"));
		expect(raw).toEqual(defaultLanHostPrefs());
	});

	it("persists a mode and reads it back in a fresh store", async () => {
		await storeIn(dir).setMode(LanHostMode.WhenVaultOpen);
		expect(await storeIn(dir).load()).toEqual({ mode: LanHostMode.WhenVaultOpen });
	});

	it("exposes `cached` as null before the first load", async () => {
		// The policy reads this synchronously; null must mean "not yet known", and
		// callers map that to the Off default rather than to "listen".
		const store = storeIn(dir);
		expect(store.cached).toBeNull();
		await store.load();
		expect(store.cached).toEqual({ mode: LanHostMode.Off });
	});

	it("cannot be turned ON by a corrupt file", async () => {
		// The failure direction is the whole point: garbage on disk resolves to Off.
		for (const body of ['{"mode":"yes"}', '{"mode":true}', "{}", "not json at all", ""]) {
			await fs.writeFile(lanHostPrefsPath(dir), body, "utf8");
			expect((await storeIn(dir).load()).mode).toBe(LanHostMode.Off);
		}
	});

	it("normalises an unknown mode passed to setMode", async () => {
		const store = storeIn(dir);
		await store.setMode("sure-why-not" as LanHostMode);
		expect(store.cached?.mode).toBe(LanHostMode.Off);
	});

	it("round-trips the share-scoped mode too", async () => {
		await storeIn(dir).setMode(LanHostMode.WhenShared);
		expect((await storeIn(dir).load()).mode).toBe(LanHostMode.WhenShared);
	});
});
