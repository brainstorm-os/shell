/**
 * Chat rich composer end-to-end proof (2026-07-03).
 *
 * Drives the production shell through the Slack-style chat composer work:
 *
 *   1. The floating inline-format toolbar renders as a HORIZONTAL pill in
 *      chat. Regression for the `.fm-menu` cascade bug — in chat's bundle
 *      order the fancy-menus base (`flex-direction: column; overflow:
 *      hidden`) loaded after `editor-theme.css` and won the tie, so the
 *      toolbar painted as a clipped vertical stack of buttons.
 *   2. The toolbar's list toggles + Markdown shortcuts produce real list
 *      blocks in the draft, Shift+Enter starts the next item, and a sent
 *      message renders the same list back through `renderEditorState`.
 *   3. `[ ] ` converts to a to-do (check) list item and survives the send
 *      round-trip with its checkbox face.
 *
 * jsdom can't exercise any of this (real contenteditable + CSS cascade), so
 * it lives in the visual harness. Screenshots land in
 * `.screenshots/chat-rich-composer/`.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { launchAppPage } from "../lib/app-window";
import { launchShell } from "../lib/launch-shell";
import { ensureVaultAndSeed } from "../lib/seed-vault";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCREENSHOT_DIR = join(REPO_ROOT, ".screenshots", "chat-rich-composer");

const SELECT_ALL = process.platform === "darwin" ? "Meta+a" : "Control+a";

async function openComposerChannel(chat: Page): Promise<void> {
	// A fresh vault has no channels — the empty state's primary CTA opens the
	// new-channel popover. A seeded vault may land directly in a channel.
	const noChannel = chat.getByTestId("no-channel");
	if (await noChannel.isVisible().catch(() => false)) {
		await noChannel.getByRole("button", { name: "New channel" }).click();
	} else {
		await chat.getByRole("button", { name: "New channel" }).first().click();
	}
	await chat.getByPlaceholder("e.g. general").fill("rich-composer");
	await chat.getByRole("button", { name: "Create channel" }).click();
	await expect(chat.locator(".chat__composer .bs-compact-editor__content")).toBeVisible();
}

test("chat composer — horizontal toolbar, lists, check items, rich send round-trip", async () => {
	test.setTimeout(5 * 60 * 1000);
	mkdirSync(SCREENSHOT_DIR, { recursive: true });
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-chat-rich-"));
	const { app } = await launchShell({ userDataDir });
	try {
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("load", { timeout: 60_000 });
		await ensureVaultAndSeed(dashboard, userDataDir);

		const chat = await launchAppPage(app, dashboard, "io.brainstorm.chat");
		await openComposerChannel(chat);

		const editable = chat.locator(".chat__composer .bs-compact-editor__content");
		await editable.click();

		// ── 1. Toolbar geometry (the regression) ──────────────────────────
		await editable.pressSequentially("hello toolbar", { delay: 10 });
		await chat.keyboard.press(SELECT_ALL);
		const toolbar = chat.locator(".notes__inline-toolbar");
		await expect(toolbar).toBeVisible();
		const geom = await toolbar.evaluate((el) => {
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return { direction: cs.flexDirection, overflow: cs.overflow, w: r.width, h: r.height };
		});
		expect(geom.direction).toBe("row");
		expect(geom.overflow).toBe("visible");
		// A horizontal pill: much wider than tall (the broken state was ~40px
		// wide and clipped to two stacked buttons).
		expect(geom.w).toBeGreaterThan(geom.h * 3);
		await chat.screenshot({ path: join(SCREENSHOT_DIR, "01-toolbar-horizontal.png") });

		// ── 2. Toolbar bullet-list toggle + Shift+Enter next item + send ──
		await toolbar.getByRole("button", { name: "Bulleted list" }).click();
		await expect(chat.locator(".chat__composer ul.bs-editor__list--bullet")).toBeVisible();
		await chat.keyboard.press("End");
		await chat.keyboard.press("Shift+Enter");
		await editable.pressSequentially("second bullet", { delay: 10 });
		await expect(chat.locator(".chat__composer .bs-editor__list-item")).toHaveCount(2);
		await chat.screenshot({ path: join(SCREENSHOT_DIR, "02-composer-bullets.png") });
		await chat.keyboard.press("Enter");

		const sentBullets = chat.locator(".chat__line--rich ul.bs-editor__list--bullet");
		await expect(sentBullets).toBeVisible();
		await expect(sentBullets.locator("li")).toHaveCount(2);

		// ── 3. Markdown `[ ] ` → to-do item, round-trips with checkbox ────
		await editable.click();
		await editable.pressSequentially("[ ] buy milk", { delay: 10 });
		await expect(chat.locator(".chat__composer .bs-editor__list-item--unchecked")).toBeVisible();
		await chat.keyboard.press("Enter");
		await expect(
			chat.locator(".chat__line--rich .bs-editor__list-item--unchecked"),
		).toBeVisible();

		// ── 4. Markdown `1. ` → numbered list in the draft ────────────────
		await editable.pressSequentially("1. first step", { delay: 10 });
		await expect(chat.locator(".chat__composer ol.bs-editor__list--numbered")).toBeVisible();
		await chat.keyboard.press("Enter");
		await expect(chat.locator(".chat__line--rich ol.bs-editor__list--numbered")).toBeVisible();
		await chat.screenshot({ path: join(SCREENSHOT_DIR, "03-sent-lists.png") });
	} finally {
		await app.close();
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
