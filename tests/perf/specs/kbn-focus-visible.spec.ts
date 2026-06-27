/**
 * KBN-P-focus-visible — `docs/shell/61-keyboard-accessibility.md §Validation`.
 *
 * Three-step modality assertion mirroring the `:focus-visible` standard:
 *   1. Click a focusable button — the button has focus but `:focus-visible`
 *      is NOT applied (no ring on pointer-driven focus).
 *   2. Tab forward — `:focus-visible` IS applied (ring shows on keyboard-
 *      driven focus).
 *   3. Click another button — `:focus-visible` is again NOT applied.
 *
 * This validates both the global `:focus-visible` rule in
 * `packages/shell/src/renderer/styles.css` (KBN-1c) AND the JS-side modality
 * tracker in `@brainstorm/sdk/a11y/use-focus-visible` (KBN-1b) — both must
 * agree, because the JS twin is consumed by surfaces that need to react in
 * JS (virtualized lists scrolling on keyboard focus but not on click).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureVaultSeeded, isFocusVisible, waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

test.describe("KBN-P-focus-visible — pointer vs keyboard modality contract", () => {
	test("click → no ring; Tab → ring; click → no ring", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-perf-kbn-focus-visible-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await ensureVaultSeeded(dashboard, userDataDir);
				await waitForDashboard(dashboard);

				// Pick two stable dashboard chrome buttons by aria-label —
				// Settings and Help — both are always present in the
				// dashboard header right-cluster.
				const settingsBtn = dashboard.getByRole("button", { name: /settings/i }).first();
				const helpBtn = dashboard.getByRole("button", { name: /help/i }).first();
				await settingsBtn.waitFor({ state: "visible", timeout: 10_000 });
				await helpBtn.waitFor({ state: "visible", timeout: 10_000 });

				// All three steps use REAL (trusted) input — a JS-dispatched
				// PointerEvent is untrusted and never updates Chromium's
				// internal input modality, so the original synthesized-event
				// approach asserted nothing.
				const raf = () =>
					dashboard.evaluate(
						() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
					);

				// Step 1 — real pointer click opens Settings; the focus trap
				// places focus programmatically, but the modality is pointer,
				// so the focused element must NOT match :focus-visible.
				await settingsBtn.click();
				await dashboard
					.locator('[data-testid="settings"]')
					.waitFor({ state: "visible", timeout: 10_000 });
				await raf();
				const fv1 = await isFocusVisible(dashboard);
				expect(fv1, "Step 1: pointer-driven focus must NOT set :focus-visible (no ring)").toBe(false);
				console.log(`[kbn] focus-visible step 1 (pointer): :focus-visible = ${fv1}`);

				// Step 2: press Tab. Keyboard-driven focus → ring.
				await dashboard.keyboard.press("Tab");
				await raf();
				const fv2 = await isFocusVisible(dashboard);
				expect(fv2, "Step 2: keyboard-driven focus (Tab) MUST set :focus-visible (ring visible)").toBe(
					true,
				);
				console.log(`[kbn] focus-visible step 2 (Tab): :focus-visible = ${fv2}`);

				// Step 3: real pointer click on a NATIVE button — a theme swatch in
				// Appearance — back to pointer modality, no ring. (A composite sidebar
				// OPTION can't prove this: the composite moves focus PROGRAMMATICALLY,
				// and Chromium keeps :focus-visible across a programmatic focus when
				// the prior element had it. A native <button> gets native click-focus
				// → pointer modality → no ring.)
				await dashboard
					.locator('[data-testid="settings"] nav.settings__nav')
					.getByText("Appearance", { exact: true })
					.click();
				const swatch = dashboard.locator('[data-testid="settings"] [data-theme-id]').first();
				await swatch.waitFor({ state: "visible", timeout: 10_000 });
				await swatch.click();
				await raf();
				const fv3 = await isFocusVisible(dashboard);
				expect(fv3, "Step 3: pointer-driven focus must NOT set :focus-visible (no ring)").toBe(false);
				console.log(`[kbn] focus-visible step 3 (pointer again): :focus-visible = ${fv3}`);
				await dashboard.keyboard.press("Escape");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
