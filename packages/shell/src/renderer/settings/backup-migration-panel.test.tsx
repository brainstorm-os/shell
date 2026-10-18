/**
 * `<BackupMigrationPanel>` (IE-3) — SSR-rendered smoke test. The panel is
 * click-driven (no mount effects), so static render exercises the idle layout:
 * the export action + the import file-pick affordance + the section summary,
 * all resolving through `t()`. Deeper flow coverage lives in the
 * `import-export-handlers` integration test.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackupFrequency } from "../../shared/backup-frequency";
import {
	BackupMigrationPanel,
	ImportDoneState,
	backupScheduleLines,
} from "./backup-migration-panel";
import { SettingsSection } from "./sections";

describe("BackupMigrationPanel", () => {
	it("renders the export + import entry points", () => {
		const html = renderToStaticMarkup(<BackupMigrationPanel />);
		expect(html).toContain("backup-migration-panel");
		expect(html).toContain("backup-migration-export-btn");
		expect(html).toContain("backup-migration-import-pick");
		// Strings resolved, not raw t() keys.
		expect(html).not.toContain("shell.settings.backupMigration");
	});

	it("gives Export the only primary face; import entry points are neutral (F-415)", () => {
		const html = renderToStaticMarkup(<BackupMigrationPanel />);
		// Export vault is the headline action — filled primary.
		const exportIdx = html.indexOf('data-testid="backup-migration-export-btn"');
		expect(exportIdx).toBeGreaterThan(-1);
		// The button opens just before its testid; walk back to the nearest class=.
		const exportOpen = html.lastIndexOf("<button", exportIdx);
		const exportTag = html.slice(exportOpen, exportIdx);
		expect(exportTag).toContain("button--primary");

		// Import / Obsidian / Anytype / Notion entry points are quieter neutrals.
		for (const id of [
			"backup-migration-import-pick",
			"backup-migration-obsidian-pick",
			"backup-migration-anytype-pick",
			"backup-migration-notion-pick",
			"backup-migration-markdown-btn",
			"backup-migration-schedule-folder",
		]) {
			const idx = html.indexOf(`data-testid="${id}"`);
			expect(idx).toBeGreaterThan(-1);
			const open = html.lastIndexOf("<button", idx);
			const tag = html.slice(open, idx);
			expect(tag).toContain("button--neutral");
			expect(tag).not.toContain("button--primary");
		}
	});

	it("renders the scheduled-backup controls disabled until a folder is chosen (IE-14)", () => {
		const html = renderToStaticMarkup(<BackupMigrationPanel />);
		expect(html).toContain("backup-migration-schedule");
		const idx = html.indexOf('data-testid="backup-migration-schedule-run"');
		const tag = html.slice(html.lastIndexOf("<button", idx), idx);
		expect(tag).toContain("disabled");
		expect(html).not.toContain("backup-migration-restore-points");
	});

	it("summarises last / next / failed runs (IE-14)", () => {
		const base = {
			frequency: BackupFrequency.Daily,
			folder: "/b",
			retention: 7,
			lastBackupAt: null,
			lastError: null,
			nextDueAt: 0,
			running: false,
		};
		expect(backupScheduleLines(base)).toEqual(["No backup yet", "next within the hour"]);
		const ran = backupScheduleLines({
			...base,
			lastBackupAt: Date.UTC(2026, 0, 1),
			nextDueAt: Date.UTC(2026, 0, 2),
			lastError: "disk full",
		});
		expect(ran).toHaveLength(3);
		expect(ran[0]).toMatch(/^Last backup /);
		expect(ran[2]).toBe("last attempt failed: disk full");
		expect(backupScheduleLines({ ...base, frequency: BackupFrequency.Off, nextDueAt: null })).toEqual(
			["No backup yet"],
		);
	});

	it("registers a stable section enum value", () => {
		expect(SettingsSection.BackupMigration).toBe("backup-migration");
	});
});

describe("ImportDoneState (F-395)", () => {
	it("always offers a run-again affordance on the done state", () => {
		const html = renderToStaticMarkup(
			<ImportDoneState
				report={{ created: 0, updated: 49, skipped: 0, failed: [] }}
				onAgain={() => {}}
				againLabel="Import another export…"
				testId="backup-migration-anytype-done"
			/>,
		);
		expect(html).toContain("backup-migration-anytype-done");
		expect(html).toContain("backup-migration-anytype-done-again");
		expect(html).toContain("Import another export…");
		// No failures ⇒ no failure list.
		expect(html).not.toContain("backup-migration-anytype-done-failed");
	});

	it("expands failure rows: i18n'd for known reasonKeys, literal otherwise", () => {
		const html = renderToStaticMarkup(
			<ImportDoneState
				report={{
					created: 0,
					updated: 49,
					skipped: 0,
					failed: [
						{
							externalId: "media",
							reason: "1 file(s) referenced but binaries were not in the export",
							reasonKey: "shell.settings.backupMigration.report.mediaMissing",
							reasonArgs: { count: 1 },
						},
						{ externalId: "row-7", reason: "value rejected by validator" },
						{
							externalId: null,
							reason: "raw fallback reason",
							reasonKey: "shell.settings.some.unknown.key",
						},
					],
				}}
				onAgain={() => {}}
				againLabel="Import another export…"
				testId="backup-migration-anytype-done"
			/>,
		);
		expect(html).toContain("backup-migration-anytype-done-failed");
		// Known key resolves through the catalog (ICU plural, count=1)…
		expect(html).toContain("1 referenced file was");
		// …its English fallback string is NOT dumped alongside.
		expect(html).not.toContain("binaries were not in the export");
		// Engine failures render their record id + literal reason.
		expect(html).toContain("row-7: value rejected by validator");
		// Unknown reasonKey degrades to the literal reason, never the raw key.
		expect(html).toContain("raw fallback reason");
		expect(html).not.toContain("shell.settings.some.unknown.key");
	});
});
