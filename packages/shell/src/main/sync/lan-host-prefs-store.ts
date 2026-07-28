/**
 * Device-local persistence for the LAN host-listen mode.
 *
 * Device-local, not per-vault: "should THIS machine accept LAN connections" is a
 * property of the machine and its network, not of a vault's contents. The same
 * reasoning the automation-host designation uses — one of your devices runs the
 * schedules — and the same reasoning that puts update prefs here rather than in
 * `vault.json`. It also means opening a vault you were handed cannot silently
 * start a listener on your laptop.
 *
 * Shaped after `UpdatePrefsStore` deliberately: same load/patch/cache contract,
 * same seed-on-missing behaviour, so there is one pattern for device prefs rather
 * than a new one per feature.
 *
 * The security-relevant part is the read path: anything unparseable resolves to
 * `LanHostMode.Off` via `parseLanHostMode`. A truncated write, a hand-edited
 * file, or a future field rename cannot leave the listener enabled.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LAN_HOST_MODE, type LanHostMode, parseLanHostMode } from "./lan-host-policy";

const PREFS_FILE_NAME = "lan-host-prefs.json";

export function lanHostPrefsPath(userDataDir: string): string {
	return join(userDataDir, PREFS_FILE_NAME);
}

export type LanHostPrefs = {
	readonly mode: LanHostMode;
};

export function defaultLanHostPrefs(): LanHostPrefs {
	return { mode: DEFAULT_LAN_HOST_MODE };
}

export class LanHostPrefsStore {
	private cache: LanHostPrefs | null = null;
	private loading: Promise<LanHostPrefs> | null = null;
	private readonly path: string;

	constructor(options: { readonly path: string }) {
		this.path = options.path;
	}

	/**
	 * The last loaded prefs, or `null` before the first load.
	 *
	 * The listener policy reads this synchronously, and `null` must be treated as
	 * "not yet known" → do not listen. Callers get that for free by mapping
	 * `cached?.mode ?? DEFAULT_LAN_HOST_MODE`, since the default is `Off`.
	 */
	get cached(): LanHostPrefs | null {
		return this.cache;
	}

	async load(): Promise<LanHostPrefs> {
		if (this.cache) return this.cache;
		if (this.loading) return await this.loading;
		this.loading = (async () => {
			const prefs = await this.readFromDisk();
			this.cache = prefs;
			this.loading = null;
			return prefs;
		})();
		return await this.loading;
	}

	async setMode(mode: LanHostMode): Promise<LanHostPrefs> {
		const next: LanHostPrefs = { mode: parseLanHostMode(mode) };
		await this.writeToDisk(next);
		this.cache = next;
		return next;
	}

	private async readFromDisk(): Promise<LanHostPrefs> {
		let raw: string;
		try {
			raw = await fs.readFile(this.path, "utf8");
		} catch {
			// Missing file is the normal first-run case: seed it so the mode is
			// visible on disk rather than implicit.
			const seeded = defaultLanHostPrefs();
			await this.writeToDisk(seeded).catch(() => undefined);
			return seeded;
		}
		try {
			const parsed = JSON.parse(raw) as { mode?: unknown };
			// `parseLanHostMode` is the guard: garbage resolves to Off, never on.
			return { mode: parseLanHostMode(parsed?.mode) };
		} catch {
			return defaultLanHostPrefs();
		}
	}

	private async writeToDisk(prefs: LanHostPrefs): Promise<void> {
		await fs.writeFile(this.path, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
	}
}
