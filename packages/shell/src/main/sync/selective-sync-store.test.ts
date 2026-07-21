import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SELECTIVE_SYNC_POLICY,
	SelectiveSyncMode,
} from "@brainstorm-os/protocol/selective-sync-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SelectiveSyncStore, selectiveSyncPolicyPath } from "./selective-sync-store";

describe("SelectiveSyncStore", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bs-selsync-"));
		path = selectiveSyncPolicyPath(dir);
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("seeds the default policy on first load + writes it to disk", async () => {
		const store = new SelectiveSyncStore({ path });
		expect(await store.load()).toEqual(DEFAULT_SELECTIVE_SYNC_POLICY);
		// File now exists with the seeded default.
		const raw = JSON.parse(await readFile(path, "utf8"));
		expect(raw.mode).toBe(SelectiveSyncMode.Everything);
	});

	it("set() normalises + persists + a fresh store reads it back", async () => {
		const store = new SelectiveSyncStore({ path });
		const saved = await store.set({ mode: "pinned-plus-recent", recentDays: 7 });
		expect(saved).toEqual({ mode: SelectiveSyncMode.PinnedPlusRecent, recentDays: 7 });
		expect(store.cached).toEqual(saved);

		const reopened = new SelectiveSyncStore({ path });
		expect(await reopened.load()).toEqual(saved);
	});

	it("set() clamps an out-of-range window + repairs an unknown mode", async () => {
		const store = new SelectiveSyncStore({ path });
		expect(await store.set({ mode: "bogus", recentDays: -5 })).toEqual({
			mode: SelectiveSyncMode.Everything,
			recentDays: 1,
		});
	});

	it("a corrupt file resolves to the default (default-on-corrupt)", async () => {
		await writeFile(path, "{ not json", "utf8");
		const store = new SelectiveSyncStore({ path });
		expect(await store.load()).toEqual(DEFAULT_SELECTIVE_SYNC_POLICY);
	});
});
