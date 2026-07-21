import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpdatePrefsStore, defaultUpdatePrefs, updatePrefsPath } from "./update-prefs-store";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "bs-update-prefs-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function store() {
	return new UpdatePrefsStore({ path: updatePrefsPath(dir) });
}

describe("UpdatePrefsStore", () => {
	it("seeds defaults on first read", async () => {
		const prefs = await store().load();
		expect(prefs).toEqual(defaultUpdatePrefs());
		// re-seeded to disk so the next read is a clean parse
		const onDisk = JSON.parse(await fs.readFile(updatePrefsPath(dir), "utf8"));
		expect(onDisk.channel).toBe(UpdateChannel.Stable);
	});

	it("persists a channel change and a check stamp", async () => {
		const s = store();
		await s.patch({ channel: UpdateChannel.Beta });
		await s.patch({ lastCheckedAt: "2026-06-09T00:00:00.000Z" });
		const reloaded = await store().load();
		expect(reloaded).toEqual({
			channel: UpdateChannel.Beta,
			lastCheckedAt: "2026-06-09T00:00:00.000Z",
		});
	});

	it("falls back to defaults on a corrupt file", async () => {
		await fs.writeFile(updatePrefsPath(dir), "{not json", "utf8");
		expect(await store().load()).toEqual(defaultUpdatePrefs());
	});

	it("coerces an unknown channel value to Stable", async () => {
		await fs.writeFile(
			updatePrefsPath(dir),
			JSON.stringify({ channel: "nightly", lastCheckedAt: null }),
			"utf8",
		);
		expect((await store().load()).channel).toBe(UpdateChannel.Stable);
	});
});
