/**
 * IE-14 — scheduled backups with restore points.
 *
 * Owns the per-vault schedule (stored in `settings.db`: per device, encrypted
 * at rest — the folder is a path on THIS machine, so it must not sync), the
 * timer that runs it, the restore-point listing, and restore.
 *
 * - The timer checks once shortly after start (so an overdue backup runs on
 *   app launch) and then hourly; each check reads the ACTIVE vault's settings,
 *   so a vault switch needs no re-arming. Interval checks instead of one long
 *   timeout survive sleep and clock changes.
 * - A backup is the same whole-vault `.bsbundle` the manual export writes,
 *   written to `<name>.partial` and renamed into place, so a crash mid-write
 *   never leaves a truncated restore point. Retention then prunes the oldest.
 * - The bundle format has no encryption, so backups are exactly as private as
 *   the manual export: written only to a folder the user chose.
 * - Restore goes through the existing bundle import (`importVaultBundle`):
 *   objects missing from the vault come back, existing ones are left alone.
 */

import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	type BackupSettings,
	backupFileName,
	clampRetention,
	isBackupDue,
	isBackupFrequency,
	nextBackupDueAt,
	parseBackupFileName,
	parseBackupSettings,
	selectPrunable,
} from "./backup-schedule";
import type { ImportReport } from "./bundle-format";

export const BACKUP_SETTINGS_SCOPE = "brainstorm.shell/backups";
export const BACKUP_SETTINGS_KEY = "schedule";
export const BACKUP_FIRST_CHECK_MS = 60_000;
export const BACKUP_CHECK_INTERVAL_MS = 60 * 60_000;
const PARTIAL_SUFFIX = ".partial";

export type BackupSettingsStore = {
	get(appId: string, key: string): string | null;
	set(appId: string, key: string, value: string): void;
};

/** What the service needs from the active vault. */
export type BackupVault = {
	readonly vaultId: string;
	readonly settings: BackupSettingsStore;
	/** A finished whole-vault bundle (null = the export was cancelled). */
	exportBundle(): Promise<Uint8Array | null>;
	importBundle(bytes: Uint8Array): Promise<ImportReport>;
};

export type BackupStatus = BackupSettings & {
	readonly nextDueAt: number | null;
	readonly running: boolean;
};

export type RestorePoint = {
	readonly name: string;
	readonly createdAt: number;
	readonly bytes: number;
};

export type BackupServiceDeps = {
	getVault: () => Promise<BackupVault | null>;
	now?: () => number;
	/** After a restore wrote objects (search reindex etc.). */
	onRestored?: () => Promise<void> | void;
	setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
	clearInterval?: (handle: unknown) => void;
	setTimeout?: (fn: () => void, ms: number) => { unref?: () => void };
	clearTimeout?: (handle: unknown) => void;
};

export class BackupService {
	private running = false;
	/** The run in progress. A second caller (Run now during a scheduled run, or
	 *  a double click) joins it instead of getting an early "running" status
	 *  that lands after the real result. */
	private inflight: Promise<BackupStatus> | null = null;
	private timers: { first: unknown; interval: unknown } | null = null;

	constructor(private readonly deps: BackupServiceDeps) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private read(vault: BackupVault): BackupSettings {
		return parseBackupSettings(vault.settings.get(BACKUP_SETTINGS_SCOPE, BACKUP_SETTINGS_KEY));
	}

	private write(vault: BackupVault, settings: BackupSettings): void {
		vault.settings.set(BACKUP_SETTINGS_SCOPE, BACKUP_SETTINGS_KEY, JSON.stringify(settings));
	}

	private status(settings: BackupSettings): BackupStatus {
		return { ...settings, nextDueAt: nextBackupDueAt(settings), running: this.running };
	}

	async getStatus(): Promise<BackupStatus | null> {
		const vault = await this.deps.getVault();
		return vault ? this.status(this.read(vault)) : null;
	}

	/** Update frequency / retention. Unknown values are ignored, never stored. */
	async updateSchedule(patch: {
		frequency?: unknown;
		retention?: unknown;
	}): Promise<BackupStatus | null> {
		const vault = await this.deps.getVault();
		if (!vault) return null;
		const current = this.read(vault);
		const next: BackupSettings = {
			...current,
			...(isBackupFrequency(patch.frequency) ? { frequency: patch.frequency } : {}),
			...(patch.retention !== undefined ? { retention: clampRetention(patch.retention) } : {}),
		};
		this.write(vault, next);
		return this.status(next);
	}

	async setFolder(folder: string): Promise<BackupStatus | null> {
		const vault = await this.deps.getVault();
		if (!vault) return null;
		const next: BackupSettings = { ...this.read(vault), folder, lastError: null };
		this.write(vault, next);
		return this.status(next);
	}

	/** Run a backup now when one is due (the timer's entry point). */
	async runIfDue(): Promise<BackupStatus | null> {
		const vault = await this.deps.getVault();
		if (!vault) return null;
		const settings = this.read(vault);
		if (!isBackupDue(settings, this.now())) return this.status(settings);
		return this.runBackup(vault);
	}

	/** Run a backup immediately, schedule or not (needs a folder). */
	async runNow(): Promise<BackupStatus | null> {
		const vault = await this.deps.getVault();
		return vault ? this.runBackup(vault) : null;
	}

	private runBackup(vault: BackupVault): Promise<BackupStatus> {
		if (this.inflight) return this.inflight;
		const settings = this.read(vault);
		if (settings.folder === null) return Promise.resolve(this.status(settings));
		const run = this.doRunBackup(vault, settings, settings.folder)
			.then((done) => this.status(done))
			.finally(() => {
				this.inflight = null;
			});
		this.inflight = run;
		return run;
	}

	private async doRunBackup(
		vault: BackupVault,
		settings: BackupSettings,
		folder: string,
	): Promise<BackupSettings> {
		this.running = true;
		let partial: string | null = null;
		try {
			const bytes = await vault.exportBundle();
			if (bytes === null) return this.read(vault);
			const at = this.now();
			const target = join(folder, backupFileName(vault.vaultId, at));
			partial = `${target}${PARTIAL_SUFFIX}`;
			// `wx` = O_CREAT|O_EXCL: never opens through a symlink planted at the
			// partial's name. A stale partial from a crashed run is unlinked
			// first (`rm` removes a link itself, never its target).
			await rm(partial, { force: true });
			await writeFile(partial, bytes, { flag: "wx" });
			await rename(partial, target);
			partial = null;
			await this.prune(folder, vault.vaultId, settings.retention);
			const next: BackupSettings = { ...this.read(vault), lastBackupAt: at, lastError: null };
			this.write(vault, next);
			return next;
		} catch (error) {
			if (partial !== null) await rm(partial, { force: true }).catch(() => undefined);
			const message = error instanceof Error ? error.message : String(error);
			console.warn("[brainstorm] scheduled backup failed:", error);
			const failed: BackupSettings = { ...this.read(vault), lastError: message };
			this.write(vault, failed);
			return failed;
		} finally {
			this.running = false;
		}
	}

	private async prune(folder: string, vaultId: string, retention: number): Promise<void> {
		const names = await readdir(folder);
		for (const name of selectPrunable(names, vaultId, retention)) {
			await rm(join(folder, name), { force: true });
		}
	}

	/** This vault's restore points in the backup folder, newest first. */
	async listRestorePoints(): Promise<RestorePoint[]> {
		const vault = await this.deps.getVault();
		if (!vault) return [];
		const { folder } = this.read(vault);
		if (folder === null) return [];
		let names: string[];
		try {
			names = await readdir(folder);
		} catch {
			return [];
		}
		const points: RestorePoint[] = [];
		for (const name of names) {
			const createdAt = parseBackupFileName(name, vault.vaultId);
			if (createdAt === null) continue;
			try {
				points.push({ name, createdAt, bytes: (await stat(join(folder, name))).size });
			} catch {
				// Removed between the listing and the stat — skip it.
			}
		}
		return points.sort((a, b) => b.createdAt - a.createdAt);
	}

	/** Restore one of this vault's restore points by file name. Anything that is
	 *  not a bare name of this vault's backup pattern is refused, so the call
	 *  can never be steered at another path. */
	async restore(name: unknown): Promise<ImportReport> {
		const vault = await this.deps.getVault();
		if (!vault) throw new Error("backup: no active vault");
		if (
			typeof name !== "string" ||
			basename(name) !== name ||
			parseBackupFileName(name, vault.vaultId) === null
		) {
			throw new Error("backup: not a restore point of this vault");
		}
		const { folder } = this.read(vault);
		if (folder === null) throw new Error("backup: no backup folder is set");
		const bytes = await readFile(join(folder, name));
		const report = await vault.importBundle(new Uint8Array(bytes));
		await this.deps.onRestored?.();
		return report;
	}

	start(): void {
		if (this.timers) return;
		const set = this.deps.setInterval ?? globalThis.setInterval;
		const once = this.deps.setTimeout ?? globalThis.setTimeout;
		const check = (): void => {
			void this.runIfDue().catch((error: unknown) => {
				console.warn("[brainstorm] backup check failed:", error);
			});
		};
		const first = once(check, BACKUP_FIRST_CHECK_MS);
		const interval = set(check, BACKUP_CHECK_INTERVAL_MS);
		first.unref?.();
		interval.unref?.();
		this.timers = { first, interval };
	}

	stop(): void {
		if (!this.timers) return;
		(this.deps.clearTimeout ?? globalThis.clearTimeout)(this.timers.first as never);
		(this.deps.clearInterval ?? globalThis.clearInterval)(this.timers.interval as never);
		this.timers = null;
	}
}
