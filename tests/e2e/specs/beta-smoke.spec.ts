/**
 * 13.3 — beta-exit end-to-end smoke. Drives the production-built shell through
 * the happy paths a manual beta tester would, against the real
 * `window.brainstorm` preload bridge (no mocks):
 *
 *   1. create-vault       → an active session exists after create
 *   2. install app        → the dev seeder installs the first-party apps
 *   3. FTS hit            → seeded content is searchable after a reindex
 *   4. theme switch       → light↔dark visibly repaints the dashboard
 *   5. multi-device pair  → the add-device handshake mints a payload
 *   6. edit Note          → a scratch note opens, accepts typing, shows it
 *
 * Full two-device sync convergence lives in the soak harness
 * (`tests/soak/`); this only smokes the pairing *entry* point.
 *
 * Reuses the perf launch harness so there's one Electron-launch path. Runs on
 * a real display (see `playwright.e2e.config.ts`); the in-process Vitest suites
 * cover the same data paths headlessly — this is the real-renderer proof.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { launchShell } from "../../perf/lib/launch-shell";
import { waitForAppTabPage } from "../../visual/lib/app-window";

/** Create (or re-activate) a vault and assert an active session — the
 *  precondition every other flow needs. Inline in the renderer, mirroring the
 *  perf harness's `ensureVaultAndSeed`. */
async function createVault(dashboard: Page, userDataDir: string): Promise<void> {
	await dashboard.evaluate(
		async ({ userDataDir }) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						vaults: {
							list: () => Promise<Array<{ id: string }>>;
							create: (o: { name: string; path: string }) => Promise<unknown>;
							activate: (id: string) => Promise<unknown>;
							session: () => Promise<unknown>;
						};
					};
				}
			).brainstorm;
			const list = await bs.vaults.list();
			if (list.length === 0) {
				await bs.vaults.create({ name: "e2e-smoke", path: `${userDataDir}/vault` });
			} else if (list[0]) {
				await bs.vaults.activate(list[0].id);
			}
			if (!(await bs.vaults.session())) throw new Error("no active vault after create");
		},
		{ userDataDir },
	);
}

test("beta smoke — vault, apps, search, theme, pairing", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-core-"));
	try {
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });

			await test.step("create-vault → active session", async () => {
				await createVault(dashboard, userDataDir);
			});

			await test.step("install app → first-party apps installed", async () => {
				const count = await dashboard.evaluate(async () => {
					const bs = (
						window as unknown as {
							brainstorm: {
								dev: { seedPrebuiltApps: () => Promise<unknown> };
								apps: { listInstalled: () => Promise<unknown[]> };
							};
						}
					).brainstorm;
					// Prebuilt install — `e2e:build` already built every app;
					// `seedDemoApps` would spawn a vite build per app (~8 min on
					// a CI runner, blowing the test budget).
					await bs.dev.seedPrebuiltApps();
					return (await bs.apps.listInstalled()).length;
				});
				expect(count, "at least one app installed after seed").toBeGreaterThan(0);
			});

			await test.step("FTS → seeded content is searchable", async () => {
				// Entity indexing is async — the indexer swap runs later in the
				// vault-open pass, so a single reindex right after boot can land
				// before the real indexer is in place. Poll reindex + query, same
				// as new-vault-onboarding.spec.ts. The term must be a seeded
				// TITLE word: welcome bodies live in the universal-body Y.Doc,
				// which FTS only sees via the editor's denormalized snippet —
				// absent until a first edit.
				await expect
					.poll(
						() =>
							dashboard.evaluate(async () => {
								const bs = (
									window as unknown as {
										brainstorm: {
											search: {
												reindex: () => Promise<unknown>;
												query: (q: { text: string; limit?: number }) => Promise<unknown[]>;
											};
										};
									}
								).brainstorm;
								await bs.search.reindex();
								return (await bs.search.query({ text: "Welcome", limit: 10 })).length;
							}),
						{ timeout: 20_000 },
					)
					.toBeGreaterThan(0);
			});

			await test.step("theme switch → light↔dark repaints", async () => {
				const setMode = (mode: "light" | "dark") =>
					dashboard.evaluate(
						(m) =>
							(
								window as unknown as {
									brainstorm: { dashboard: { setAppearanceMode: (x: string) => Promise<void> } };
								}
							).brainstorm.dashboard.setAppearanceMode(m),
						mode,
					);
				const readBg = () => dashboard.evaluate(() => getComputedStyle(document.body).backgroundColor);
				const themeAttr = () => dashboard.evaluate(() => document.documentElement.dataset.theme);
				const darkSlotTheme = () =>
					dashboard.evaluate(async () => {
						const bs = (
							window as unknown as {
								brainstorm: {
									dashboard: {
										snapshot: () => Promise<{ appearance: { dark: { theme: string } } } | null>;
									};
								};
							}
						).brainstorm;
						return (await bs.dashboard.snapshot())?.appearance.dark.theme;
					});
				// The fresh-vault appearance (mode=light, light=Rose, dark=Midnight)
				// is committed ASYNC by `seedNewVaultDefaults` after create. Anchor on
				// the deterministic IPC snapshot until the dark slot is the seeded
				// Midnight, so the toggle below can't race a half-seeded slot.
				await expect.poll(darkSlotTheme, { timeout: 30_000 }).toBe("midnight");
				// The renderer only refreshes vault state on mount or via its own
				// context methods — `createVault` used raw IPC, so the dashboard window
				// can still be on the welcome screen (which pins Midnight). Reload to
				// deterministically enter the vault-open state before asserting the
				// repaint. Mirrors new-vault-onboarding.spec.ts.
				await dashboard.reload();
				// `setAppearanceMode` resolves when the main process accepts it;
				// the renderer repaint arrives on the snapshot push. Anchor each
				// read on the pushed `data-theme` flip (fresh vault = Midnight in
				// dark, Rose in light — same contract as
				// new-vault-onboarding.spec.ts).
				await setMode("dark");
				await expect.poll(themeAttr, { timeout: 15_000 }).toBe("midnight");
				const dark = await readBg();
				await setMode("light");
				await expect.poll(themeAttr, { timeout: 15_000 }).toBe("rose");
				const light = await readBg();
				expect(dark, "dark and light backgrounds differ").not.toBe(light);
			});

			await test.step("multi-device pairing entry mints a payload", async () => {
				// Pairing correctly fails closed without a relay; declare a
				// placeholder `syncRelay` (the devices-pairing visual spec's
				// recipe) so the entry path is exercised, not the gate.
				const vaultPath = await dashboard.evaluate(async () => {
					const session = await (
						window as unknown as {
							brainstorm: { vaults: { session: () => Promise<{ vaultPath: string } | null> } };
						}
					).brainstorm.vaults.session();
					return session?.vaultPath ?? null;
				});
				expect(vaultPath, "active session exposes the vault path").not.toBeNull();
				const vaultJsonPath = join(vaultPath as string, "vault.json");
				const json = JSON.parse(readFileSync(vaultJsonPath, "utf8")) as Record<string, unknown>;
				json.syncRelay = { url: "ws://localhost:7780", addedAt: Date.now() };
				writeFileSync(vaultJsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");

				const ok = await dashboard.evaluate(async () => {
					const bs = (
						window as unknown as {
							brainstorm: {
								pairing: {
									startAddDevice: (a?: Record<string, unknown>) => Promise<unknown>;
									thisDeviceFingerprint: () => Promise<string | null>;
								};
							};
						}
					).brainstorm;
					const payload = await bs.pairing.startAddDevice();
					const fp = await bs.pairing.thisDeviceFingerprint();
					return Boolean(payload) && typeof fp === "string" && fp.length > 0;
				});
				expect(ok, "startAddDevice + device fingerprint resolve").toBe(true);
			});
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("beta smoke — edit a Note and see it in the editor", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-note-"));
	const TYPED = "e2e smoke note body";
	try {
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });
			await createVault(dashboard, userDataDir);
			await dashboard.evaluate(() =>
				(
					window as unknown as { brainstorm: { dev: { seedPrebuiltApps: () => Promise<unknown> } } }
				).brainstorm.dev.seedPrebuiltApps(),
			);

			// Open a fresh scratch note (the dev helper the editor smoke uses).
			await dashboard.evaluate(async () => {
				const bs = (
					window as unknown as {
						brainstorm: { dev: { notes?: { createAndOpenScratchNote: () => Promise<void> } } };
					}
				).brainstorm;
				if (!bs.dev.notes) throw new Error("dev.notes scratch helper unavailable");
				await bs.dev.notes.createAndOpenScratchNote();
			});
			const notes = await waitForAppTabPage(app);

			const editable = notes.locator('[contenteditable="true"]').first();
			await editable.waitFor({ state: "visible", timeout: 30_000 });
			await editable.click();
			await notes.keyboard.type(TYPED);
			await expect(editable).toContainText(TYPED, { timeout: 10_000 });
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
