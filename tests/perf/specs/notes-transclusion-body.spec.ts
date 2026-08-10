/**
 * B6.4b — transclusion live body preview (nested mount). A `TransclusionNode`
 * resolves the target entity's Y.Doc through `useYDoc(entityId)` and paints
 * its body inline via a nested read-only `<BrainstormEditor>`, gated on
 * `decideTransclusionRender` for depth/cycle.
 *
 * Verified in the real shell: a note H gets a recognizable marker in its body;
 * a second note T transcludes H; T's editor then shows H's marker inside the
 * `.notes__transclusion-body-content` nested surface. Driven through the
 * `__brainstormNotesDev` hooks (Playwright keystrokes corrupt the Yjs editor).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell, openAppFromDashboard } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

const MARKER = "BS-XCLUDE-MARKER-9b4f";
const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

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
			await bs.vaults.create({ name: "fm-xclude-body", path: `${d}/vault` });
			await bs.vaults.session();
		},
		{ d: userDataDir },
	);
	await page.reload();
	await waitForDashboard(page);
	await page.evaluate(async () => {
		await (
			window as unknown as { brainstorm: { dev: { seedDemoApps: () => Promise<unknown> } } }
		).brainstorm.dev.seedDemoApps();
	});
}

type NotesDev = {
	appendParagraph: (text: string) => Promise<void>;
	insertTransclusion: (entityId: string, entityType: string, label: string) => Promise<void>;
	currentNoteId: () => string | null;
};

function notesDev(page: Page): {
	append: (text: string) => Promise<void>;
	insert: (id: string, type: string, label: string) => Promise<void>;
	current: () => Promise<string | null>;
} {
	return {
		append: (text) =>
			page.evaluate(
				(t) =>
					(window as unknown as { __brainstormNotesDev: NotesDev }).__brainstormNotesDev.appendParagraph(
						t,
					),
				text,
			),
		insert: (id, type, label) =>
			page.evaluate(
				(a) =>
					(
						window as unknown as { __brainstormNotesDev: NotesDev }
					).__brainstormNotesDev.insertTransclusion(a.id, a.type, a.label),
				{ id, type, label },
			),
		current: () =>
			page.evaluate(() =>
				(window as unknown as { __brainstormNotesDev: NotesDev }).__brainstormNotesDev.currentNoteId(),
			),
	};
}

test.describe("notes transclusion body preview (B6.4b)", () => {
	test("a transcluded note paints its body inline (read-only)", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-xclude-body-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				await notes.locator('[contenteditable="true"]').first().waitFor({
					state: "visible",
					timeout: 20_000,
				});
				const dev = notesDev(notes);

				// Host note H: seed a recognizable marker into its body, capture its id.
				await dev.append(MARKER);
				const hostId = await dev.current();
				expect(hostId, "host note id resolved").toBeTruthy();

				// New note T becomes the open editor.
				await notes.getByRole("button", { name: "New note" }).click();
				await expect.poll(async () => dev.current(), { timeout: 10_000 }).not.toBe(hostId);

				// T transcludes H. H is a different note, so the render guard renders
				// (no cycle); the nested editor resolves H's Y.Doc and paints MARKER.
				await dev.insert(hostId as string, NOTE_TYPE, "Host");

				const body = notes.locator(".notes__transclusion-body-content");
				await expect(notes.locator('.notes__transclusion[data-decision="render"]')).toBeVisible({
					timeout: 10_000,
				});
				await expect
					.poll(async () => (await body.innerText()).includes(MARKER), {
						timeout: 15_000,
					})
					.toBe(true);
				// The nested body is non-editable.
				await expect(body).toHaveAttribute("contenteditable", "false");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
