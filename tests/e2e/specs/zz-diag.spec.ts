/**
 * TEMPORARY diagnostic — do not merge.
 *
 * `new-vault-onboarding.spec.ts:225` fails only on the Linux/xvfb runner:
 * a modal `<div role="dialog" class="popover">` with a `popover__footer` is
 * already open over the welcome screen and intercepts the join-tile click.
 * Nothing on the welcome path opens a popover, and the state does not
 * reproduce on macOS with the CI env vars set — so this dumps the live DOM
 * from the runner that actually sees it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";
import { launchShell } from "../../perf/lib/launch-shell";

test("diag: what dialog covers the welcome screen", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-diag-"));
	try {
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });
			dashboard.on("console", (m) => console.log(`[diag:console] ${m.type()} ${m.text()}`));
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

			for (const wait of [0, 500, 1500, 3000, 6000]) {
				await dashboard.waitForTimeout(wait);
				const state = await dashboard.evaluate(() => ({
					roots: Array.from(document.body.children).map(
						(el) => `${el.tagName}.${el.className}`.slice(0, 80),
					),
					dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((el) =>
						el.outerHTML.slice(0, 1800),
					),
				}));
				console.log(`[diag] +${wait}ms roots=${JSON.stringify(state.roots)}`);
				for (const html of state.dialogs) console.log(`[diag] DIALOG ${html}`);
			}
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
