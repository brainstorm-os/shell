/**
 * Stage 10.13 — selective-sync policy store (app-global, per device).
 *
 * Persists the `SelectiveSyncPolicy` at `<userData>/selective-sync.json`.
 * **Per device, not per vault** — how much a given device chooses to sync is
 * a property of the device's storage/bandwidth, not the open vault (doc 20:
 * "policy parameters are user-configurable per device"). Same shape +
 * default-on-corrupt posture as `UpdatePrefsStore` / `FeedbackSettingsStore`.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_SELECTIVE_SYNC_POLICY,
	type SelectiveSyncPolicy,
	normalizeSelectiveSyncPolicy,
} from "@brainstorm-os/protocol/selective-sync-types";

const POLICY_FILE_NAME = "selective-sync.json";

export function selectiveSyncPolicyPath(userDataDir: string): string {
	return join(userDataDir, POLICY_FILE_NAME);
}

export class SelectiveSyncStore {
	private cache: SelectiveSyncPolicy | null = null;
	private loading: Promise<SelectiveSyncPolicy> | null = null;
	private readonly path: string;

	constructor(options: { readonly path: string }) {
		this.path = options.path;
	}

	/** The last-loaded policy without touching disk — the engine's per-edit
	 *  predicate reads this so it never blocks on IO. Null until first `load`. */
	get cached(): SelectiveSyncPolicy | null {
		return this.cache;
	}

	async load(): Promise<SelectiveSyncPolicy> {
		if (this.cache) return this.cache;
		if (this.loading) return await this.loading;
		this.loading = (async () => {
			const policy = await this.readFromDisk();
			this.cache = policy;
			this.loading = null;
			return policy;
		})();
		return await this.loading;
	}

	async set(input: unknown): Promise<SelectiveSyncPolicy> {
		const next = normalizeSelectiveSyncPolicy(input);
		await this.writeToDisk(next);
		this.cache = next;
		return next;
	}

	private async readFromDisk(): Promise<SelectiveSyncPolicy> {
		let raw: string;
		try {
			raw = await fs.readFile(this.path, "utf8");
		} catch (_error) {
			const seeded = { ...DEFAULT_SELECTIVE_SYNC_POLICY };
			await this.writeToDisk(seeded);
			return seeded;
		}
		return normalizeSelectiveSyncPolicy(safeJsonParse(raw));
	}

	private async writeToDisk(value: SelectiveSyncPolicy): Promise<void> {
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
