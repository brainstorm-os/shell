/**
 * P2P-1 — device-local persistence for the LAN DIAL side.
 *
 * The sibling of `lan-host-prefs-store.ts`, and split from it for the same
 * reason the policies are split: "should this machine accept connections" and
 * "should this machine go looking for peers" are independent answers. A laptop
 * that dials your desktop need not accept anything itself, and a desktop that
 * hosts need not browse. Merging them into one tri-state would force a user who
 * wants one to take the other.
 *
 * Device-local rather than in `vault.json` for the same reason as the host
 * side: it is a property of the machine and its network. It also means a vault
 * you were handed cannot make your laptop start dialling addresses.
 *
 * Same read-path posture: anything unparseable resolves to `LanDialMode.Off`
 * and a manual address that no longer validates is dropped, so a truncated
 * write or a hand-edited file cannot leave the dialer pointed somewhere odd.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_LAN_DIAL_MODE,
	type LanDialMode,
	parseLanDialMode,
	parseLanPeerAddress,
} from "./lan-dial-coordinator";

const PREFS_FILE_NAME = "lan-peer-prefs.json";

export function lanPeerPrefsPath(userDataDir: string): string {
	return join(userDataDir, PREFS_FILE_NAME);
}

export type LanPeerPrefs = {
	readonly mode: LanDialMode;
	/** A normalised `ws://host:port`, or `null`. Only meaningful in
	 *  `LanDialMode.Manual`, but kept across a mode flip so a user who toggles
	 *  away and back does not retype it. */
	readonly manualUrl: string | null;
};

export function defaultLanPeerPrefs(): LanPeerPrefs {
	return { mode: DEFAULT_LAN_DIAL_MODE, manualUrl: null };
}

export class LanPeerPrefsStore {
	private cache: LanPeerPrefs | null = null;
	private loading: Promise<LanPeerPrefs> | null = null;
	private readonly path: string;

	constructor(options: { readonly path: string }) {
		this.path = options.path;
	}

	/** The last loaded prefs, or `null` before the first load. `null` means "not
	 *  yet known" → do not dial, which callers get for free from
	 *  `cached?.mode ?? DEFAULT_LAN_DIAL_MODE` since the default is Off. */
	get cached(): LanPeerPrefs | null {
		return this.cache;
	}

	async load(): Promise<LanPeerPrefs> {
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

	async setMode(mode: LanDialMode): Promise<LanPeerPrefs> {
		const current = await this.load();
		const next: LanPeerPrefs = { ...current, mode: parseLanDialMode(mode) };
		await this.writeToDisk(next);
		this.cache = next;
		return next;
	}

	/**
	 * Set (or clear with `null`) the manual peer address.
	 *
	 * Returns the saved prefs. An address that does not normalise is REJECTED
	 * rather than stored — the caller surfaces the error. Storing a bad address
	 * would mean the dialer silently never dials, which looks identical to the
	 * bug this whole rung exists to fix.
	 */
	async setManualAddress(raw: string | null): Promise<LanPeerPrefs | null> {
		const current = await this.load();
		let manualUrl: string | null = null;
		if (raw !== null) {
			manualUrl = parseLanPeerAddress(raw);
			if (!manualUrl) return null;
		}
		const next: LanPeerPrefs = { ...current, manualUrl };
		await this.writeToDisk(next);
		this.cache = next;
		return next;
	}

	private async readFromDisk(): Promise<LanPeerPrefs> {
		let raw: string;
		try {
			raw = await fs.readFile(this.path, "utf8");
		} catch {
			const seeded = defaultLanPeerPrefs();
			await this.writeToDisk(seeded).catch(() => undefined);
			return seeded;
		}
		try {
			const parsed = JSON.parse(raw) as { mode?: unknown; manualUrl?: unknown };
			// Both guards re-run on read: a hand-edited file gets the same
			// validation a typed address does.
			return {
				mode: parseLanDialMode(parsed?.mode),
				manualUrl: typeof parsed?.manualUrl === "string" ? parseLanPeerAddress(parsed.manualUrl) : null,
			};
		} catch {
			return defaultLanPeerPrefs();
		}
	}

	private async writeToDisk(prefs: LanPeerPrefs): Promise<void> {
		await fs.writeFile(this.path, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
	}
}
