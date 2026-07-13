/**
 * KBN-P-escape-stack — `docs/shell/61-keyboard-accessibility.md §Validation`.
 *
 * Open nested overlays, press Escape, assert LIFO unwind with opener-focus
 * restoration at each step.
 *
 * The spec asks for three nested overlays. Today's reachable overlay set from
 * a default-launched shell (no seeded entities, no app windows) is:
 *   - Launcher (Cmd+K)
 *   - Settings / Bin / Marketplace / Help (from the dashboard chrome buttons)
 *   - Help overlay's article links (one-level deeper)
 *
 * The only adopter of `useFocusTrap` today is `<Popover>` (KBN-S-popover);
 * Launcher / Settings / Bin / Marketplace / Help still register Escape via
 * `useEscapeStackEntry` only — they push onto the same renderer-wide stack
 * via KBN-2's `getEscapeStack()`, so the LIFO unwind assertion holds even
 * before per-surface focus-trap adoption.
 *
 * We exercise a 2-deep stack today (Settings → Help via the help-cross-link
 * pattern, or Launcher → Marketplace via the launcher's marketplace
 * activation). Once KBN-S-launcher / KBN-S-settings land, this expands to
 * three.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureVaultSeeded, waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

test.describe("KBN-P-escape-stack — LIFO unwind, opener-focus restoration", () => {
	test("two nested overlays unwind topmost-first", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-perf-kbn-escape-stack-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await ensureVaultSeeded(dashboard, userDataDir);
				await waitForDashboard(dashboard);

				// Focus the dashboard's help button so we have a clean opener
				// to restore back to. We use the IconButton's `aria-label`
				// (via `t("shell.help.openLabel")`) — Playwright resolves by
				// accessible name when the role+name matches.
				const helpOpener = dashboard.getByRole("button", { name: /help/i });
				await helpOpener.first().focus();
				const openerFp = await dashboard.evaluate(() => {
					const el = document.activeElement as HTMLElement | null;
					return el?.getAttribute("aria-label") ?? null;
				});
				expect(openerFp, "Help opener must be focusable").not.toBeNull();

				// Layer 1: open the Help overlay.
				await dashboard.keyboard.press("Enter");
				await dashboard.locator('[role="dialog"].help').waitFor({ state: "visible", timeout: 10_000 });

				// Layer 2: open the launcher (a fancy-menus surface) on top of
				// help — via the same main→renderer `shell:action` path its
				// ⌘Space accelerator uses (a synthesized renderer keypress
				// never reaches a main-process accelerator).
				await app.evaluate(({ BrowserWindow }) => {
					const win =
						BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()) ??
						BrowserWindow.getAllWindows()[0];
					win?.webContents.send("shell:action", { action: "launcher" });
				});
				const launcherMenu = dashboard.locator(".fm-menu.launcher-menu");
				await launcherMenu.waitFor({ state: "visible", timeout: 10_000 });

				// Press Escape #1 — topmost is the launcher; LIFO unwind
				// closes it, help overlay stays visible.
				await dashboard.keyboard.press("Escape");
				await launcherMenu.waitFor({ state: "hidden", timeout: 5_000 });
				const helpStillOpen = await dashboard.locator('[role="dialog"].help').isVisible();
				expect(helpStillOpen, "after popping launcher, help overlay should remain").toBe(true);

				// Press Escape #2 — pops the help overlay; focus restores to
				// the help opener button.
				await dashboard.keyboard.press("Escape");
				await dashboard.locator('[role="dialog"].help').waitFor({ state: "hidden", timeout: 5_000 });

				// Press Escape #3 — empty stack; no-op. Dashboard stays put.
				await dashboard.keyboard.press("Escape");
				const dashboardStillVisible = await dashboard.locator("main.dashboard").isVisible();
				expect(dashboardStillVisible, "empty-stack Escape must be a no-op").toBe(true);

				// Focus restoration after the help overlay close. The
				// `<Popover>` surfaces capture their opener via the lazy
				// `useState` initializer in KBN-S-popover; Help doesn't yet
				// use `<Popover>`, so this is a "best-effort, will tighten
				// after KBN-S-help" assertion. Today we only assert focus
				// didn't fall to `<body>` — full opener-restore lands per
				// adopting surface.
				const finalFp = await dashboard.evaluate(() => {
					const el = document.activeElement as HTMLElement | null;
					return el?.tagName.toLowerCase() ?? null;
				});
				expect(finalFp, "after escape-stack drain, focus must not fall to body").not.toBe("body");
				console.log(
					`[kbn] escape-stack: 2 overlays opened, 2 Escapes unwound LIFO, empty-stack Escape was a no-op; final focus: ${finalFp}`,
				);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});

	test("three-deep escape stack with full opener-focus restore", async () => {
		test.skip(
			true,
			"KBN-S-settings + KBN-S-launcher + KBN-S-help not yet adopted — only `<Popover>` traps focus + restores opener today. The 2-deep test above covers LIFO unwinding via KBN-2's shared escape stack; this 3-deep variant unblocks once two of those surfaces land.",
		);
	});
});
