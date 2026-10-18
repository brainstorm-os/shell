/**
 * IE-14 — scheduled-backup policy, pure: when a backup is due, what the files
 * are called, and which old ones retention removes. No I/O here; the
 * {@link BackupService} applies it.
 *
 * A backup is a whole-vault `.bsbundle` (the IE-1 format, unchanged) named
 * `brainstorm-backup-<vaultId>-<UTC stamp>.bsbundle`. The vault id in the name
 * keeps two vaults backing up into one folder apart: listing, restoring and
 * pruning only ever touch the active vault's files, and a file the user put
 * there by hand never matches the pattern, so retention cannot delete it.
 */

import { BackupFrequency } from "../../shared/backup-frequency";

export { BackupFrequency };

export const DEFAULT_BACKUP_RETENTION = 7;
export const MIN_BACKUP_RETENTION = 1;
export const MAX_BACKUP_RETENTION = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS: Record<BackupFrequency, number | null> = {
	[BackupFrequency.Off]: null,
	[BackupFrequency.Daily]: DAY_MS,
	[BackupFrequency.Weekly]: 7 * DAY_MS,
};

export type BackupSettings = {
	readonly frequency: BackupFrequency;
	/** Absolute folder the bundles go to; null until the user picks one. */
	readonly folder: string | null;
	/** How many of this vault's backups to keep (newest first). */
	readonly retention: number;
	readonly lastBackupAt: number | null;
	/** The last scheduled run's failure, cleared by the next success. */
	readonly lastError: string | null;
};

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
	frequency: BackupFrequency.Off,
	folder: null,
	retention: DEFAULT_BACKUP_RETENTION,
	lastBackupAt: null,
	lastError: null,
};

const FREQUENCIES = new Set<string>(Object.values(BackupFrequency));

export function clampRetention(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BACKUP_RETENTION;
	return Math.min(MAX_BACKUP_RETENTION, Math.max(MIN_BACKUP_RETENTION, Math.round(value)));
}

export function isBackupFrequency(value: unknown): value is BackupFrequency {
	return typeof value === "string" && FREQUENCIES.has(value);
}

/** Settings from their stored JSON; anything missing or malformed falls back
 *  to the default, so a corrupt row reads as "off" — never as a schedule
 *  writing to a garbage path. */
export function parseBackupSettings(raw: string | null): BackupSettings {
	if (raw === null) return DEFAULT_BACKUP_SETTINGS;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_BACKUP_SETTINGS;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_BACKUP_SETTINGS;
	const r = parsed as Record<string, unknown>;
	const finite = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) ? v : null;
	return {
		frequency: isBackupFrequency(r.frequency) ? r.frequency : BackupFrequency.Off,
		folder: typeof r.folder === "string" && r.folder.length > 0 ? r.folder : null,
		retention: clampRetention(r.retention),
		lastBackupAt: finite(r.lastBackupAt),
		lastError: typeof r.lastError === "string" ? r.lastError : null,
	};
}

/** When the next scheduled backup is due (ms), or null when the schedule is
 *  off or has no folder. Never backed up ⇒ due immediately (`0`). */
export function nextBackupDueAt(settings: BackupSettings): number | null {
	const interval = INTERVAL_MS[settings.frequency];
	if (interval === null || settings.folder === null) return null;
	return settings.lastBackupAt === null ? 0 : settings.lastBackupAt + interval;
}

export function isBackupDue(settings: BackupSettings, now: number): boolean {
	const due = nextBackupDueAt(settings);
	return due !== null && now >= due;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function stamp(at: number): string {
	const d = new Date(at);
	return (
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
		`${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
	);
}

const PREFIX = "brainstorm-backup-";
const EXTENSION = ".bsbundle";
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

export function backupFileName(vaultId: string, at: number): string {
	return `${PREFIX}${vaultId}-${stamp(at)}${EXTENSION}`;
}

/** The backup's timestamp when `name` is one of `vaultId`'s backup files,
 *  else null. */
export function parseBackupFileName(name: string, vaultId: string): number | null {
	const head = `${PREFIX}${vaultId}-`;
	if (!name.startsWith(head) || !name.endsWith(EXTENSION)) return null;
	const m = STAMP_RE.exec(name.slice(head.length, -EXTENSION.length));
	if (!m) return null;
	const [, y, mo, d, h, mi, s] = m.map(Number);
	const at = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
	return Number.isFinite(at) ? at : null;
}

/** The names retention removes: everything past the newest `retention` of
 *  this vault's backups. Files that are not this vault's backups are never
 *  candidates. */
export function selectPrunable(
	names: readonly string[],
	vaultId: string,
	retention: number,
): string[] {
	const keep = clampRetention(retention);
	return names
		.map((name) => ({ name, at: parseBackupFileName(name, vaultId) }))
		.filter((f): f is { name: string; at: number } => f.at !== null)
		.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1))
		.slice(keep)
		.map((f) => f.name);
}
