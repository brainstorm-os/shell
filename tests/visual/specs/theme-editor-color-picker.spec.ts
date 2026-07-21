/**
 * Visual confirmation of the new shared colour picker in Theme Editor.
 *
 * vitest/jsdom can't exercise the fancy-menus runtime (custom-body menu,
 * positioning, the published MenuStore), so this boots the real Electron
 * shell, opens Theme Editor, clicks the first token swatch, and asserts the
 * `@brainstorm-os/sdk/color-picker` menu mounts with its 2D area + hue track +
 * hex field + Apply/Cancel — then drags the saturation area and confirms the
 * hex value changes (live preview path) before screenshotting.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ConsoleMessage, expect, test } from "@playwright/test";
import { waitForAppTabPage } from "../lib/app-window";
import { launchShell } from "../lib/launch-shell";
import { ensureVaultAndSeed } from "../lib/seed-vault";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCREENSHOT_DIR = join(REPO_ROOT, ".screenshots", "theme-editor-color-picker");

test("theme-editor swatch opens the shared rich colour picker menu", async () => {
	test.setTimeout(5 * 60 * 1000);
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-te-color-"));
	const { app } = await launchShell({ userDataDir });
	try {
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("load", { timeout: 60_000 });
		await ensureVaultAndSeed(dashboard, userDataDir);

		const consoleErrors: string[] = [];
		const trackConsole = (msg: ConsoleMessage) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		};

		await dashboard.evaluate(() =>
			(
				window as unknown as { brainstorm: { apps: { launch: (id: string) => Promise<void> } } }
			).brainstorm.apps.launch("io.brainstorm.theme-editor"),
		);
		const te = await waitForAppTabPage(app);
		te.on("console", trackConsole);
		await te.waitForLoadState("load", { timeout: 30_000 });

		// The token grid renders the colour swatches (first tab, default).
		const swatch = te.locator(".te-row__swatch").first();
		await expect(swatch).toBeVisible({ timeout: 30_000 });

		// No picker mounted yet.
		expect(await te.locator(".bs-color-picker").count()).toBe(0);

		await swatch.click();

		// The fancy-menus custom-body picker mounts with all its controls.
		const picker = te.locator(".bs-color-picker");
		await expect(picker).toBeVisible({ timeout: 10_000 });
		await expect(picker.locator(".bs-color-picker__area")).toBeVisible();
		await expect(picker.locator(".bs-color-picker__hue")).toBeVisible();
		const hex = picker.locator(".bs-color-picker__hex");
		await expect(hex).toBeVisible();
		await expect(picker.locator("[data-bs-primary]")).toBeVisible();

		// Anchor reports its open state (aria-expanded) while the picker is up.
		await expect(swatch).toHaveAttribute("aria-expanded", "true");

		const before = await hex.inputValue();

		// Drag across the saturation/value area → live value change.
		const area = picker.locator(".bs-color-picker__area");
		const box = await area.boundingBox();
		if (!box) throw new Error("SV area has no bounding box");
		await te.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
		await te.mouse.down();
		await te.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.2, { steps: 8 });
		await te.mouse.up();
		await te.waitForTimeout(150);

		const after = await hex.inputValue();
		expect(
			after,
			`dragging the SV area must change the hex value (before=${before}, after=${after})`,
		).not.toBe(before);

		await te.screenshot({ path: join(SCREENSHOT_DIR, "01-picker-open.png"), fullPage: false });

		// Apply commits and closes the picker.
		await picker.locator("[data-bs-primary]").click();
		await expect(te.locator(".bs-color-picker")).toHaveCount(0, { timeout: 5_000 });
		await expect(swatch).not.toHaveAttribute("aria-expanded", "true");

		// The committed colour landed in the row's text input + marked it overridden.
		const rowValue = await te.locator(".te-row__value").first().inputValue();
		expect(rowValue.toLowerCase()).toBe(after.toLowerCase());

		expect(
			consoleErrors,
			`unexpected console errors:\n${consoleErrors.map((e) => `  - ${e}`).join("\n")}`,
		).toEqual([]);

		await te.close().catch(() => {});
	} finally {
		await app.close().catch(() => {});
		if (existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true });
	}
});
