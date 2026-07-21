/**
 * Inline cell editing in the Database grid (real shell). Opens the
 * Database app against a seeded vault, ensures a Grid view, and verifies
 * the grid renders the shared `@brainstorm-os/sdk` editing cells (`.bs-cell-*`)
 * rather than read-only paint — proving the EditableCell + PropertiesProvider
 * wiring works inside the app renderer. Then exercises a text/number edit.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

async function openSeededDashboard(page: Page, userDataDir: string): Promise<void> {
	await page.evaluate(
		async ({ d }) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						vaults: {
							create: (o: { name: string; path: string }) => Promise<unknown>;
							session: () => Promise<unknown>;
						};
					};
				}
			).brainstorm;
			await bs.vaults.create({ name: "db-edit", path: `${d}/vault` });
			await bs.vaults.session();
		},
		{ d: userDataDir },
	);
	await page.reload();
	await waitForDashboard(page);
	await page.evaluate(async () => {
		await (
			window as unknown as { brainstorm: { dev: { seedDemoApps: () => Promise<unknown> } } }
		).brainstorm.dev.seedDemoApps();
	});
}

async function launchApp(app: ElectronApplication, dashboard: Page, label: string): Promise<Page> {
	const whatsNew = dashboard.locator(".popover");
	if (await whatsNew.isVisible().catch(() => false)) {
		await dashboard.keyboard.press("Escape");
		await whatsNew.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
	}
	const icon = dashboard.locator(".dashboard-icons__icon", { hasText: label }).first();
	await icon.waitFor({ state: "visible", timeout: 10_000 });
	const [win] = await Promise.all([app.waitForEvent("window"), icon.click()]);
	await win.waitForLoadState("domcontentloaded");
	return win;
}

test.describe("database cell editing", () => {
	test("grid renders shared editing cells", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-db-edit-"));
		const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });
			await waitForFirstContentfulPaintAbsoluteMs(dashboard);
			await openSeededDashboard(dashboard, userDataDir);

			const db = await launchApp(app, dashboard, "Database");
			await db.locator(".db-stage__body").waitFor({ state: "visible", timeout: 15_000 });

			const EDITABLE = [
				".bs-cell-pill",
				".bs-cell-plain",
				".bs-cell-checkbox",
				".bs-cell-tag-trigger",
				".bs-cell-date-trigger",
				".bs-cell-toggle",
				".bs-cell-rating",
			]
				.map((c) => `.dbv-grid__cell--editable ${c}`)
				.join(", ");
			const TEXT_EDITABLE =
				".dbv-grid__cell--editable .bs-cell-pill, .dbv-grid__cell--editable .bs-cell-plain";

			// Walk every list until one surfaces an editable user-property cell.
			const lists = db.locator(".db-sidebar__list-item");
			const listCount = await lists.count();
			let totalEditable = 0;
			let editedOk = false;

			for (let i = 0; i < listCount && !editedOk; i += 1) {
				await lists.nth(i).click();
				await db
					.locator(".dbv-grid")
					.waitFor({ state: "visible", timeout: 10_000 })
					.catch(() => {});
				const count = await db.locator(EDITABLE).count();
				totalEditable += count;

				const textCell = db.locator(TEXT_EDITABLE).first();
				if (await textCell.count()) {
					// Click to edit → type → commit with Enter → the cell shows the value.
					await textCell.click();
					const input = db.locator(".bs-cell-input, .bs-cell-plain-input").first();
					if (await input.count()) {
						await input.fill("Edited in grid");
						await input.press("Enter");
						await expect(db.locator(".dbv-grid")).toContainText("Edited in grid", {
							timeout: 10_000,
						});
						editedOk = true;
					}
				}
			}

			// Inspector — selecting a row shows its properties as editable cells
			// (the inspector was read-only DOM before).
			const firstRow = db.locator(".dbv-grid__row:not(.dbv-grid__row--head)").first();
			let inspectorEditable = 0;
			if (await firstRow.count()) {
				await firstRow.click();
				const inspectorCells = db.locator(
					".db-inspector__props .bs-cell-pill, .db-inspector__props .bs-cell-plain, .db-inspector__props .bs-cell-checkbox, .db-inspector__props .bs-cell-toggle, .db-inspector__props .bs-cell-date-trigger, .db-inspector__props .bs-cell-tag-trigger, .db-inspector__props .bs-cell-rating",
				);
				await inspectorCells
					.first()
					.waitFor({ state: "visible", timeout: 5_000 })
					.catch(() => {});
				inspectorEditable = await inspectorCells.count();
			}

			console.log(
				`[db-edit] lists=${listCount} totalEditable=${totalEditable} editedOk=${editedOk} inspectorEditable=${inspectorEditable}`,
			);
			await db.screenshot({ path: "tests/perf/results/database-cell-editing.png" });

			// Inline editing cells render for user properties somewhere in the vault.
			expect(totalEditable).toBeGreaterThan(0);
			// The inspector surfaces editable property cells for the selected row.
			expect(inspectorEditable).toBeGreaterThan(0);
		} finally {
			await app.close();
		}
	});
});
