/**
 * 7.16 — "Keep running in the background" (close to tray), app-global.
 *
 * Persists `{ keepRunning }` at `<userData>/background-prefs.json`. App-level,
 * not vault-level: whether closing the last window quits the process is about
 * the install, and it has to be readable before (and without) any vault. Off by
 * default; an unreadable or malformed file reads as the default. macOS is
 * untouched — the app already stays alive there with no windows (dock), so the
 * preference only applies elsewhere.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

const PREFS_FILE_NAME = "background-prefs.json";

export type BackgroundPrefs = { keepRunning: boolean };

export const DEFAULT_BACKGROUND_PREFS: BackgroundPrefs = { keepRunning: false };

export function backgroundPrefsPath(userDataDir: string): string {
	return join(userDataDir, PREFS_FILE_NAME);
}

/** Whether the platform honours the preference at all (non-macOS). */
export function supportsCloseToTray(platform: NodeJS.Platform): boolean {
	return platform !== "darwin";
}

/** The `window-all-closed` decision: quit only off macOS, and only when the
 *  user hasn't asked the process to keep running. */
export function shouldQuitWhenAllWindowsClosed(
	platform: NodeJS.Platform,
	prefs: BackgroundPrefs,
): boolean {
	return supportsCloseToTray(platform) && !prefs.keepRunning;
}

export class BackgroundPrefsStore {
	private current: BackgroundPrefs = { ...DEFAULT_BACKGROUND_PREFS };

	constructor(private readonly path: string) {}

	/** The last loaded / written value — synchronous for `window-all-closed`. */
	get cached(): BackgroundPrefs {
		return this.current;
	}

	async load(): Promise<BackgroundPrefs> {
		try {
			const raw = JSON.parse(await fs.readFile(this.path, "utf8")) as unknown;
			this.current = {
				keepRunning:
					!!raw && typeof raw === "object" && (raw as Record<string, unknown>).keepRunning === true,
			};
		} catch {
			this.current = { ...DEFAULT_BACKGROUND_PREFS };
		}
		return this.current;
	}

	async set(keepRunning: boolean): Promise<BackgroundPrefs> {
		const next: BackgroundPrefs = { keepRunning };
		await fs.mkdir(dirname(this.path), { recursive: true });
		await fs.writeFile(this.path, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
		this.current = next;
		return next;
	}
}
