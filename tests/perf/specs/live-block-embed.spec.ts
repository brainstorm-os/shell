/**
 * Real-shell proof for the live BP-block embed feature: a Database embedded
 * into a Notes doc renders the providing app's actual grid (live data) inside
 * the sandboxed block frame, not a static card. Drives the full stack —
 * registry resolution → blocks.source delivery → buildBlockSrcdoc injection →
 * inner transport → BP graph query → grid paint — end to end.
 *
 * History: this spec first surfaced (2026-06-06) that an `srcdoc` iframe
 * INHERITS the embedding document's CSP — the app renderers ship
 * `script-src 'self'`, so the block bundle's inline `<script>` was blocked.
 * Fixed by loading the block document from its own `bsblock://` origin
 * (`main/blocks/block-frame-protocol.ts`) so it carries its own CSP; Notes'
 * CSP grants `frame-src bsblock:`. This spec is the live proof of that path.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell, openAppFromDashboard } from "../lib/launch-shell";

async function openSeededDashboard(page: Page, userDataDir: string): Promise<void> {
	await page.evaluate(
		async ({ d }) => {
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
			await bs.vaults.create({ name: "live-embed", path: `${d}/vault` });
			await bs.vaults.session();
		},
		{ d: userDataDir },
	);
	await page.reload();
	await waitForDashboard(page);
	// Installs the first-party apps from their built `dist/` — including the
	// database/tasks/calendar block bundles (their `build` chains the block
	// build) and the `entityTypes` registrations.
	await page.evaluate(async () => {
		await (
			window as unknown as { brainstorm: { dev: { seedDemoApps: () => Promise<unknown> } } }
		).brainstorm.dev.seedDemoApps();
	});
}

test.describe("live block embed", () => {
	test("a Database embed renders a live grid with rows inside a Notes doc", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-live-embed-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 180_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const editor = notes.locator('[contenteditable="true"]').first();
				await editor.waitFor({ state: "visible", timeout: 20_000 });

				// Build a Database (List) with two member rows, straight through
				// the app's entities service (Notes holds entities.write:*).
				const { listId } = await notes.evaluate(async () => {
					const ent = (
						window as unknown as {
							brainstorm: {
								services: {
									entities: {
										create: (type: string, properties: Record<string, unknown>) => Promise<{ id: string }>;
									};
								};
							};
						}
					).brainstorm.services.entities;
					const now = Date.now();
					const c1 = await ent.create("brainstorm/Object/v1", {
						name: "Acme",
						tier: "A",
						status: "Live",
						createdAt: now,
						updatedAt: now,
					});
					const c2 = await ent.create("brainstorm/Object/v1", {
						name: "Beta",
						tier: "B",
						status: "Lead",
						createdAt: now,
						updatedAt: now,
					});
					const list = await ent.create("brainstorm/List/v1", {
						name: "Clients",
						members: { include: [c1.id, c2.id], exclude: [] },
						views: [],
						createdAt: now,
						updatedAt: now,
					});
					return { listId: list.id };
				});

				// Mount the live Database block (skips the /embed picker's
				// keystrokes, which corrupt the collab editor in headless Electron).
				await notes.evaluate(async (id) => {
					await (
						window as unknown as {
							__brainstormNotesDev: {
								insertEmbed: (
									entityId: string,
									entityType: string,
									label: string,
									blockId: string,
								) => Promise<void>;
							};
						}
					).__brainstormNotesDev.insertEmbed(
						id,
						"brainstorm/List/v1",
						"Clients",
						"io.brainstorm.database/embedded-list",
					);
				}, listId);

				// The BP embed card resolves the live block + mounts the iframe.
				const card = notes.locator(
					'.notes__embed-card--bp[data-block-id="io.brainstorm.database/embedded-list"]',
				);
				await expect(card).toBeVisible({ timeout: 20_000 });
				await expect(card).toHaveAttribute("data-block-live", "true", { timeout: 20_000 });
				await expect(card.locator("iframe.bs-block-frame")).toBeVisible({ timeout: 10_000 });

				// Inside the sandboxed iframe, the real grid paints the live rows.
				const frame = notes.frameLocator(
					'.notes__embed-card--bp[data-block-id="io.brainstorm.database/embedded-list"] iframe',
				);
				await expect(frame.locator(".bsdb__table")).toBeVisible({ timeout: 20_000 });
				await expect(frame.locator(".bsdb__row")).toHaveCount(2, { timeout: 20_000 });
				await expect(frame.getByText("Acme")).toBeVisible();
				await expect(frame.getByText("Lead")).toBeVisible();

				await notes.screenshot({ path: "tests/perf/results/live-embed-database.png" });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
