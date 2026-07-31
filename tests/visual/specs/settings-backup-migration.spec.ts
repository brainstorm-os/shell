/**
 * Guard: Settings → Backup & Migration renders end-to-end in a real shell —
 * the section is reachable from the sidebar nav, every flow card shows its
 * header action, and the Notion API token field rides the shared `<TextField>`
 * face (it once shipped as a raw `bs-input` — an SDK app-side class the shell
 * renderer never loads — and rendered as a bare unstyled native input).
 *
 * Set BACKUP_SHOT=/abs/path.png to also write a screenshot of the panel.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launchShell } from "../lib/launch-shell";

type VaultApi = {
	vaults: {
		list: () => Promise<Array<{ id: string }>>;
		create: (opts: { name: string; path: string }) => Promise<unknown>;
		activate: (id: string) => Promise<unknown>;
		session: () => Promise<unknown>;
	};
};

// Vault-only setup — the panel needs no seeded demo apps, and this spec must
// run in a worktree where the app bundles may not be built.
async function ensureVault(dashboard: Page, userDataDir: string): Promise<void> {
	await dashboard.evaluate(
		async ({ userDataDir }) => {
			const bs = (window as unknown as { brainstorm: VaultApi }).brainstorm;
			const list = await bs.vaults.list();
			let session = await bs.vaults.session();
			if (list.length === 0) {
				await bs.vaults.create({ name: "backup-fixture", path: [userDataDir, "vault"].join("/") });
				session = await bs.vaults.session();
			} else if (!session && list[0]) {
				await bs.vaults.activate(list[0].id);
				session = await bs.vaults.session();
			}
			if (!session) throw new Error("backup-migration spec: no active vault after setup");
		},
		{ userDataDir },
	);
	await dashboard.reload({ waitUntil: "domcontentloaded" });
	await dashboard.waitForSelector(".dashboard", { state: "visible", timeout: 30_000 });
}

test("settings → backup & migration renders the flow cards on shared faces", async () => {
	test.setTimeout(3 * 60 * 1000);
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-backup-ui-"));
	let app: ElectronApplication | null = null;
	try {
		const launched = await launchShell({ userDataDir });
		app = launched.app;
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("load", { timeout: 60_000 });
		await ensureVault(dashboard, userDataDir);

		// Dismiss the "What's New" release popover that pops on a fresh launch.
		await dashboard.keyboard.press("Escape").catch(() => {});
		await dashboard.waitForTimeout(500);

		// Open Settings → Backup & Migration via the sidebar nav.
		await dashboard.locator('.dashboard__header-right button[aria-label="Settings"]').click();
		await dashboard.waitForSelector(".settings__nav", { state: "visible", timeout: 15_000 });
		await dashboard.locator(".settings__nav-item", { hasText: "Backup & Migration" }).first().click();

		const panel = dashboard.locator('[data-testid="backup-migration-panel"]');
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// Every flow card exposes its header action.
		for (const id of [
			"backup-migration-export-btn",
			"backup-migration-import-pick",
			"backup-migration-obsidian-pick",
			"backup-migration-notion-pick",
			"backup-migration-anytype-pick",
		]) {
			await expect(dashboard.locator(`[data-testid="${id}"]`)).toBeVisible();
		}

		// Fresh vault → Notion API is disconnected → the token field shows, and
		// it MUST ride the shared TextField face (not a bare native input).
		const token = dashboard.locator('[data-testid="backup-migration-notion-api-token"]');
		await expect(token).toBeVisible({ timeout: 15_000 });
		await expect(token).toHaveClass(/text-field__input/);
		await expect(token).toHaveAttribute("type", "password");

		const shot = process.env.BACKUP_SHOT;
		if (shot) await panel.screenshot({ path: shot });
	} finally {
		await app?.close().catch(() => {});
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
