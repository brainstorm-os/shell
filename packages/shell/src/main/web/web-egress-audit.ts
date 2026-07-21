/**
 * Browser-7 — per-host egress aggregate for the browser engine.
 *
 * The locked web session sees every page subresource request
 * (`onBeforeRequest`); this module folds them into a bounded per-host
 * aggregate — host · request count · blocked count · last-seen — the
 * Settings → Privacy panel renders. Deliberately **not** the JSONL
 * audit-log (`network/audit-log.ts`): a single page load fires hundreds of
 * subresource requests, and per-request rows would drown the broker's
 * "Recent requests" table; doc-38 logging hygiene also wants no per-URL
 * trail of browsing. Hosts only, aggregated.
 *
 * Pure core with injected persistence — testable under Bun. Flush is
 * debounced (page loads burst); `dispose()` flushes synchronously-best-effort.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WebEgressHostSummary } from "@brainstorm-os/protocol/web-privacy-wire-types";

export const WEB_EGRESS_FILENAME = "web-egress-audit.json";

export function webEgressPath(vaultPath: string): string {
	return join(vaultPath, "shell", WEB_EGRESS_FILENAME);
}

/** Aggregate size bound — past it the least-recently-seen hosts evict. */
export const DEFAULT_MAX_HOSTS = 500;

/** Debounce for the persistence flush — page loads burst requests. */
export const DEFAULT_FLUSH_MS = 5_000;

function isValidRow(input: unknown): input is WebEgressHostSummary {
	if (!input || typeof input !== "object") return false;
	const raw = input as Record<string, unknown>;
	if (typeof raw.host !== "string" || raw.host.length === 0) return false;
	if (typeof raw.count !== "number" || !Number.isFinite(raw.count)) return false;
	if (typeof raw.blockedCount !== "number" || !Number.isFinite(raw.blockedCount)) return false;
	if (typeof raw.lastSeenMs !== "number" || !Number.isFinite(raw.lastSeenMs)) return false;
	return true;
}

export function parseWebEgressRows(input: unknown): WebEgressHostSummary[] {
	if (!Array.isArray(input)) return [];
	return input.filter(isValidRow);
}

export type WebEgressAuditOptions = {
	save: (rows: readonly WebEgressHostSummary[]) => Promise<void> | void;
	maxHosts?: number;
	flushMs?: number;
	now?: () => number;
	/** Injected timer pair (tests pass fakes). Defaults to global timers. */
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

type HostBucket = { count: number; blockedCount: number; lastSeenMs: number };

export class WebEgressAudit {
	private readonly hosts = new Map<string, HostBucket>();
	private readonly maxHosts: number;
	private readonly flushMs: number;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
	private pendingFlush: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(
		private readonly options: WebEgressAuditOptions,
		seed: readonly WebEgressHostSummary[] = [],
	) {
		this.maxHosts = options.maxHosts ?? DEFAULT_MAX_HOSTS;
		this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
		for (const row of seed) {
			this.hosts.set(row.host, {
				count: row.count,
				blockedCount: row.blockedCount,
				lastSeenMs: row.lastSeenMs,
			});
		}
	}

	/** Additive merge of a persisted snapshot — used when the file read lands
	 *  after the audit already started recording (the runtime's lazy-load
	 *  window). Counts add; `lastSeenMs` keeps the max. */
	mergeSeed(rows: readonly WebEgressHostSummary[]): void {
		if (this.disposed) return;
		for (const row of rows) {
			const key = row.host.toLowerCase();
			const bucket = this.hosts.get(key) ?? { count: 0, blockedCount: 0, lastSeenMs: 0 };
			bucket.count += row.count;
			bucket.blockedCount += row.blockedCount;
			bucket.lastSeenMs = Math.max(bucket.lastSeenMs, row.lastSeenMs);
			this.hosts.set(key, bucket);
		}
		this.evictPastCap();
	}

	record(host: string, blocked: boolean): void {
		if (this.disposed || host.length === 0) return;
		const key = host.toLowerCase();
		const bucket = this.hosts.get(key) ?? { count: 0, blockedCount: 0, lastSeenMs: 0 };
		if (blocked) bucket.blockedCount += 1;
		else bucket.count += 1;
		bucket.lastSeenMs = this.now();
		this.hosts.set(key, bucket);
		this.evictPastCap();
		this.scheduleFlush();
	}

	/** Rows sorted most-contacted-first, capped at `limit`. */
	summary(limit = 200): WebEgressHostSummary[] {
		return [...this.hosts.entries()]
			.map(([host, bucket]) => ({ host, ...bucket }))
			.sort(
				(a, b) => b.count + b.blockedCount - (a.count + a.blockedCount) || b.lastSeenMs - a.lastSeenMs,
			)
			.slice(0, Math.max(0, limit));
	}

	async flush(): Promise<void> {
		if (this.pendingFlush !== null) {
			this.clearTimer(this.pendingFlush);
			this.pendingFlush = null;
		}
		try {
			await this.options.save(this.snapshotAll());
		} catch (error) {
			console.warn(`[web/egress] flush failed: ${(error as Error).message}`);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		await this.flush();
		this.disposed = true;
	}

	private snapshotAll(): WebEgressHostSummary[] {
		return [...this.hosts.entries()].map(([host, bucket]) => ({ host, ...bucket }));
	}

	private evictPastCap(): void {
		let over = this.hosts.size - this.maxHosts;
		if (over <= 0) return;
		const oldest = [...this.hosts.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
		for (const [host] of oldest) {
			if (over <= 0) break;
			this.hosts.delete(host);
			over -= 1;
		}
	}

	private scheduleFlush(): void {
		if (this.pendingFlush !== null) return;
		this.pendingFlush = this.setTimer(() => {
			this.pendingFlush = null;
			void this.flush();
		}, this.flushMs);
	}
}

export async function readWebEgressRows(vaultPath: string): Promise<WebEgressHostSummary[]> {
	try {
		const raw = await readFile(webEgressPath(vaultPath), "utf8");
		return parseWebEgressRows(JSON.parse(raw));
	} catch {
		return [];
	}
}

export async function writeWebEgressRows(
	vaultPath: string,
	rows: readonly WebEgressHostSummary[],
): Promise<void> {
	const path = webEgressPath(vaultPath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(rows)}\n`, "utf8");
}
