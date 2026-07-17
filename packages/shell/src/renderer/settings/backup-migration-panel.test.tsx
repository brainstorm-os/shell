/**
 * `<BackupMigrationPanel>` (IE-3) — SSR-rendered smoke test. The panel is
 * click-driven (no mount effects), so static render exercises the idle layout:
 * the export action + the import file-pick affordance + the section summary,
 * all resolving through `t()`. Deeper flow coverage lives in the
 * `import-export-handlers` integration test.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackupMigrationPanel, ImportDoneState } from "./backup-migration-panel";
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
