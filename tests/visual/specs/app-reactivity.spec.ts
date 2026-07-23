/**
 * Interactive app-reactivity verifier (functional; runs under the visual/e2e
 * harness against the production-built shell).
 *
 * For each app it opens the app against a seeded vault, then — through the live
 * `entities` service the app itself uses — CREATES, EDITS, and DELETES an entity
 * of the app's own type and asserts the app's view reflects each change WITHOUT
 * a reopen. This is the one bug class the static gates + mocked-service unit
 * tests structurally cannot catch: the `vaultEntities.onChange → re-render`
 * reactivity, plus dead create/edit/delete plumbing.
 *
 * The assertion is selector-free: a unique marker title is written, then found
 * by visible text — so it survives per-app list-markup differences and only
 * fails when the app genuinely doesn't repaint. Every flow is isolated; a
 * summary + failure screenshots land in the scratch dir, and the test goes red
 * if any app's create/edit/delete didn't propagate live.
 *
 * Extend by adding a `Flow` to `FLOWS` — `{ appId, type, titleProp }` plus an
 * optional `prepare` to navigate to a view where the new entity is visible.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { waitForAppTabPage } from "../lib/app-window";
import { launchShell } from "../lib/launch-shell";
import { ensureVaultAndSeed } from "../lib/seed-vault";

// Artifacts (summary.json + failure screenshots) land in a temp dir so the
// spec is portable across dev machines and CI.
const OUT = join(tmpdir(), "bs-app-reactivity");

type Flow = {
	readonly app: string;
	readonly appId: string;
	/** The BP type the app owns (and holds `entities.write:<type>` for). */
	readonly type: string;
	/** Property that renders as the item's visible label. */
	readonly titleProp: string;
	/** Extra required props so `create` validates (e.g. a Bookmark needs a url). */
	readonly extra?: Record<string, unknown>;
	/** Navigate to a view where a freshly-created entity is visible. */
	readonly prepare?: (page: Page) => Promise<void>;
};

const FLOWS: readonly Flow[] = [
	// Notes maps a bare `{ title }` entity straight into its all-notes list, so a
	// minimal create is enough to exercise the create → onChange → repaint path.
	{
		app: "notes",
		appId: "io.brainstorm.notes",
		type: "io.brainstorm.notes/Note/v1",
		titleProp: "title",
	},
	// EXTENDING TO MORE APPS: codec-backed apps (Tasks, Bookmarks, Contacts, …)
	// read their list through an app codec over the same `vaultEntities`
	// subscription, so a *bare* `entities.create` lands a real entity that the
	// codec doesn't surface — its `listAll()` expects app-domain properties
	// (e.g. a Task's status, a Bookmark's canonical fields). Verified: the
	// reactivity plumbing is identical to Notes (a bare Task/Bookmark create
	// fires onChange but its default view filters an under-specified entity out —
	// NOT a reactivity bug). To add such an app, supply `type` + the full
	// `extra` props its codec requires, and a `prepare` that lands the entity in
	// a visible view, then confirm a manual create shows before trusting it here.
];

type EntitiesCall = { m: "create" | "update" | "delete"; a: unknown[] };
async function ent(page: Page, call: EntitiesCall): Promise<{ id?: string; error?: string }> {
	return page.evaluate(async ({ m, a }) => {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: raw preload surface in the page context.
			const svc = (window as any).brainstorm?.services?.entities;
			if (!svc) return { error: "no entities service on window.brainstorm.services" };
			// biome-ignore lint/suspicious/noExplicitAny: dynamic method dispatch.
			const out = await (svc as any)[m](...a);
			return { id: out?.id as string | undefined };
		} catch (e) {
			return { error: (e as Error).message };
		}
	}, call);
}

async function textLive(page: Page, marker: string, timeout: number): Promise<boolean> {
	return page
		.getByText(marker, { exact: false })
		.first()
		.waitFor({ state: "visible", timeout })
		.then(() => true)
		.catch(() => false);
}

async function textGone(page: Page, marker: string, timeout: number): Promise<boolean> {
	return expect(page.getByText(marker, { exact: false }))
		.toHaveCount(0, { timeout })
		.then(() => true)
		.catch(() => false);
}

test("apps react live to create / edit / delete through the entities service", async () => {
	test.setTimeout(15 * 60 * 1000);
	mkdirSync(OUT, { recursive: true });
	const userDataDir = `${OUT}/userdata`;
	mkdirSync(userDataDir, { recursive: true });

	const { app } = await launchShell({ userDataDir });
	const dashboard = await app.firstWindow({ timeout: 60_000 });
	await dashboard.waitForLoadState("load", { timeout: 60_000 });
	await ensureVaultAndSeed(dashboard, userDataDir);

	const seen = new Set<Page>(app.windows());
	const results: Array<Record<string, unknown>> = [];

	for (const flow of FLOWS) {
		const rec: Record<string, unknown> = { app: flow.app, create: false, edit: false, del: false };
		const consoleErrors: string[] = [];
		try {
			await dashboard.evaluate(
				(id) =>
					// biome-ignore lint/suspicious/noExplicitAny: raw preload surface.
					(window as any).brainstorm.apps.launch(id),
				flow.appId,
			);
			const page = await waitForAppTabPage(app, { timeout: 30_000, ignore: seen });
			seen.add(page);
			page.on("console", (m) => {
				if (m.type() === "error") consoleErrors.push(m.text());
			});
			await page.waitForLoadState("load", { timeout: 30_000 });
			await flow.prepare?.(page);
			await page.waitForTimeout(500);

			const marker = `VERIFY-${flow.app}-${Date.now()}`;
			const created = await ent(page, {
				m: "create",
				a: [flow.type, { [flow.titleProp]: marker, ...flow.extra }],
			});
			rec.createError = created.error ?? null;
			rec.create = created.id ? await textLive(page, marker, 12_000) : false;

			const edited = `${marker}-EDITED`;
			if (created.id) {
				const up = await ent(page, { m: "update", a: [created.id, { [flow.titleProp]: edited }] });
				rec.editError = up.error ?? null;
				rec.edit = await textLive(page, edited, 12_000);

				const del = await ent(page, { m: "delete", a: [created.id] });
				rec.delError = del.error ?? null;
				rec.del = await textGone(page, edited, 12_000);
			}
			rec.consoleErrors = consoleErrors.slice(0, 8);
			if (!rec.create || !rec.edit || !rec.del) {
				await page.screenshot({ path: `${OUT}/${flow.app}-fail.png` }).catch(() => {});
			}
		} catch (error) {
			rec.fatal = (error as Error).message;
		}
		results.push(rec);
		writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 2));
	}

	console.log(`REACTIVITY ${JSON.stringify(results)}`);
	for (const r of results) {
		expect(r.create, `${r.app}: create did not appear live (${r.createError ?? ""})`).toBe(true);
		expect(r.edit, `${r.app}: edit did not propagate live (${r.editError ?? ""})`).toBe(true);
		expect(r.del, `${r.app}: delete did not remove live (${r.delError ?? ""})`).toBe(true);
	}
});
