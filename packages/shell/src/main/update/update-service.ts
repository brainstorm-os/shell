/**
 * 13.6 — UpdateService: the shell-main orchestrator for the manual-
 * download update check.
 *
 * `check()` loads the persisted channel, fetches the release feed JSON
 * through an injected fetcher (production binds the Net-1 brokered fetch
 * chokepoint — the shell's *own* egress, never an app's; tests bind a
 * deterministic stub), runs the pure `evaluateUpdate`, records the
 * last-checked stamp, and returns the resolved status. It NEVER downloads
 * or installs — the result only carries the human download page the
 * renderer opens through the OS-handoff chokepoint.
 *
 * Every IO dependency is injected so the whole service is unit-testable
 * with no network and no Electron.
 */

import type {
	UpdateChannel,
	UpdateCheckResult,
	UpdatePrefs,
} from "@brainstorm-os/protocol/update-wire-types";
import { evaluateUpdate, parseReleaseFeed } from "./update-core";
import type { UpdatePrefsStore } from "./update-prefs-store";

export type UpdateServiceOptions = {
	readonly prefs: UpdatePrefsStore;
	/** Resolve the running app version (production: `app.getVersion()`). */
	readonly getCurrentVersion: () => string;
	/** Fetch + JSON-parse the release feed. Returns the parsed value, or
	 *  null on any failure (offline, non-200, malformed JSON) — a failed
	 *  fetch resolves to `Unknown`, never throws. */
	readonly fetchFeedJson: () => Promise<unknown>;
	readonly now?: () => number;
};

export class UpdateService {
	private readonly prefs: UpdatePrefsStore;
	private readonly getCurrentVersion: () => string;
	private readonly fetchFeedJson: () => Promise<unknown>;
	private readonly now: () => number;

	constructor(options: UpdateServiceOptions) {
		this.prefs = options.prefs;
		this.getCurrentVersion = options.getCurrentVersion;
		this.fetchFeedJson = options.fetchFeedJson;
		this.now = options.now ?? Date.now;
	}

	async getPrefs(): Promise<UpdatePrefs> {
		return await this.prefs.load();
	}

	async setChannel(channel: UpdateChannel): Promise<UpdatePrefs> {
		return await this.prefs.patch({ channel });
	}

	/** Run a check on the persisted channel. Total — a fetch/parse failure
	 *  resolves to `Unknown`, not a rejection. */
	async check(): Promise<UpdateCheckResult> {
		const { channel } = await this.prefs.load();
		const checkedAt = new Date(this.now()).toISOString();
		const raw = await this.safeFetch();
		const feed = parseReleaseFeed(raw);
		const result = evaluateUpdate(this.getCurrentVersion(), feed, channel, checkedAt);
		await this.prefs.patch({ lastCheckedAt: checkedAt });
		return result;
	}

	private async safeFetch(): Promise<unknown> {
		try {
			return await this.fetchFeedJson();
		} catch (error) {
			console.warn("[brainstorm] update feed fetch failed:", error);
			return null;
		}
	}
}
