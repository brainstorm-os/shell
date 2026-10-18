import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataStores } from "../storage/data-stores";
import { SettingsRepository } from "../storage/settings-repo";
import { BackupFrequency, backupFileName } from "./backup-schedule";
import {
	BACKUP_CHECK_INTERVAL_MS,
	BACKUP_FIRST_CHECK_MS,
	BACKUP_SETTINGS_KEY,
	BACKUP_SETTINGS_SCOPE,
	BackupService,
	type BackupVault,
} from "./backup-service";

const VAULT = "vlt_TEST";
const DAY = 24 * 60 * 60 * 1000;
const REPORT = { created: 2, skipped: 1, failed: [], linksRestored: 0, assetsWritten: 0 };

describe("BackupService", () => {
	let vaultDir: string;
	let folder: string;
	let stores: DataStores;
	let settings: SettingsRepository;
	let clock: number;
	let exportBundle: ReturnType<typeof vi.fn<() => Promise<Uint8Array | null>>>;
	let importBundle: ReturnType<typeof vi.fn<(bytes: Uint8Array) => Promise<typeof REPORT>>>;
	let onRestored: ReturnType<typeof vi.fn<() => void>>;
	let service: BackupService;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-backup-vault-"));
		folder = await mkdtemp(join(tmpdir(), "bs-backup-folder-"));
		stores = new DataStores(vaultDir);
		settings = new SettingsRepository(await stores.open("settings"));
		clock = Date.UTC(2026, 9, 18, 12, 0, 0);
		exportBundle = vi.fn(async () => new Uint8Array([1, 2, 3]));
		importBundle = vi.fn(async () => REPORT);
		onRestored = vi.fn<() => void>();
		const vault: BackupVault = { vaultId: VAULT, settings, exportBundle, importBundle };
		service = new BackupService({ getVault: async () => vault, now: () => clock, onRestored });
	});
	afterEach(async () => {
		service.stop();
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
		await rm(folder, { recursive: true, force: true });
	});

	it("persists the schedule in settings.db and survives a new service instance", async () => {
		await service.setFolder(folder);
		await service.updateSchedule({ frequency: BackupFrequency.Weekly, retention: 3 });
		await service.updateSchedule({ frequency: "hourly", retention: undefined });
		const raw = settings.get(BACKUP_SETTINGS_SCOPE, BACKUP_SETTINGS_KEY);
		expect(JSON.parse(raw ?? "{}")).toMatchObject({ frequency: "weekly", retention: 3, folder });
		const fresh = new BackupService({
			getVault: async () => ({ vaultId: VAULT, settings, exportBundle, importBundle }),
		});
		expect(await fresh.getStatus()).toMatchObject({
			frequency: BackupFrequency.Weekly,
			retention: 3,
		});
	});

	it("runs only when due, writes atomically and records the time", async () => {
		await service.setFolder(folder);
		expect((await service.runIfDue())?.lastBackupAt).toBeNull();
		expect(exportBundle).not.toHaveBeenCalled();

		await service.updateSchedule({ frequency: BackupFrequency.Daily });
		const first = await service.runIfDue();
		expect(first?.lastBackupAt).toBe(clock);
		expect(first?.nextDueAt).toBe(clock + DAY);
		expect(await readdir(folder)).toEqual([backupFileName(VAULT, clock)]);

		clock += DAY - 1;
		await service.runIfDue();
		expect(exportBundle).toHaveBeenCalledTimes(1);
		clock += 1;
		await service.runIfDue();
		expect(exportBundle).toHaveBeenCalledTimes(2);
	});

	it("prunes past the retention count, leaving unrelated files alone", async () => {
		await service.setFolder(folder);
		await service.updateSchedule({ frequency: BackupFrequency.Daily, retention: 2 });
		await writeFile(join(folder, "keep-me.bsbundle"), "x");
		for (let i = 0; i < 4; i += 1) {
			await service.runNow();
			clock += DAY;
		}
		const names = (await readdir(folder)).sort();
		expect(names).toHaveLength(3);
		expect(names).toContain("keep-me.bsbundle");
		const points = await service.listRestorePoints();
		expect(points.map((p) => p.createdAt)).toEqual([clock - DAY, clock - 2 * DAY]);
		expect(points[0]?.bytes).toBe(3);
	});

	it("records a failure and clears it on the next success", async () => {
		await service.setFolder(folder);
		exportBundle.mockRejectedValueOnce(new Error("disk full"));
		expect((await service.runNow())?.lastError).toBe("disk full");
		expect(await readdir(folder)).toEqual([]);
		expect((await service.runNow())?.lastError).toBeNull();
	});

	it("restores only this vault's restore points by bare name", async () => {
		await service.setFolder(folder);
		await service.runNow();
		const [point] = await service.listRestorePoints();
		expect(await service.restore(point?.name)).toEqual(REPORT);
		expect(importBundle).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
		expect(onRestored).toHaveBeenCalledTimes(1);
		await expect(service.restore(`../${point?.name}`)).rejects.toThrow(/not a restore point/);
		await expect(service.restore(backupFileName("vlt_OTHER", clock))).rejects.toThrow();
		await expect(service.restore(42)).rejects.toThrow();
	});

	it("checks soon after start (overdue on launch) and then hourly", async () => {
		const timeouts: Array<[() => void, number]> = [];
		const intervals: Array<[() => void, number]> = [];
		const runIfDue = vi.fn(async () => null);
		const timed = new BackupService({
			getVault: async () => null,
			setTimeout: (fn, ms) => {
				timeouts.push([fn, ms]);
				return {};
			},
			setInterval: (fn, ms) => {
				intervals.push([fn, ms]);
				return {};
			},
			clearTimeout: () => {},
			clearInterval: () => {},
		});
		timed.runIfDue = runIfDue;
		timed.start();
		timed.start();
		expect(timeouts.map(([, ms]) => ms)).toEqual([BACKUP_FIRST_CHECK_MS]);
		expect(intervals.map(([, ms]) => ms)).toEqual([BACKUP_CHECK_INTERVAL_MS]);
		timeouts[0]?.[0]();
		intervals[0]?.[0]();
		expect(runIfDue).toHaveBeenCalledTimes(2);
		timed.stop();
	});

	it("does nothing without an active vault", async () => {
		const idle = new BackupService({ getVault: async () => null });
		expect(await idle.getStatus()).toBeNull();
		expect(await idle.runNow()).toBeNull();
		expect(await idle.listRestorePoints()).toEqual([]);
		await expect(idle.restore("x")).rejects.toThrow(/no active vault/);
	});
});
