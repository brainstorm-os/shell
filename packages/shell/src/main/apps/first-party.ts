/**
 * First-party app catalog — the apps that ship with the product.
 *
 * This list is the **canonical catalog** of built-in apps, independent of
 * what's currently installed in the active vault. The marketplace reads it
 * so first-party apps stay visible (as reinstallable) after uninstall — the
 * registry's active rows only describe what's installed *right now*, not
 * what the product offers (per §The Marketplace
 * surface; bug: uninstall removed apps from the store entirely).
 *
 * It also drives the dev seeder (`dev/seed-demo-apps.ts`). The seeder
 * re-exports `FIRST_PARTY_APPS` / `FirstPartyApp` for back-compat with
 * existing import sites.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type FirstPartyApp = {
	/** Directory name under `apps/`. */
	dir: string;
	/** Display label for the pinned dashboard icon. */
	label: string;
	/** Expected `manifest.id` — verified post-install for defensive symmetry. */
	expectedAppId: string;
};

/** The bundled apps the product ships. Order matters for dashboard pin
 *  placement — earlier entries occupy lower-numbered grid cells. Real
 *  (built) apps pin first; the remaining coming-soon stubs follow. */
export const FIRST_PARTY_APPS: ReadonlyArray<FirstPartyApp> = [
	{ dir: "notes", label: "Notes", expectedAppId: "io.brainstorm.notes" },
	{ dir: "files", label: "Files", expectedAppId: "io.brainstorm.files" },
	{ dir: "database", label: "Database", expectedAppId: "io.brainstorm.database" },
	{ dir: "graph", label: "Graph", expectedAppId: "io.brainstorm.graph" },
	{ dir: "tasks", label: "Tasks", expectedAppId: "io.brainstorm.tasks" },
	{ dir: "calendar", label: "Calendar", expectedAppId: "io.brainstorm.calendar" },
	{ dir: "journal", label: "Journal", expectedAppId: "io.brainstorm.journal" },
	{ dir: "preview", label: "Preview", expectedAppId: "io.brainstorm.preview" },
	{ dir: "code-editor", label: "Code", expectedAppId: "io.brainstorm.code-editor" },
	{ dir: "whiteboard", label: "Whiteboard", expectedAppId: "io.brainstorm.whiteboard" },
	{ dir: "bookmarks", label: "Bookmarks", expectedAppId: "io.brainstorm.bookmarks" },
	// Graduated from coming-soon stubs into real apps — pinned with the built
	// set (Theme-editor 9.9, Contacts 9.23, Automations 11b, Mailbox-1/2/3/7,
	// Web Browser Browser-1/2/3, Books 9.21.1→.6).
	{ dir: "theme-editor", label: "Themes", expectedAppId: "io.brainstorm.theme-editor" },
	{ dir: "contacts", label: "Contacts", expectedAppId: "io.brainstorm.contacts" },
	{ dir: "automations", label: "Automations", expectedAppId: "io.brainstorm.automations" },
	{ dir: "mailbox", label: "Mailbox", expectedAppId: "io.brainstorm.mailbox" },
	{ dir: "browser", label: "Browser", expectedAppId: "io.brainstorm.browser" },
	{ dir: "books", label: "Books", expectedAppId: "io.brainstorm.books" },
	{ dir: "chat", label: "Chat", expectedAppId: "io.brainstorm.chat" },
	// Still coming-soon stubs — registered + launchable, body is the shared
	// `@brainstorm/sdk/coming-soon` placeholder until each real build lands.
	{ dir: "form-designer", label: "Forms", expectedAppId: "io.brainstorm.form-designer" },
	{ dir: "agent", label: "Agent", expectedAppId: "io.brainstorm.agent" },
];

/**
 * The offline bootstrap set the production installer (`bootstrapApps`, 14.30)
 * installs on a fresh vault's first run, with no network. This is **every**
 * first-party app — they are all bundled in the binary (`extraResources`), so
 * they all install offline. The catalog (14.31+) is for *updates* to these and
 * for *third-party* apps, not for gating bundled first-party apps: a curated
 * subset would strand the rest (`code-editor` NotInstalled) until a live
 * catalog serves them, which the shipped/dogfood shell doesn't yet. (OQ-LC-1
 * resolved: bootstrap = all bundled first-party, not a curated few.)
 */
export const BOOTSTRAP_APPS: ReadonlyArray<FirstPartyApp> = FIRST_PARTY_APPS;

/** `apps/` lives at `<repo>/apps/`, i.e. `../../../../apps` from the
 *  compiled main entry (`packages/shell/out/main/`). Both the dev seeder
 *  and the marketplace install path resolve it the same way — keep this the
 *  single source of that relative walk. */
export function firstPartyAppsDir(mainDir: string): string {
	return join(mainDir, "..", "..", "..", "..", "apps");
}

export function firstPartyAppById(appId: string): FirstPartyApp | undefined {
	return FIRST_PARTY_APPS.find((app) => app.expectedAppId === appId);
}

export type FirstPartyCatalogEntry = {
	id: string;
	name: string;
	version: string;
	description?: string;
};

/**
 * Read every first-party app's `manifest.json` from disk to build the
 * catalog. Per-entry soft-fail: a missing/unreadable manifest (e.g. a
 * not-yet-scaffolded app dir, or a packaged build with no `apps/` tree)
 * is skipped, so the catalog degrades to "whatever we can read" rather
 * than throwing the whole marketplace listing call.
 */
export async function readFirstPartyCatalog(appsDir: string): Promise<FirstPartyCatalogEntry[]> {
	const entries = await Promise.all(
		FIRST_PARTY_APPS.map(async (app): Promise<FirstPartyCatalogEntry | null> => {
			try {
				const raw = await readFile(join(appsDir, app.dir, "manifest.json"), "utf8");
				const manifest = JSON.parse(raw) as {
					id?: unknown;
					name?: unknown;
					version?: unknown;
					description?: unknown;
				};
				if (typeof manifest.id !== "string" || manifest.id.length === 0) return null;
				const name =
					typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : app.label;
				const version =
					typeof manifest.version === "string" && manifest.version.length > 0
						? manifest.version
						: "0.0.0";
				const description =
					typeof manifest.description === "string" && manifest.description.length > 0
						? manifest.description
						: undefined;
				return description !== undefined
					? { id: manifest.id, name, version, description }
					: { id: manifest.id, name, version };
			} catch {
				return null;
			}
		}),
	);
	return entries.filter((entry): entry is FirstPartyCatalogEntry => entry !== null);
}
