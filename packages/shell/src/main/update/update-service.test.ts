import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateAvailability, UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePrefsStore, updatePrefsPath } from "./update-prefs-store";
import { UpdateService } from "./update-service";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "bs-update-svc-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const FEED = {
	stable: { version: "1.0.0", downloadUrl: "https://dl/1.0.0" },
	beta: { version: "1.1.0-beta.1", downloadUrl: "https://dl/1.1.0-beta.1" },
};

function service(opts: {
	current: string;
	fetchFeedJson?: () => Promise<unknown>;
	now?: () => number;
}) {
	return new UpdateService({
		prefs: new UpdatePrefsStore({ path: updatePrefsPath(dir) }),
		getCurrentVersion: () => opts.current,
		fetchFeedJson: opts.fetchFeedJson ?? (async () => FEED),
		now: opts.now ?? (() => Date.parse("2026-06-09T12:00:00.000Z")),
	});
}

describe("UpdateService", () => {
	it("reports Available on the stable channel and stamps lastCheckedAt", async () => {
		const svc = service({ current: "0.9.0" });
		const result = await svc.check();
		expect(result.availability).toBe(UpdateAvailability.Available);
		expect(result.latest?.version).toBe("1.0.0");
		expect(result.currentVersion).toBe("0.9.0");
		expect(result.checkedAt).toBe("2026-06-09T12:00:00.000Z");
		expect((await svc.getPrefs()).lastCheckedAt).toBe("2026-06-09T12:00:00.000Z");
	});

	it("honours the persisted channel", async () => {
		const svc = service({ current: "1.0.0" });
		await svc.setChannel(UpdateChannel.Beta);
		const result = await svc.check();
		expect(result.channel).toBe(UpdateChannel.Beta);
		expect(result.availability).toBe(UpdateAvailability.Available);
		expect(result.latest?.version).toBe("1.1.0-beta.1");
	});

	it("reports UpToDate when current matches the latest", async () => {
		const result = await service({ current: "1.0.0" }).check();
		expect(result.availability).toBe(UpdateAvailability.UpToDate);
		expect(result.latest).toBeUndefined();
	});

	it("resolves Unknown (never throws) on a fetch failure", async () => {
		const svc = service({
			current: "1.0.0",
			fetchFeedJson: async () => {
				throw new Error("offline");
			},
		});
		const result = await svc.check();
		expect(result.availability).toBe(UpdateAvailability.Unknown);
		// still stamps the attempt
		expect((await svc.getPrefs()).lastCheckedAt).toBe("2026-06-09T12:00:00.000Z");
	});

	it("resolves Unknown on a malformed feed", async () => {
		const result = await service({
			current: "1.0.0",
			fetchFeedJson: async () => ({ junk: 1 }),
		}).check();
		expect(result.availability).toBe(UpdateAvailability.Unknown);
	});

	it("does not fetch more than once per check", async () => {
		const fetchFeedJson = vi.fn(async () => FEED);
		await service({ current: "1.0.0", fetchFeedJson }).check();
		expect(fetchFeedJson).toHaveBeenCalledTimes(1);
	});
});
