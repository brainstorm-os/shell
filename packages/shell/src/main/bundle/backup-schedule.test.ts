import { describe, expect, it } from "vitest";
import {
	BackupFrequency,
	type BackupSettings,
	DEFAULT_BACKUP_SETTINGS,
	MAX_BACKUP_RETENTION,
	backupFileName,
	clampRetention,
	isBackupDue,
	nextBackupDueAt,
	parseBackupFileName,
	parseBackupSettings,
	selectPrunable,
} from "./backup-schedule";

const DAY = 24 * 60 * 60 * 1000;
const VAULT = "vlt_01J8ZQ";
const on = (over: Partial<BackupSettings>): BackupSettings => ({
	...DEFAULT_BACKUP_SETTINGS,
	frequency: BackupFrequency.Daily,
	folder: "/backups",
	...over,
});

describe("due math", () => {
	it("is never due while off or without a folder", () => {
		expect(nextBackupDueAt(DEFAULT_BACKUP_SETTINGS)).toBeNull();
		expect(nextBackupDueAt(on({ folder: null }))).toBeNull();
		expect(isBackupDue(on({ frequency: BackupFrequency.Off }), 10 * DAY)).toBe(false);
	});

	it("is due immediately when there has never been a backup (overdue on first start)", () => {
		expect(nextBackupDueAt(on({ lastBackupAt: null }))).toBe(0);
		expect(isBackupDue(on({ lastBackupAt: null }), 1)).toBe(true);
	});

	it("adds one interval to the last backup, daily and weekly", () => {
		const last = 1_000 * DAY;
		expect(nextBackupDueAt(on({ lastBackupAt: last }))).toBe(last + DAY);
		expect(nextBackupDueAt(on({ frequency: BackupFrequency.Weekly, lastBackupAt: last }))).toBe(
			last + 7 * DAY,
		);
		expect(isBackupDue(on({ lastBackupAt: last }), last + DAY - 1)).toBe(false);
		expect(isBackupDue(on({ lastBackupAt: last }), last + DAY)).toBe(true);
		expect(isBackupDue(on({ lastBackupAt: last }), last + 30 * DAY)).toBe(true);
	});
});

describe("settings persistence shape", () => {
	it("round-trips through JSON", () => {
		const settings = on({ retention: 12, lastBackupAt: 5, lastError: "disk full" });
		expect(parseBackupSettings(JSON.stringify(settings))).toEqual(settings);
	});

	it("reads missing, corrupt and hostile values as safe defaults", () => {
		expect(parseBackupSettings(null)).toEqual(DEFAULT_BACKUP_SETTINGS);
		expect(parseBackupSettings("{oops")).toEqual(DEFAULT_BACKUP_SETTINGS);
		expect(parseBackupSettings("[]")).toEqual(DEFAULT_BACKUP_SETTINGS);
		expect(
			parseBackupSettings(
				JSON.stringify({ frequency: "hourly", folder: "", retention: 9999, lastBackupAt: "x" }),
			),
		).toEqual({ ...DEFAULT_BACKUP_SETTINGS, retention: MAX_BACKUP_RETENTION });
	});

	it("clamps retention into range", () => {
		expect(clampRetention(0)).toBe(1);
		expect(clampRetention(3.6)).toBe(4);
		expect(clampRetention("7")).toBe(7);
		expect(clampRetention(1e9)).toBe(MAX_BACKUP_RETENTION);
	});
});

describe("file names + retention pruning", () => {
	const at = Date.UTC(2026, 9, 18, 3, 4, 5);

	it("names files by vault + UTC stamp and parses them back", () => {
		const name = backupFileName(VAULT, at);
		expect(name).toBe(`brainstorm-backup-${VAULT}-20261018-030405.bsbundle`);
		expect(parseBackupFileName(name, VAULT)).toBe(at);
		expect(parseBackupFileName(name, "vlt_OTHER")).toBeNull();
		expect(parseBackupFileName(`${name}.partial`, VAULT)).toBeNull();
		expect(parseBackupFileName("my-notes.bsbundle", VAULT)).toBeNull();
	});

	it("keeps the newest N of this vault's backups and never touches other files", () => {
		const names = [0, 1, 2, 3, 4].map((d) => backupFileName(VAULT, at + d * DAY));
		const foreign = [backupFileName("vlt_OTHER", at), "holiday.bsbundle", "notes.txt"];
		const prunable = selectPrunable([...foreign, ...names], VAULT, 2);
		expect(prunable.sort()).toEqual(names.slice(0, 3).sort());
		expect(selectPrunable(names, VAULT, 10)).toEqual([]);
	});
});
