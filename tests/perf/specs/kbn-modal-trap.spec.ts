/**
 * KBN-P-modal-trap — `docs/shell/61-keyboard-accessibility.md §Validation`.
 *
 * Open a `<Popover>` (the canonical KBN-S-popover trap). Count the focusables
 * inside. Press Tab N+1 times — assert focus cycles, does not escape the
 * panel. Shift+Tab cycles the same way in reverse.
 *
 * The "Vault info" button on the dashboard chrome opens the `VaultInfoPopover`
 * which is built on the shared `<Popover>` primitive — the one surface that
 * has `useFocusTrap` from `@brainstorm-os/sdk/a11y` adopted (KBN-S-popover,
 * 2026-05-27). Same trap path the IconPicker / CoverPicker / Cheatsheet
 * popovers exercise.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	FOCUSABLE_SELECTOR,
	ensureVaultSeeded,
	readFocusFingerprint,
	waitForDashboard,
} from "../lib/keyboard-assertions";
import { launchShell } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

test.describe("KBN-P-modal-trap — Tab cycles inside <Popover>, never escapes", () => {
	test("Tab N+1 times inside Vault Info popover cycles back to first focusable", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-perf-kbn-modal-trap-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await ensureVaultSeeded(dashboard, userDataDir);
				await waitForDashboard(dashboard);

				// Open the Vault Info popover. The button is in the dashboard
				// header right-cluster; matched by accessible name.
				const opener = dashboard.getByRole("button", { name: /vault info/i });
				await opener.first().click();

				// Wait for the popover panel to be in DOM + focus to have
				// landed inside the trap. The Popover's useFocusTrap effect
				// runs after mount + moves focus to the first focusable in
				// the panel.
				const panel = dashboard.locator('[role="dialog"][aria-modal="true"] .popover__panel');
				await panel.waitFor({ state: "visible", timeout: 10_000 });
				await dashboard.waitForFunction(() => {
					const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
					return dialog?.contains(document.activeElement);
				});

				// Count focusables inside the popover panel. The Popover
				// chrome has at least the close button in its header — so
				// the trap always has ≥1 focusable.
				const n = await dashboard.evaluate((focusableSelector) => {
					const root = document.querySelector('[role="dialog"][aria-modal="true"] .popover__panel');
					if (!root) return 0;
					return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
						(el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
					).length;
				}, FOCUSABLE_SELECTOR);
				expect(
					n,
					"Popover panel must contain ≥1 focusable for the trap to be meaningful",
				).toBeGreaterThan(0);

				// Walk Tab `n + 1` times — must always stay inside the panel.
				const visited: string[] = [];
				for (let i = 0; i < n + 1; i++) {
					await dashboard.keyboard.press("Tab");
					const insideTrap = await dashboard.evaluate(() => {
						const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
						return dialog?.contains(document.activeElement) ?? false;
					});
					expect(insideTrap, `Tab #${i + 1} of ${n + 1} must keep focus inside the popover trap`).toBe(
						true,
					);
					const fp = await readFocusFingerprint(dashboard);
					visited.push(fp ?? "@body");
				}

				// After n+1 Tabs, at least one fingerprint must have repeated
				// (we've cycled, not escaped).
				const unique = new Set(visited);
				expect(
					unique.size,
					"Tab N+1 times must cycle (at least one repeated focus target)",
				).toBeLessThan(visited.length);
				console.log(
					`[kbn] modal-trap (Tab): ${n} focusables, walked ${visited.length} steps, ${unique.size} unique — cycle observed`,
				);

				// Shift+Tab: same in reverse. Walk n+1 backwards from current.
				const reverseVisited: string[] = [];
				for (let i = 0; i < n + 1; i++) {
					await dashboard.keyboard.press("Shift+Tab");
					const insideTrap = await dashboard.evaluate(() => {
						const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
						return dialog?.contains(document.activeElement) ?? false;
					});
					expect(
						insideTrap,
						`Shift+Tab #${i + 1} of ${n + 1} must keep focus inside the popover trap`,
					).toBe(true);
					const fp = await readFocusFingerprint(dashboard);
					reverseVisited.push(fp ?? "@body");
				}
				const reverseUnique = new Set(reverseVisited);
				expect(
					reverseUnique.size,
					"Shift+Tab N+1 times must cycle (at least one repeated focus target)",
				).toBeLessThan(reverseVisited.length);
				console.log(
					`[kbn] modal-trap (Shift+Tab): ${n} focusables, walked ${reverseVisited.length} steps, ${reverseUnique.size} unique — cycle observed`,
				);

				// Close the popover cleanly so the spec doesn't leave a
				// stale overlay across teardown.
				await dashboard.keyboard.press("Escape");
				await panel.waitFor({ state: "hidden", timeout: 5_000 });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
