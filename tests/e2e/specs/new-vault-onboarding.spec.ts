/**
 * New-vault onboarding e2e — exercises the fresh-vault experience against the
 * production-built shell under Electron (no mocks, real `window.brainstorm`):
 *
 *   1. create-vault → the welcome starter content is seeded AND the vault
 *      opens on-brand (Rose theme, light mode, the bundled wallpaper).
 *   2. welcome UI → the secondary CTAs render as white-gloss buttons (not the
 *      old hardcoded blue), the Join-vault popover shows a single title (no
 *      duplicated header), and the create form surfaces an inline error when
 *      the name collides with an existing vault.
 *
 * Reuses the perf launch harness (one Electron-launch path). Mirrors
 * `beta-smoke.spec.ts`. The in-process Vitest suites cover the same data paths
 * headlessly; this is the real-renderer proof the user asked for.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { launchShell } from "../../perf/lib/launch-shell";

type Snapshot = {
	theme: string;
	wallpaper: { kind: string; value: string };
	appearance: { mode: string };
};

/** Poll the dashboard snapshot until the fresh-vault defaults have landed.
 *  `seedNewVaultDefaults` runs after the welcome seed in the same vault-open
 *  pass, so a Rose snapshot also means the starter content is committed. The
 *  fresh-vault default is Rose theme in LIGHT mode (Midnight is the dark slot). */
async function waitForDefaultSnapshot(dashboard: Page): Promise<Snapshot> {
	return await dashboard.evaluate(async () => {
		const bs = (
			window as unknown as {
				brainstorm: { dashboard: { snapshot: () => Promise<Snapshot | null> } };
			}
		).brainstorm;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const snap = await bs.dashboard.snapshot();
			// A fresh vault is Rose-by-default before the seed runs, so also wait
			// for the seed to commit light mode — that's the "fully seeded" signal.
			if (snap && snap.theme === "rose" && snap.appearance.mode === "light") return snap;
			await new Promise((r) => setTimeout(r, 200));
		}
		const last = await bs.dashboard.snapshot();
		throw new Error(`snapshot never reached rose/light default; last=${JSON.stringify(last)}`);
	});
}

test("new vault seeds welcome content and applies Rose/light/wallpaper defaults", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-newvault-"));
	try {
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });

			await test.step("create a brand-new vault", async () => {
				await dashboard.evaluate(
					async ({ userDataDir }) => {
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
						await bs.vaults.create({ name: "Personal", path: `${userDataDir}/vault` });
						if (!(await bs.vaults.session())) throw new Error("no active vault after create");
					},
					{ userDataDir },
				);
			});

			await test.step("vault opens on Rose + light + bundled wallpaper", async () => {
				const snap = await waitForDefaultSnapshot(dashboard);
				expect(snap.theme, "theme is Rose").toBe("rose");
				expect(snap.appearance.mode, "appearance mode is light").toBe("light");
				expect(snap.wallpaper.kind, "wallpaper is an image").toBe("image");
				expect(snap.wallpaper.value, "wallpaper is the bundled brand asset").toContain("rose-peaks");
			});

			await test.step("welcome starter content is present (searchable)", async () => {
				// Entity indexing is async (the indexer swap runs later in the
				// vault-open pass), so poll: reindex + query until a welcome-*
				// entity surfaces rather than assuming it's ready on the first try.
				await expect
					.poll(
						() =>
							dashboard.evaluate(async () => {
								const bs = (
									window as unknown as {
										brainstorm: {
											search: {
												reindex: () => Promise<unknown>;
												query: (q: { text: string; limit?: number }) => Promise<Array<{ entityId: string }>>;
											};
										};
									}
								).brainstorm;
								await bs.search.reindex();
								for (const term of ["Welcome", "Getting started", "product tour"]) {
									const hits = await bs.search.query({ text: term, limit: 20 });
									if (hits.some((h) => h.entityId.startsWith("welcome-"))) return true;
								}
								return false;
							}),
						{ timeout: 20_000 },
					)
					.toBe(true);
			});

			await dashboard.screenshot({ path: "tests/e2e/results/new-vault-dashboard.png" });
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("switching vaults repaints the dashboard (no stale theme from the previous vault)", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-switch-"));
	try {
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });

			// Vault A: fresh → Rose/light. Wait for the seed to settle BEFORE
			// overriding, so the async `seedNewVaultDefaults` can't clobber the
			// override mid-flight.
			await dashboard.evaluate(
				async ({ dir }) => {
					const bs = (
						window as unknown as {
							brainstorm: {
								vaults: { create: (o: { name: string; path: string }) => Promise<unknown> };
							};
						}
					).brainstorm;
					await bs.vaults.create({ name: "Alpha", path: `${dir}/alpha` });
				},
				{ dir: userDataDir },
			);
			// Anchor on the IPC snapshot first: the async seed commits rose/light
			// there before the renderer repaints `data-theme`, so on a slow runner
			// the bare attr poll can time out otherwise.
			await waitForDefaultSnapshot(dashboard);
			await expect
				.poll(() => dashboard.evaluate(() => document.documentElement.dataset.theme), {
					timeout: 30_000,
				})
				.toBe("rose");

			// Force Alpha to DARK so its theme (Midnight) differs from Bravo's fresh
			// default (Rose) and the switch is observable on data-theme. Confirm via
			// the (deterministic) IPC snapshot, then reload so the renderer settles
			// cleanly on Alpha-dark before the switch — keeps the setup from racing
			// Alpha's still-running vault-open pass.
			await dashboard.evaluate(async () => {
				const bs = (
					window as unknown as {
						brainstorm: {
							dashboard: {
								setAppearanceMode: (m: string) => Promise<void>;
								snapshot: () => Promise<{ appearance: { mode: string } } | null>;
							};
						};
					}
				).brainstorm;
				await bs.dashboard.setAppearanceMode("dark");
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					const snap = await bs.dashboard.snapshot();
					if (snap?.appearance.mode === "dark") return;
					await new Promise((r) => setTimeout(r, 100));
				}
				throw new Error("appearance mode never became dark");
			});
			await dashboard.reload();
			await expect
				.poll(() => dashboard.evaluate(() => document.documentElement.dataset.theme), {
					timeout: 30_000,
				})
				.toBe("midnight");

			// Vault B: a brand-new vault. The active session switches to B; the
			// dashboard window is NOT remounted, so only the main-side rebind +
			// push can repaint it. Without the fix this stays "midnight" (Alpha's
			// forced dark theme).
			await dashboard.evaluate(
				async ({ dir }) => {
					const bs = (
						window as unknown as {
							brainstorm: {
								vaults: { create: (o: { name: string; path: string }) => Promise<unknown> };
							};
						}
					).brainstorm;
					await bs.vaults.create({ name: "Bravo", path: `${dir}/bravo` });
				},
				{ dir: userDataDir },
			);
			await expect
				.poll(() => dashboard.evaluate(() => document.documentElement.dataset.theme), {
					timeout: 30_000,
				})
				.toBe("rose");
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("welcome screen: white-gloss CTAs, single-title join popover, duplicate-name error", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-welcome-ui-"));
	try {
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });

			// Create a vault then close the session: the registry keeps it, so the
			// renderer falls back to the welcome screen *with* a recent vault — the
			// state where the recent list appears (the Join entry is always shown).
			await dashboard.evaluate(
				async ({ userDataDir }) => {
					const bs = (
						window as unknown as {
							brainstorm: {
								vaults: {
									create: (o: { name: string; path: string }) => Promise<unknown>;
									close: () => Promise<unknown>;
								};
							};
						}
					).brainstorm;
					await bs.vaults.create({ name: "Personal", path: `${userDataDir}/vault` });
					await bs.vaults.close();
				},
				{ userDataDir },
			);
			await dashboard.reload();

			const joinButton = dashboard.locator('[data-testid="welcome-join-vault"]');
			await joinButton.waitFor({ state: "visible", timeout: 30_000 });

			await test.step("secondary CTAs are white-gloss, not blue", async () => {
				// The glossy face is driven by --color-gloss-top; the welcome
				// override sets it to white (#ffffff), never the old cyan.
				const glossTop = await joinButton.evaluate((el) =>
					getComputedStyle(el).getPropertyValue("--color-gloss-top").trim().toLowerCase(),
				);
				expect(["#ffffff", "#fff", "rgb(255, 255, 255)"]).toContain(glossTop);
			});

			await test.step("join popover opens with a single title (no duplicate header)", async () => {
				await joinButton.click();
				const popover = dashboard.locator('[data-testid="welcome-join-vault-popover"]');
				await popover.waitFor({ state: "visible", timeout: 10_000 });
				const titleCount = await popover.evaluate((el) => {
					const text = el.textContent ?? "";
					return text.split("Join an existing vault").length - 1;
				});
				expect(titleCount, "title appears exactly once inside the popover").toBe(1);
				await dashboard.screenshot({ path: "tests/e2e/results/join-vault-popover.png" });
				await dashboard.keyboard.press("Escape");
				await popover.waitFor({ state: "hidden", timeout: 10_000 });
			});

			await test.step("create form (step 1) flags a duplicate vault name inline", async () => {
				await dashboard.getByText("Create a new vault").click();
				const error = dashboard.locator('[data-testid="welcome-name-error"]');
				await error.waitFor({ state: "visible", timeout: 10_000 });
				// The name/location step gates "Continue"; "Create vault" is on step 2.
				const continueBtn = dashboard.getByRole("button", { name: "Continue" });
				await expect(continueBtn).toBeDisabled();
				await dashboard.screenshot({ path: "tests/e2e/results/welcome-name-error.png" });

				// Typing a fresh name clears the error and re-enables Continue.
				const nameInput = dashboard.locator(".welcome__input").first();
				await nameInput.fill("Research");
				await expect(error).toBeHidden();
				await expect(continueBtn).toBeEnabled();
			});

			await test.step("opting out of starter content creates an empty vault", async () => {
				// Advance from the name step (a valid "Research" is in place) to the
				// starting-point step (step 2), where the starter-content toggle lives.
				await dashboard.getByRole("button", { name: "Continue" }).click();
				// Welcome-1b: unchecking the starter-content checkbox pre-stamps the
				// seed, so the fresh vault opens with NO welcome-* entities. The
				// native input is visually-hidden and the step transition can leave it
				// off-viewport for setChecked, so toggle via the visible label.
				const checkbox = dashboard.locator('[data-testid="welcome-starter-content"]');
				await checkbox.waitFor({ state: "attached", timeout: 10_000 });
				await expect(checkbox).toBeChecked();
				// Step 2's lower content can sit below the short e2e window and won't
				// scroll into view; drive the toggle + submit via direct DOM clicks,
				// which fire React's handlers without Playwright's viewport gate.
				await checkbox.evaluate((el: HTMLInputElement) => el.click());
				await expect(checkbox).not.toBeChecked();
				await dashboard
					.getByRole("button", { name: "Create vault" })
					.evaluate((el: HTMLButtonElement) => el.click());

				// The new vault opens onto the dashboard.
				await dashboard
					.locator("main.dashboard")
					.waitFor({ state: "visible", timeout: 30_000 })
					.catch(async () => {
						await dashboard.reload();
						await dashboard.locator("main.dashboard").waitFor({ state: "visible", timeout: 30_000 });
					});

				// Settle, reindex, and assert no welcome-* entity ever surfaces.
				const hits = await dashboard.evaluate(async () => {
					const bs = (
						window as unknown as {
							brainstorm: {
								search: {
									reindex: () => Promise<unknown>;
									query: (q: { text: string; limit?: number }) => Promise<Array<{ entityId: string }>>;
								};
							};
						}
					).brainstorm;
					const deadline = Date.now() + 8_000;
					while (Date.now() < deadline) {
						await bs.search.reindex();
						const found = await bs.search.query({ text: "Welcome", limit: 20 });
						if (found.some((h) => h.entityId.startsWith("welcome-"))) return "seeded";
						await new Promise((r) => setTimeout(r, 1_000));
					}
					return "empty";
				});
				expect(hits, "opted-out vault has no welcome starter entities").toBe("empty");
			});
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
