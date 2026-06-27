/**
 * KBN-P-database-grid — real-Electron verification of the 12.4 Database grid
 * cell-level keyboard rung (`docs/shell/61-keyboard-accessibility.md`):
 *
 *   - The row-virtualized grid is a single Tab stop: `.dbv-grid__table` is
 *     `role="grid"` with `tabindex="0"`, and the cursor is conveyed by
 *     `aria-activedescendant` (a roving tabindex can't work over a virtualized
 *     body where the active cell may be unmounted).
 *   - Arrow keys move the cursor row-major; the referenced cell carries
 *     `role="gridcell"` + `aria-selected="true"` and stays mounted (the host
 *     scrolls its row into the window).
 *   - Enter on a non-Name cell begins in-cell editing (the inline editor or a
 *     picker popover opens); the Name column keeps Enter = open record.
 *
 * The pure halves (flat↔(row,col) mapping, cursor clamp, the open-vs-edit
 * split, the cells' `autoEdit` rising edge) are unit-tested; this proves the
 * live wiring in the production shell, which jsdom cannot (the virtualized
 * grid renders empty under jsdom — no row layout, no real focus).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchAppPage } from "../../visual/lib/app-window";
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
			await bs.vaults.create({ name: "kbn-db-grid", path: `${d}/vault` });
			await bs.vaults.session();
		},
		{ d: userDataDir },
	);
	await page.reload();
	await waitForDashboard(page);
	// `seedPrebuiltApps` installs the already-built bundles WITHOUT a per-app
	// vite rebuild; `seedDemoApps` rebuilds all 11 apps, which blows the per-test
	// budget and hangs setup (the e2e job already runs `e2e:build`).
	await page.evaluate(async () => {
		await (
			window as unknown as { brainstorm: { dev: { seedPrebuiltApps: () => Promise<unknown> } } }
		).brainstorm.dev.seedPrebuiltApps();
	});
}

const activeDescendant = (page: Page): Promise<string | null> =>
	page.locator(".dbv-grid__table").getAttribute("aria-activedescendant");

test.describe("KBN-P-database-grid — grid cell keyboard navigation + editing", () => {
	test("grid is a composite Tab stop; arrows move the cursor; Enter edits a cell", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-perf-kbn-db-grid-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				// Resolve the real app-tab page (the first `window` event is usually
				// the shell tab strip, not the app) and launch via the IPC path.
				const db = await launchAppPage(app, dashboard, "io.brainstorm.database");
				await db.locator(".db-stage__body").waitFor({ state: "visible", timeout: 30_000 });

				// Only cells whose editor *opens* on Enter count — the scalar inline
				// editors (Plain/Pill/Multiline) and the picker popovers
				// (Tag/Select/Date/Link). Toggle/Checkbox/Rating are inline-interactive
				// (no open state), so they're excluded from the edit assertion.
				const OPENABLE =
					":is(.bs-cell-plain, .bs-cell-pill, .bs-cell-multiline, " +
					".bs-cell-tag-trigger, .bs-cell-date-trigger, .bs-cell-link-trigger)";
				const OPENABLE_CELL = `.dbv-grid__cell--editable ${OPENABLE}`;

				// Walk lists until one renders a grid with at least one row and an
				// editable column whose cell opens on Enter (the seeded lists vary).
				const lists = db.locator(".db-sidebar__list-item");
				const listCount = await lists.count();
				let ready = false;
				for (let i = 0; i < listCount && !ready; i += 1) {
					await lists.nth(i).click();
					await db
						.locator(".dbv-grid")
						.waitFor({ state: "visible", timeout: 10_000 })
						.catch(() => {});
					const hasRows = (await db.locator(".dbv-grid__row:not(.dbv-grid__row--head)").count()) > 0;
					const hasOpenable = (await db.locator(OPENABLE_CELL).count()) > 0;
					if (hasRows && hasOpenable) ready = true;
				}
				expect(ready, "a seeded list surfaces a grid with an openable editable cell").toBe(true);

				const table = db.locator(".dbv-grid__table");

				// (1) The grid is one Tab stop with grid semantics.
				await expect(table).toHaveAttribute("role", "grid", { timeout: 10_000 });
				await expect(table).toHaveAttribute("tabindex", "0");

				// (2) Focusing the grid puts the cursor on a cell, conveyed by
				// `aria-activedescendant` → a mounted `gridcell` that is aria-selected.
				await table.focus();
				await expect.poll(() => activeDescendant(db), { timeout: 10_000 }).not.toBeNull();
				const startCell = await activeDescendant(db);
				// `aria-activedescendant` ids come from React `useId()` and contain
				// colons (`:r0:-5`), which are invalid in a `#id` CSS selector — match
				// on the id attribute instead.
				const startEl = db.locator(`[id="${startCell}"]`);
				await expect(startEl).toHaveAttribute("role", "gridcell");
				await expect(startEl).toHaveAttribute("aria-selected", "true");

				// (3) An arrow key moves the cursor to a neighbour cell (try the
				// horizontal then vertical axis — a 1×N or N×1 grid only moves on one).
				let moved = false;
				for (const key of ["ArrowRight", "ArrowDown"]) {
					await db.keyboard.press(key);
					const now = await activeDescendant(db);
					if (now !== null && now !== startCell) {
						moved = true;
						await expect(db.locator(`[id="${now}"]`)).toHaveAttribute("aria-selected", "true");
						break;
					}
				}
				expect(moved, "an arrow key advances the cell cursor").toBe(true);

				// (4) Enter begins in-cell editing. Find the flat column of the first
				// openable editable cell, drive the cursor onto it with ArrowRight
				// (wrap-safe — reading the live cursor column each step), then Enter
				// opens the inline editor (input/textarea) or the picker popover
				// (the trigger's `aria-expanded` flips). The Name column (col 0) is
				// never targeted — its Enter opens the record, not an editor.
				// `cols` = navigable columns; `editableCol` is derived from the
				// openable cell's OWN `data-composite-index % cols` (not its DOM
				// child position), so a future row-number `gridcell` can't introduce
				// an off-by-one against the live cursor index.
				const layout = await db.evaluate((openable: string) => {
					const row = document.querySelector(
						".dbv-grid__row:not(.dbv-grid__row--head):not(.dbv-grid__row--foot)",
					);
					const cells = Array.from(row?.querySelectorAll('.dbv-grid__cell[role="gridcell"]') ?? []);
					const cols = cells.length;
					let editableCol = -1;
					for (const c of cells) {
						if (
							c.classList.contains("dbv-grid__cell--editable") &&
							c.querySelector(openable) &&
							cols > 0
						) {
							const idx = c.getAttribute("data-composite-index");
							if (idx != null) {
								editableCol = Number(idx) % cols;
								break;
							}
						}
					}
					return { cols, editableCol };
				}, OPENABLE);
				expect(layout.editableCol, "the grid has an openable editable column").toBeGreaterThan(0);

				// Returns the cursor's column, or -1 if the active cell is momentarily
				// unmounted (virtualized row scrolled out between keypress and read).
				const cursorCol = (): Promise<number> =>
					db.evaluate((cols: number) => {
						const id = document.querySelector(".dbv-grid__table")?.getAttribute("aria-activedescendant");
						// `getElementById` tolerates the colons in React `useId()` ids.
						const idx = id ? document.getElementById(id)?.getAttribute("data-composite-index") : null;
						return idx == null ? -1 : Number(idx) % cols;
					}, layout.cols);

				await table.focus();
				for (let i = 0; i < layout.cols + 2 && (await cursorCol()) !== layout.editableCol; i += 1) {
					await db.keyboard.press("ArrowRight");
				}
				// Poll the final check so a transient unmount (cursorCol === -1) during
				// scroll settles before asserting, rather than flaking.
				await expect.poll(() => cursorCol(), { timeout: 5_000 }).toBe(layout.editableCol);

				const OPEN_EDITOR =
					".dbv-grid__cell--editable .bs-cell-input, " +
					".dbv-grid__cell--editable .bs-cell-plain-input, " +
					".dbv-grid__cell--editable .bs-cell-multiline-input, " +
					'.dbv-grid__cell--editable [aria-expanded="true"]';
				// Clean baseline: nothing is editing yet, so a post-Enter match can
				// only be the editor Enter just opened (not a stale expanded control).
				expect(await db.locator(OPEN_EDITOR).count(), "no editor open before Enter").toBe(0);
				await db.keyboard.press("Enter");
				await expect(
					db.locator(OPEN_EDITOR).first(),
					"Enter on a non-Name cell opens its editor (keyboard in-cell edit)",
				).toBeVisible({ timeout: 5_000 });

				console.log("[kbn] database grid: cursor + arrow nav + Enter-to-edit hold");
				await db.screenshot({ path: "tests/perf/results/kbn-database-grid.png" });
			} finally {
				await app.close().catch(() => {});
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
