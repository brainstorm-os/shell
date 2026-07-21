/**
 * 12.7 — Editor keystroke → paint, real-Electron version.
 *
 * 13.4a.2 extends the original empty-doc bench (the hand-off explicitly
 * deferred by 9.3.5.N5) into a parameterised sweep over
 * `LARGE_DOC_PROFILES` (`@brainstorm-os/editor`). The new pass measures the
 * post-virtualization (13.4a.1 Phase-1) keystroke→paint at the doc sizes
 * the dogfood vault hits in practice — the numbers that decide whether
 * 13.4a.3 must also build Phase-2 reconciliation-windowing or whether
 * Phase-1 is sufficient (OQ-185).
 *
 * What's measured: from `page.keyboard.press` of a single printable
 * character to the next `requestAnimationFrame` after the editor's
 * contenteditable mutates. That's the renderer-perceived "key → paint"
 * the user feels.
 *
 * Seeding: 13.4a.2 step 1 added a dev-only renderer hook
 * (`apps/notes/src/editor/dev-bench-plugin.tsx`) that captures the live
 * `LexicalEditor` instance and exposes
 * `window.__brainstormNotesDev.seedLargeDoc(profileId)`. Production
 * bundles don't ship it (gated on NODE_ENV). The harness drives that
 * call from inside `page.evaluate` to seed `LARGE_DOC_PROFILES.dogfood`
 * (200 blocks) and `.large` (1000 blocks) without a 200-keystroke UI
 * dance.
 *
 * Budget assertion gating:
 *  - `empty`  → asserts <17ms median (existing regression baseline).
 *  - `dogfood`→ asserts <17ms median (`editorKeystrokeToPaintDogfood`,
 *               the 13.4a.2 budget).
 *  - `large`  → recorded for triage only; numbers gate the 13.4a.3
 *               Phase-2 decision but don't fail the build.
 *  - `stress` (5000 blocks) is skipped here — 13.4a.3 runs it manually
 *               under its own controlled environment.
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

const KEYSTROKES = Number.parseInt(process.env.BS_PERF_KEYSTROKES ?? "50", 10);
const WARMUP_KEYSTROKES = Number.parseInt(process.env.BS_PERF_KEYSTROKES_WARMUP ?? "10", 10);

/** Profiles to bench in this run. `stress` is intentionally absent —
 *  see file header. */
type ProfileId = "empty" | "dogfood" | "large";

const PROFILES: readonly ProfileId[] = ["empty", "dogfood", "large"];

async function ensureVaultAndSeed(dashboard: Page, userDataDir: string): Promise<void> {
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
						dev: { seedDemoApps: () => Promise<unknown> };
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
			if (!session) {
				throw new Error("perf harness: no active vault after setup");
			}
			await bs.dev.seedDemoApps();
		},
		{ userDataDir },
	);
}

async function seedNotesEditor(notes: Page, profile: Exclude<ProfileId, "empty">): Promise<void> {
	await notes.evaluate(async (profileId) => {
		const dev = (
			window as unknown as {
				__brainstormNotesDev?: {
					seedLargeDoc: (id: string) => Promise<void>;
				};
			}
		).__brainstormNotesDev;
		if (!dev) {
			throw new Error(
				"[perf] __brainstormNotesDev missing — dev hook not installed (production bundle? editor not mounted?).",
			);
		}
		await dev.seedLargeDoc(profileId);
	}, profile);
}

async function measureKeystrokeToPaint(notes: Page): Promise<number[]> {
	// Warmup keystrokes — let the first few paints absorb v8 JIT + Lexical
	// reconciler-cache warmup that v1-of-N would otherwise inflate the
	// median against. On the larger profiles the warmup also walks the
	// content-visibility skip path past its first-frame initialisation.
	for (let i = 0; i < WARMUP_KEYSTROKES; i++) {
		await notes.keyboard.press("a");
	}

	const measurements: number[] = [];
	for (let i = 0; i < KEYSTROKES; i++) {
		const t0 = Date.now();
		const paintWait = notes.evaluate(
			() =>
				new Promise<number>((resolve) => {
					const editable = document.querySelector('[contenteditable="true"]');
					if (!editable) {
						resolve(Date.now());
						return;
					}
					const observer = new MutationObserver(() => {
						observer.disconnect();
						requestAnimationFrame(() => resolve(Date.now()));
					});
					observer.observe(editable, {
						childList: true,
						subtree: true,
						characterData: true,
					});
					setTimeout(() => {
						observer.disconnect();
						resolve(Date.now());
					}, 1000);
				}),
		);
		await notes.keyboard.press("b");
		const paintTime = await paintWait;
		measurements.push(paintTime - t0);
	}
	return measurements;
}

for (const profile of PROFILES) {
	test(`editor keystroke → paint (Notes, ${profile})`, async () => {
		const userDataDir = mkdtempSync(join(tmpdir(), `bs-perf-editor-${profile}-`));
		try {
			const { app } = await launchShell({ userDataDir });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await ensureVaultAndSeed(dashboard, userDataDir);

				// Mint a fresh empty Note/v1 + dispatch intent.open from the
				// privileged dashboard renderer (the only window with the
				// `brainstorm.dev` bridge). The intent.open routes to the
				// Notes-app handler which launches the app window and selects
				// the new note — so a contenteditable mounts in one shot.
				// Without this, `seedDemoApps` only installs the Notes app
				// (zero notes), Notes lands on its empty-state UI, and
				// `[contenteditable]` never appears within the 30s timeout
				// (13.4a.2 baseline UNDETERMINED on 2026-05-25).
				const newWindowPromise = app.waitForEvent("window", { timeout: 30_000 });
				const scratchResult = await dashboard.evaluate(async () => {
					const bs = (
						window as unknown as {
							brainstorm: {
								dev: {
									notes: {
										createAndOpenScratchNote: () => Promise<
											{ ok: true; entityId: string } | { ok: false; reason: string }
										>;
									};
								};
							};
						}
					).brainstorm;
					return bs.dev.notes.createAndOpenScratchNote();
				});
				if (!scratchResult.ok) {
					throw new Error(`perf harness: createAndOpenScratchNote failed: ${scratchResult.reason}`);
				}
				const notes = await newWindowPromise;
				await waitForFirstContentfulPaintAbsoluteMs(notes);

				// Wait for a contenteditable to be focusable. Notes loads its
				// editor lazily; we wait up to 30s for the surface to appear.
				const editable = notes.locator('[contenteditable="true"]').first();
				await editable.waitFor({ state: "visible", timeout: 30_000 });
				await editable.click();

				if (profile !== "empty") {
					await seedNotesEditor(notes, profile);
					// After seeding, re-focus the editor — the content swap can
					// drop the caret. A fresh click + a tiny rAF stabilises the
					// next keystroke against the seeded tree.
					await editable.click();
					await notes.evaluate(
						() =>
							new Promise<void>((resolve) =>
								requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
							),
					);
				}

				const measurements = await measureKeystrokeToPaint(notes);
				const stats = summarize(measurements);

				// Budget + assertion are profile-specific. Empty + dogfood gate
				// the build; large is triage-only (13.4a.3 Phase-2 decision input).
				if (profile === "empty") {
					const budget = BUDGETS.editorKeystrokeToPaint;
					const passed = stats.median < budget.medianMs;
					console.log(
						`[perf] editor keystroke (empty doc, ${stats.samples} samples): ${formatStats(stats)} ` +
							`budget=${budget.medianMs}ms`,
					);
					appendResult(
						makeResult({
							spec: "editor-keystroke",
							scenario: "empty-doc",
							budget,
							stats,
							passed,
							note: passed
								? "median under editor key-to-paint budget"
								: "median exceeded editor key-to-paint budget — defer to P3 perf-fix iteration",
						}),
					);
					expect(stats.median, "editor keystroke→paint median over budget").toBeLessThan(
						budget.medianMs,
					);
				} else if (profile === "dogfood") {
					const budget = BUDGETS.editorKeystrokeToPaintDogfood;
					const passed = stats.median < budget.medianMs;
					console.log(
						`[perf] editor keystroke (dogfood 200 blocks, ${stats.samples} samples): ` +
							`${formatStats(stats)} budget=${budget.medianMs}ms`,
					);
					appendResult(
						makeResult({
							spec: "editor-keystroke",
							scenario: "dogfood-200-blocks",
							budget,
							stats,
							passed,
							note: passed
								? "median under 13.4a.2 dogfood key-to-paint budget — Phase-1 virtualization sufficient at this size"
								: "median exceeded 13.4a.2 dogfood key-to-paint budget — 13.4a.3 must build Phase-2 reconciliation-windowing",
						}),
					);
					expect(
						stats.median,
						"editor keystroke→paint (dogfood) median over 13.4a.2 budget",
					).toBeLessThan(budget.medianMs);
				} else {
					// `large` — record numbers for triage, no assertion. The
					// large-profile median is the input to the 13.4a.3 Phase-2
					// decision (OQ-185 verdict); failing the build here would
					// just hide the signal.
					const budget = BUDGETS.editorKeystrokeToPaintDogfood;
					const passed = stats.median < budget.medianMs;
					console.log(
						`[perf] editor keystroke (large 1000 blocks, ${stats.samples} samples): ` +
							`${formatStats(stats)} (triage only, no budget assertion)`,
					);
					appendResult(
						makeResult({
							spec: "editor-keystroke",
							scenario: "large-1000-blocks",
							budget,
							stats,
							passed,
							note: "triage-only measurement — feeds the 13.4a.3 Phase-2 decision; no build gate",
						}),
					);
				}
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
}
