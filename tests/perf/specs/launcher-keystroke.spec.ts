/**
 * 12.7 — Launcher palette keystroke → paint, real-Electron version.
 *
 * The launcher (`packages/shell/src/renderer/launcher/launcher.tsx`) is a
 * `⌘ Space` / `Ctrl+Space` overlay over the dashboard with two sections:
 *
 *   - **Apps** — rendered from a sync-cached `apps.listInstalled()` array
 *     populated when the launcher opens. No debounce; every keystroke
 *     re-filters the cached list synchronously.
 *   - **Entities** — FTS5 hits via `services.search.query`, *debounced*
 *     by `SEARCH_DEBOUNCE_MS = 120` before the IPC dispatch fires.
 *
 * That structural split is why this spec asserts two different budgets:
 *
 *   - `launcher-apps-keystroke` — 50ms median (the raw doc number from
 *     `docs/shell/12-shell-architecture.md:246`, the apps row is sync-cached
 *     so there's no debounce to amortise).
 *   - `launcher-entities-keystroke` — 170ms median, derived in the budget
 *     entry's description. The entities row pays the intentional 120ms
 *     debounce *before* query dispatch; the doc's 50ms paint budget applies
 *     after debounce drain. Asserting 50ms here would gate on something the
 *     launcher intentionally never does — see the inline comment in
 *     `measureKeystrokeToPaint`.
 *
 * Measurement is the same pattern as `editor-keystroke.spec.ts`: a
 * MutationObserver on the launcher results container resolves on the next
 * rAF after a row mutation, and the harness diffs that wall-clock time
 * against the moment of `keyboard.press`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { BUDGETS } from "../lib/budgets";
import { launchShell } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";
import { appendResult, makeResult } from "../lib/results";
import { formatStats, summarize } from "../lib/stats";

const KEYSTROKES = Number.parseInt(process.env.BS_PERF_KEYSTROKES ?? "30", 10);
const WARMUP_KEYSTROKES = Number.parseInt(process.env.BS_PERF_KEYSTROKES_WARMUP ?? "5", 10);

/** Selector pair scoped to the launcher overlay (`data-testid="launcher"`). */
const LAUNCHER_OVERLAY = '[data-testid="launcher"]';
const LAUNCHER_INPUT = `${LAUNCHER_OVERLAY} input.launcher__input`;
const LAUNCHER_RESULTS = `${LAUNCHER_OVERLAY} .launcher__results`;

async function ensureVaultSeededWithContent(dashboard: Page, userDataDir: string): Promise<void> {
	await dashboard.evaluate(
		async ({ userDataDir }) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						vaults: {
							list: () => Promise<unknown[]>;
							create: (opts: { name: string; path: string }) => Promise<unknown>;
							activate: (id: string) => Promise<unknown>;
							session: () => Promise<unknown>;
						};
						dev: {
							seedDemoApps: () => Promise<unknown>;
							reseedVault: () => Promise<unknown>;
						};
					};
				}
			).brainstorm;
			const list = (await bs.vaults.list()) as Array<{ id: string }>;
			let session = await bs.vaults.session();
			if (list.length === 0) {
				await bs.vaults.create({ name: "perf-fixture", path: `${userDataDir}/vault` });
				session = await bs.vaults.session();
			} else if (!session && list[0]) {
				await bs.vaults.activate(list[0].id);
				session = await bs.vaults.session();
			}
			if (!session) throw new Error("perf harness: no active vault after setup");
			await bs.dev.seedDemoApps();
			// Reseed the vault with the BrainstormProject demo content so the
			// entities FTS5 index has matches; without seeded entities the
			// entities-row scenario degenerates to instant-empty and the
			// debounce-shaped budget is a no-op.
			await bs.dev.reseedVault();
		},
		{ userDataDir },
	);
}

async function openLauncher(dashboard: Page): Promise<void> {
	// CmdOrCtrl+K per `renderer/shortcuts/default-chords.ts`. The
	// launcher is renderer-local React state (no programmatic-open IPC);
	// the global shortcut is the only path.
	const chord = process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK";
	await dashboard.keyboard.press(chord);
	await dashboard.locator(LAUNCHER_INPUT).waitFor({ state: "visible", timeout: 10_000 });
	// The launcher focuses its input on next rAF after mount; give that
	// frame time to land before we start typing.
	await dashboard.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
}

async function clearLauncherInput(dashboard: Page): Promise<void> {
	const input = dashboard.locator(LAUNCHER_INPUT);
	await input.click();
	await input.fill("");
}

/**
 * Measures keystroke → paint inside the launcher results pane.
 *
 * The MutationObserver watches the `.launcher__results` container (subtree
 * + childList + characterData) — apps-row mutations fire on the same tick
 * as the keystroke (sync filter), entities-row mutations fire after the
 * SEARCH_DEBOUNCE_MS-gated FTS5 query lands. Both paths resolve on the
 * next rAF after the first observed mutation, which is what the user
 * actually sees as "the result changed".
 *
 * A 2-second hard cap keeps a no-debounce-drain accident from hanging the
 * spec — for the entities-row case, anything past ~500ms is already
 * catastrophic well beyond the 170ms budget.
 */
async function measureKeystrokeToPaint(
	dashboard: Page,
	keystrokes: readonly string[],
): Promise<number[]> {
	// Warmup keystrokes — let v8 JIT, the launcher's first-paint reconcile,
	// and (for the entities-row scenario) the first FTS5 query absorb cold
	// costs so the recorded median represents steady-state typing, not
	// "the first user keystroke of the session".
	for (let i = 0; i < WARMUP_KEYSTROKES; i++) {
		const key = keystrokes[i % keystrokes.length] ?? "a";
		await dashboard.keyboard.press(key);
	}

	const measurements: number[] = [];
	for (let i = 0; i < KEYSTROKES; i++) {
		const key = keystrokes[i % keystrokes.length] ?? "a";
		const t0 = Date.now();
		const paintWait = dashboard.evaluate(
			(selector) =>
				new Promise<number>((resolve) => {
					const root = document.querySelector(selector);
					if (!root) {
						resolve(Date.now());
						return;
					}
					const observer = new MutationObserver(() => {
						observer.disconnect();
						requestAnimationFrame(() => resolve(Date.now()));
					});
					observer.observe(root, {
						childList: true,
						subtree: true,
						characterData: true,
					});
					setTimeout(() => {
						observer.disconnect();
						resolve(Date.now());
					}, 2000);
				}),
			LAUNCHER_RESULTS,
		);
		await dashboard.keyboard.press(key);
		const paintTime = await paintWait;
		measurements.push(paintTime - t0);
	}
	return measurements;
}

test.describe("launcher keystroke → paint (apps + entities sections)", () => {
	test("launcher keystroke→paint, both sections", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-perf-launcher-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await ensureVaultSeededWithContent(dashboard, userDataDir);

				// ----------------------------------------------------------------
				// Scenario 1: apps section.
				//
				// The apps row filters synchronously over a cached list; the doc's
				// raw 50ms keystroke→paint budget applies directly (no debounce
				// to amortise).
				//
				// We type letters that appear in installed-app names — every
				// keystroke must change the filtered list so MutationObserver has
				// something to fire on. Alternating between `a` (apps starting
				// with "a") and Backspace ensures a visible-row mutation on
				// every key while keeping the input short.
				// ----------------------------------------------------------------
				await openLauncher(dashboard);
				await clearLauncherInput(dashboard);

				const appsKeystrokes: readonly string[] = ["a", "Backspace"];
				const appsMeasurements = await measureKeystrokeToPaint(dashboard, appsKeystrokes);
				// Sanity check — after the warmup + first real keystroke the
				// rendered list must actually contain app rows; otherwise the
				// measurement is timing an empty mutation loop.
				const appsRendered = await dashboard.evaluate(
					(selector) => document.querySelectorAll(`${selector} .launcher__result-button`).length,
					LAUNCHER_OVERLAY,
				);
				const appsStats = summarize(appsMeasurements);
				const appsBudget = BUDGETS.launcherAppsKeystroke;
				const appsPassed = appsStats.median < appsBudget.medianMs;
				console.log(
					`[perf] launcher apps-row keystroke (${appsStats.samples} samples, ${appsRendered} rows visible): ` +
						`${formatStats(appsStats)} budget=${appsBudget.medianMs}ms`,
				);
				appendResult(
					makeResult({
						spec: "launcher-keystroke",
						scenario: "apps",
						budget: appsBudget,
						stats: appsStats,
						passed: appsPassed,
						note: appsPassed
							? "median under apps-section keystroke→paint budget (sync-cached filter, doc number)"
							: "median exceeded apps-section keystroke→paint budget — defer to P3 perf-fix iteration",
					}),
				);
				// Hard-fail when the launcher rendered zero rows; that means the
				// seed didn't install any apps and the measurement is timing
				// nothing.
				expect(appsRendered, "launcher apps row must render at least one button").toBeGreaterThan(0);

				// Close + re-open between scenarios so the apps-section warmup
				// state doesn't bleed into the entities measurement.
				await dashboard.keyboard.press("Escape");
				await dashboard.locator(LAUNCHER_OVERLAY).waitFor({ state: "hidden", timeout: 5_000 });

				// ----------------------------------------------------------------
				// Scenario 2: entities section.
				//
				// Derived budget: launcher-entities pays an intentional 120ms
				// search debounce (SEARCH_DEBOUNCE_MS in launcher.tsx) before
				// query dispatch. The doc-stated 50ms paint budget applies
				// AFTER debounce drain. Asserting 50ms here would gate on
				// something the launcher intentionally never does. The apps-row
				// scenario above asserts the raw doc number; this one asserts
				// debounce + paint as the user-visible deadline.
				//
				// We type into a query that the BrainstormProject reseed produces
				// matches for (the seed lays down notes named after plan
				// iterations and OQs — the letter `t` is a dense match). Each
				// keystroke + Backspace pair changes the query so a fresh
				// debounce + FTS5 dispatch + row mutation always fires.
				// ----------------------------------------------------------------
				await openLauncher(dashboard);
				await clearLauncherInput(dashboard);

				const entitiesKeystrokes: readonly string[] = ["t", "Backspace"];
				const entitiesMeasurements = await measureKeystrokeToPaint(dashboard, entitiesKeystrokes);
				const entitiesRendered = await dashboard.evaluate(
					(selector) => document.querySelectorAll(`${selector} .launcher__result-button`).length,
					LAUNCHER_OVERLAY,
				);
				const entitiesStats = summarize(entitiesMeasurements);
				const entitiesBudget = BUDGETS.launcherEntitiesKeystroke;
				const entitiesPassed = entitiesStats.median < entitiesBudget.medianMs;
				console.log(
					`[perf] launcher entities-row keystroke (${entitiesStats.samples} samples, ${entitiesRendered} rows visible): ${formatStats(entitiesStats)} budget=${entitiesBudget.medianMs}ms (50ms paint + 120ms SEARCH_DEBOUNCE_MS)`,
				);
				appendResult(
					makeResult({
						spec: "launcher-keystroke",
						scenario: "entities",
						budget: entitiesBudget,
						stats: entitiesStats,
						passed: entitiesPassed,
						note: entitiesPassed
							? "median under entities-section keystroke→paint budget (debounce-derived 170ms)"
							: "median exceeded entities-section keystroke→paint budget — defer to P3 perf-fix iteration",
					}),
				);
				// We don't hard-fail on an empty entities list — a seed
				// regression elsewhere shouldn't masquerade as a perf failure.
				// The measurement still records (with the empty-debounce time)
				// and the budget assertion below is the build gate.

				expect(appsStats.median, "launcher apps-row keystroke→paint median over budget").toBeLessThan(
					appsBudget.medianMs,
				);
				expect(
					entitiesStats.median,
					"launcher entities-row keystroke→paint median over (debounce-derived) budget",
				).toBeLessThan(entitiesBudget.medianMs);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
