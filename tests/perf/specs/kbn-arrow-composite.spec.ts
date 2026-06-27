/**
 * KBN-P-arrow-composite — `docs/shell/61-keyboard-accessibility.md §Validation`.
 *
 * For a surface that's adopted `useCompositeKeyboard`, drive the arrow keys
 * and assert the composite-listbox contract:
 *   - the active index advances per the orientation (Vertical → ArrowDown +1,
 *     ArrowUp −1)
 *   - the container carries the hook-stamped `role="listbox"` +
 *     `aria-orientation="vertical"` (the role flows through the SDK, never
 *     hand-written — KBN-G-roles)
 *   - `aria-selected` mirrors the active item
 *   - `:focus-visible` is true after the arrow press (keyboard modality)
 *
 * Activated by KBN-S-settings (2026-05-28): the Settings sidebar nav is the
 * first composite-keyboard adopter. Home anchors the cursor deterministically
 * before the directional asserts so the spec doesn't depend on which section
 * the overlay opens to.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	ensureVaultSeeded,
	isFocusVisible,
	openSettings,
	waitForDashboard,
} from "../lib/keyboard-assertions";
import { launchShell } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

// The composite controls the list via `aria-activedescendant`: focus stays on
// the container, and the active option is the one whose `id` matches the
// container's `aria-activedescendant` (it carries `data-composite-index`). Fall
// back to the focused element itself for a roving-tabindex composite.
const ACTIVE_INDEX = () => {
	const active = document.activeElement;
	const option = active?.hasAttribute("data-composite-index")
		? active
		: document.getElementById(active?.getAttribute("aria-activedescendant") ?? "");
	return option?.getAttribute("data-composite-index") ?? null;
};

test.describe("KBN-P-arrow-composite — arrow navigation inside composites", () => {
	test("settings sidebar arrow navigation", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-perf-kbn-arrow-composite-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const win = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(win);
				await ensureVaultSeeded(win, userDataDir);
				await waitForDashboard(win);
				await openSettings(win);

				// The hook stamps the container role + orientation — never
				// hand-written in settings.tsx (KBN-G-roles).
				const listbox = win.locator('[data-testid="settings"] nav.settings__nav');
				await expect(listbox).toHaveAttribute("role", "listbox", { timeout: 15_000 });
				await expect(listbox).toHaveAttribute("aria-orientation", "vertical", { timeout: 5_000 });

				// Anchor the cursor: focus the listbox container (always tab-stop
				// `tabIndex 0` via containerProps), then Home → index 0. Explicit
				// short timeout so a contract miss fails fast, never hangs to the
				// test timeout.
				await listbox.focus({ timeout: 15_000 });
				// Engage the roving cursor: focusing the container alone doesn't move
				// into the list while the cursor is already at 0 (Home would be a
				// no-op), so ArrowDown roves focus onto an option first; Home then
				// anchors deterministically back at the first.
				await win.keyboard.press("ArrowDown");
				await win.keyboard.press("Home");
				const atHome = await win.evaluate(ACTIVE_INDEX);
				expect(atHome, "Home lands on the first option").toBe("0");

				// ArrowDown advances the active index; aria-selected mirrors it;
				// focus arrived via keyboard so :focus-visible is true.
				await win.keyboard.press("ArrowDown");
				const afterDown = await win.evaluate(() => {
					const active = document.activeElement;
					const el = active?.hasAttribute("data-composite-index")
						? active
						: document.getElementById(active?.getAttribute("aria-activedescendant") ?? "");
					return {
						index: el?.getAttribute("data-composite-index") ?? null,
						selected: el?.getAttribute("aria-selected") ?? null,
						role: el?.getAttribute("role") ?? null,
					};
				});
				expect(afterDown.index, "ArrowDown advances the active index").toBe("1");
				expect(afterDown.selected, "aria-selected mirrors the active item").toBe("true");
				expect(afterDown.role, "the active item is an option").toBe("option");
				expect(await isFocusVisible(win), ":focus-visible after a keyboard arrow").toBe(true);

				// ArrowUp returns to the first option.
				await win.keyboard.press("ArrowUp");
				const afterUp = await win.evaluate(ACTIVE_INDEX);
				expect(afterUp, "ArrowUp returns to the first option").toBe("0");

				console.log("[kbn] arrow-composite settings sidebar: Home/ArrowDown/ArrowUp contract holds");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
