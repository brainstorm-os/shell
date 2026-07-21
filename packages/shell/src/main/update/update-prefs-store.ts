/**
 * 13.6 — update preferences store (app-global).
 *
 * Persists `{channel, lastCheckedAt}` at `<userData>/update-prefs.json`.
 * **App-level, not vault-level**: which release track the install follows
 * is about the app binary, not the open vault (same reasoning as the
 * feedback-settings store). Defensive default-on-corrupt: an unreadable
 * or malformed file resolves to defaults (Stable channel, never checked)
 * and re-seeds, so the next read is clean.
 *
 * Pure file IO; the async API + load-race dedup mirror
 * `feedback-settings-store`.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
	UpdateChannel,
	type UpdatePrefs,
	toUpdateChannel,
} from "@brainstorm-os/protocol/update-wire-types";

const PREFS_FILE_NAME = "update-prefs.json";

export function updatePrefsPath(userDataDir: string): string {
	return join(userDataDir, PREFS_FILE_NAME);
}

export function defaultUpdatePrefs(): UpdatePrefs {
	return { channel: UpdateChannel.Stable, lastCheckedAt: null };
}

export type UpdatePrefsPatch = {
	readonly channel?: UpdateChannel;
	readonly lastCheckedAt?: string | null;
};

export class UpdatePrefsStore {
	private cache: UpdatePrefs | null = null;
	private loading: Promise<UpdatePrefs> | null = null;
	private readonly path: string;

	constructor(options: { readonly path: string }) {
		this.path = options.path;
	}

	get cached(): UpdatePrefs | null {
		return this.cache;
	}

	async load(): Promise<UpdatePrefs> {
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

	async patch(input: UpdatePrefsPatch): Promise<UpdatePrefs> {
		const current = await this.load();
		const next: UpdatePrefs = {
			channel: input.channel ?? current.channel,
			lastCheckedAt: input.lastCheckedAt === undefined ? current.lastCheckedAt : input.lastCheckedAt,
		};
		await this.writeToDisk(next);
		this.cache = next;
		return next;
	}

	private async readFromDisk(): Promise<UpdatePrefs> {
		let raw: string;
		try {
			raw = await fs.readFile(this.path, "utf8");
		} catch (_error) {
			const seeded = defaultUpdatePrefs();
			await this.writeToDisk(seeded);
			return seeded;
		}
		const validated = validatePrefs(safeJsonParse(raw));
		if (!validated) {
			const seeded = defaultUpdatePrefs();
			await this.writeToDisk(seeded);
			return seeded;
		}
		return validated;
	}

	private async writeToDisk(value: UpdatePrefs): Promise<void> {
		await fs.mkdir(dirname(this.path), { recursive: true });
		await fs.writeFile(this.path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	}
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (_error) {
		return null;
	}
}

function validatePrefs(input: unknown): UpdatePrefs | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const raw = input as Record<string, unknown>;
	const channel = toUpdateChannel(raw.channel);
	let lastCheckedAt: string | null = null;
	if (typeof raw.lastCheckedAt === "string" && raw.lastCheckedAt.length > 0) {
		lastCheckedAt = raw.lastCheckedAt;
	}
	return { channel, lastCheckedAt };
}
