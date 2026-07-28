/**
 * Regression spec for the dogfood report "Report on GitHub does nothing"
 * (Help header button). Real shell: create vault → open Help → the feedback
 * dialog renders its opt-in banner → Report-on-GitHub raises a VISIBLE
 * consent/opener prompt (doc-57: an open is never a silent no-op) with no
 * raw `{signature}` ICU template leaking into the copy.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";
import { launchShell } from "../../perf/lib/launch-shell";

test("probe — Help → Report on GitHub", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-ghprobe-"));
	const { app } = await launchShell({ userDataDir });
	const dashboard = await app.firstWindow();
	const logs: string[] = [];
	dashboard.on("console", (m) => logs.push(`[renderer:${m.type()}] ${m.text()}`));
	app.process().stdout?.on("data", (d: Buffer) => logs.push(`[main] ${d.toString().trim()}`));
	app.process().stderr?.on("data", (d: Buffer) => logs.push(`[main:err] ${d.toString().trim()}`));
	try {
		await dashboard.evaluate(
			async ({ userDataDir }) => {
				const bs = (
					window as never as {
						brainstorm: {
							vaults: {
								list: () => Promise<Array<{ id: string }>>;
								create: (o: { name: string; path: string }) => Promise<unknown>;
								activate: (id: string) => Promise<unknown>;
								session: () => Promise<unknown>;
							};
						};
					}
				).brainstorm;
				const list = await bs.vaults.list();
				if (list.length === 0) {
					await bs.vaults.create({ name: "ghprobe", path: `${userDataDir}/vault` });
				} else if (list[0]) {
					await bs.vaults.activate(list[0].id);
				}
				if (!(await bs.vaults.session())) throw new Error("no active vault");
			},
			{ userDataDir },
		);
		await dashboard.waitForTimeout(3000);
		// First boot raises the What's-New popover — dismiss anything modal.
		for (let i = 0; i < 3; i++) {
			if (
				!(await dashboard
					.locator(".popover")
					.first()
					.isVisible()
					.catch(() => false))
			)
				break;
			await dashboard.keyboard.press("Escape");
			await dashboard.waitForTimeout(400);
		}
		// Open Help via its top-bar icon (aria-labelled icon button).
		await dashboard.getByRole("button", { name: /help/i }).first().click();
		await dashboard.waitForSelector('[data-testid="help-report-github"]', { timeout: 10000 });
		// 1) Feedback dialog — the polished opt-in banner.
		await dashboard.click('[data-testid="help-send-feedback"]');
		await dashboard.waitForSelector('[data-testid="feedback-enable"]', { timeout: 10000 });
		await dashboard.screenshot({ path: "/tmp/ghprobe-1-feedback-banner.png" });
		await dashboard.keyboard.press("Escape");
		// 2) Report on GitHub — the intent ladder must raise a visible prompt.
		await dashboard.click('[data-testid="help-report-github"]');
		await dashboard.waitForTimeout(2000);
		const consentPrompt = dashboard.getByText("Open outside the vault?");
		const consentVisible = await consentPrompt.isVisible().catch(() => false);
		const rawTemplateLeak = await dashboard
			.getByText("{signature}")
			.isVisible()
			.catch(() => false);
		await dashboard.screenshot({ path: "/tmp/ghprobe-2-after-click.png" });
		console.log(`PROBE consent-visible=${consentVisible} raw-template-leak=${rawTemplateLeak}`);
		for (const l of logs) console.log(`PROBE ${l}`);
		if (!consentVisible || rawTemplateLeak) throw new Error("probe expectations failed");
	} finally {
		await app.close().catch(() => {});
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
