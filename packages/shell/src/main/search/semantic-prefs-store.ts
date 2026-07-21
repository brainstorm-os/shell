/**
 * 11.3 — semantic-search consent (app-global).
 *
 * The on-device embedding model (`bge-small-en-v1.5`, ~130 MB) is not
 * downloaded until the user opts in. This persists that decision at
 * `<userData>/semantic-prefs.json`. **App-level, not vault-level**: the model
 * cache lives in `<userData>/models` and is shared across every vault, so the
 * consent is a device decision, not a per-vault one (same reasoning as
 * `UpdatePrefsStore` / the feedback-settings store).
 *
 * Default is **not consented** — a fresh install runs lexical-only until the
 * user enables semantic search in Settings → Search. Defensive
 * default-on-corrupt: an unreadable/malformed file resolves to the default
 * and re-seeds, so the next read is clean.
 *
 * Pure file IO; the async API + load-race dedup mirror `UpdatePrefsStore`.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

const PREFS_FILE_NAME = "semantic-prefs.json";

export function semanticPrefsPath(userDataDir: string): string {
	return join(userDataDir, PREFS_FILE_NAME);
}

export type SemanticPrefs = {
	/** The user opted into the model download. Default `false` (lexical-only). */
	readonly consented: boolean;
};

export function defaultSemanticPrefs(): SemanticPrefs {
	return { consented: false };
}

export class SemanticPrefsStore {
	private cache: SemanticPrefs | null = null;
	private loading: Promise<SemanticPrefs> | null = null;
	private readonly path: string;

	constructor(options: { readonly path: string }) {
		this.path = options.path;
	}

	get cached(): SemanticPrefs | null {
		return this.cache;
	}

	async load(): Promise<SemanticPrefs> {
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

	async setConsent(consented: boolean): Promise<SemanticPrefs> {
		const next: SemanticPrefs = { consented };
		await this.writeToDisk(next);
		this.cache = next;
		return next;
	}

	private async readFromDisk(): Promise<SemanticPrefs> {
		let raw: string;
		try {
			raw = await fs.readFile(this.path, "utf8");
		} catch (_error) {
			const seeded = defaultSemanticPrefs();
			await this.writeToDisk(seeded);
			return seeded;
		}
		const validated = validatePrefs(safeJsonParse(raw));
		if (!validated) {
			const seeded = defaultSemanticPrefs();
			await this.writeToDisk(seeded);
			return seeded;
		}
		return validated;
	}

	private async writeToDisk(value: SemanticPrefs): Promise<void> {
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

function validatePrefs(input: unknown): SemanticPrefs | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const raw = input as Record<string, unknown>;
	if (typeof raw.consented !== "boolean") return null;
	return { consented: raw.consented };
}
