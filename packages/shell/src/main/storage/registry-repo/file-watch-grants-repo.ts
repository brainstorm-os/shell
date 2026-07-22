/**
 * FileWatchGrantsRepository — CRUD on `registry.db.file_watch_grants` (11b.10).
 *
 * The durable backing for FileWatch automation triggers. File HANDLES are
 * session-only by design (`FileHandleRegistry` is in-memory — a vault close
 * re-grants, the user's pick is the audit trail), but an unattended FileWatch
 * trigger must keep firing after a reopen. So the user's explicit file pick
 * persists here as an opaque `watchId → (appId, path, mode)`; the automations
 * wiring re-resolves each `watchId` on vault open and re-mints a live session
 * handle to watch.
 *
 * Security invariant: the `path` is **shell-internal only** — it is never
 * returned to an app (the app holds the opaque `watchId` + a displayName).
 * `resolve` is fail-closed: an unknown / revoked `watchId` returns `null`.
 */

import { randomBytes } from "node:crypto";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { FileHandleMode } from "../../files/file-handle-registry";

/** A persisted file-watch grant. `path` never leaves the main process. */
export type FileWatchGrant = {
	watchId: string;
	appId: string;
	path: string;
	mode: FileHandleMode;
	createdAt: number;
};

/** The app-safe projection — displayName is the file's basename, no path. */
export type FileWatchGrantSummary = {
	watchId: string;
	displayName: string;
	createdAt: number;
};

type FileWatchGrantRow = {
	watch_id: string;
	app_id: string;
	path: string;
	mode: string;
	created_at: number;
};

const genWatchId = (): string => `fw_${randomBytes(18).toString("base64url")}`;

export class FileWatchGrantsRepository {
	constructor(
		private readonly db: SqliteDatabase,
		private readonly now: () => number = Date.now,
		private readonly genId: () => string = genWatchId,
	) {}

	/** Mint a persistent grant for `(appId, path, mode)`, or return the existing
	 *  `watchId` if that exact grant already exists (idempotent — the unique
	 *  index on `(app_id, path, mode)` keeps growth bounded). */
	mint(appId: string, path: string, mode: FileHandleMode): string {
		const existing = this.db
			.prepare("SELECT watch_id FROM file_watch_grants WHERE app_id = ? AND path = ? AND mode = ?")
			.get(appId, path, mode) as { watch_id: string } | undefined;
		if (existing) return existing.watch_id;
		const watchId = this.genId();
		this.db
			.prepare(
				`INSERT INTO file_watch_grants (watch_id, app_id, path, mode, created_at)
				VALUES (?, ?, ?, ?, ?)`,
			)
			.run(watchId, appId, path, mode, this.now());
		return watchId;
	}

	/** Resolve a `watchId` to its grant — **shell-internal only** (carries the
	 *  path). Scoped to `appId`: a grant minted for another app never resolves.
	 *  Fail-closed: unknown / revoked / cross-app → `null`. */
	resolve(watchId: string, appId: string): FileWatchGrant | null {
		const row = this.db
			.prepare("SELECT * FROM file_watch_grants WHERE watch_id = ? AND app_id = ?")
			.get(watchId, appId) as FileWatchGrantRow | undefined;
		return row ? fromRow(row) : null;
	}

	/** App-safe grant list (displayName only, no path) for the Settings revoke
	 *  panel. Newest first. */
	listByApp(appId: string): FileWatchGrantSummary[] {
		const rows = this.db
			.prepare("SELECT * FROM file_watch_grants WHERE app_id = ? ORDER BY created_at DESC")
			.all(appId) as FileWatchGrantRow[];
		return rows.map((r) => ({
			watchId: r.watch_id,
			displayName: basenameOf(r.path),
			createdAt: r.created_at,
		}));
	}

	/** Revoke a grant (Settings kill switch). Returns whether a row was removed. */
	revoke(watchId: string): boolean {
		const result = this.db.prepare("DELETE FROM file_watch_grants WHERE watch_id = ?").run(watchId);
		return Number(result.changes) > 0;
	}
}

function basenameOf(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] || path;
}

function fromRow(r: FileWatchGrantRow): FileWatchGrant {
	return {
		watchId: r.watch_id,
		appId: r.app_id,
		path: r.path,
		mode: r.mode === FileHandleMode.ReadWrite ? FileHandleMode.ReadWrite : FileHandleMode.Read,
		createdAt: r.created_at,
	};
}
