import { ThemeName, themeCatalog } from "@brainstorm-os/tokens";
import { describe, expect, it } from "vitest";
import { ContentKind } from "./kinds";
import { InstallState, ListingSource } from "./listing";
import {
	BUILTIN_SOURCE_NAME,
	type InstalledAppRecord,
	MarketplaceService,
	type RemoteCatalogListing,
} from "./marketplace-service";

const sampleApp: InstalledAppRecord = {
	id: "io.brainstorm.notes",
	name: "Notes",
	version: "1.0.0",
	description: "Plain-text notes — the first-party reference app.",
};

function makeService(opts?: {
	apps?: InstalledAppRecord[];
	catalog?: InstalledAppRecord[];
	theme?: ThemeName | null;
}): MarketplaceService {
	const themeProvided = opts !== undefined && "theme" in opts;
	return new MarketplaceService({
		listInstalledApps: async () => opts?.apps ?? [sampleApp],
		listCatalogApps: async () => opts?.catalog ?? [],
		getActiveTheme: async () => (themeProvided ? (opts?.theme ?? null) : ThemeName.DefaultDark),
	});
}

describe("MarketplaceService", () => {
	it("listings unifies installed apps and every built-in theme", async () => {
		const svc = makeService();
		const all = await svc.listings();
		const apps = all.filter((l) => l.kind === ContentKind.App);
		const themes = all.filter((l) => l.kind === ContentKind.Theme);
		expect(apps).toHaveLength(1);
		expect(themes).toHaveLength(themeCatalog.length);
	});

	it("apps surface installed state and their bundle source", async () => {
		const svc = makeService();
		const all = await svc.listings();
		const note = all.find((l) => l.id === sampleApp.id);
		expect(note).toBeDefined();
		expect(note?.kind).toBe(ContentKind.App);
		expect(note?.installState).toBe(InstallState.Installed);
		expect(note?.source).toBe(ListingSource.Sideload);
		expect(note?.sourceName).toBe(BUILTIN_SOURCE_NAME);
	});

	it("remote-catalog listings surface as Catalog/NotInstalled, deduped against installed + built-in", async () => {
		const remote: RemoteCatalogListing[] = [
			// Duplicate of the installed app — installed row wins, not listed again.
			{ id: "io.brainstorm.notes", name: "Notes", version: "2.0.0", sourceName: "Brainstorm" },
			// Duplicate of a built-in catalog app — built-in wins.
			{ id: "io.brainstorm.graph", name: "Graph", version: "2.0.0", sourceName: "Brainstorm" },
			// Genuinely remote-only (third-party / not bundled).
			{
				id: "io.acme.widget",
				name: "Widget",
				version: "0.3.1",
				summary: "A third-party widget.",
				sourceName: "Acme Catalog",
			},
		];
		const svc = new MarketplaceService({
			listInstalledApps: async () => [sampleApp],
			listCatalogApps: async () => [{ id: "io.brainstorm.graph", name: "Graph", version: "1.0.0" }],
			listRemoteCatalogListings: async () => remote,
			getActiveTheme: async () => null,
		});
		const all = await svc.listings();
		const widget = all.find((l) => l.id === "io.acme.widget");
		expect(widget?.source).toBe(ListingSource.Catalog);
		expect(widget?.installState).toBe(InstallState.NotInstalled);
		expect(widget?.sourceName).toBe("Acme Catalog");
		expect(widget?.summary).toBe("A third-party widget.");
		// No id appears twice — installed/built-in win over the remote duplicates.
		const notesRows = all.filter((l) => l.id === "io.brainstorm.notes");
		const graphRows = all.filter((l) => l.id === "io.brainstorm.graph");
		expect(notesRows).toHaveLength(1);
		expect(notesRows[0]?.installState).toBe(InstallState.Installed);
		expect(graphRows).toHaveLength(1);
		expect(graphRows[0]?.source).toBe(ListingSource.BuiltIn);
	});

	it("app manifest description surfaces as the listing summary", async () => {
		const svc = makeService();
		const all = await svc.listings();
		const note = all.find((l) => l.id === sampleApp.id);
		expect(note?.summary).toBe(sampleApp.description);
	});

	it("apps without a manifest description omit the summary field", async () => {
		const svc = makeService({
			apps: [{ id: "io.brainstorm.legacy", name: "Legacy", version: "0.0.1" }],
		});
		const all = await svc.listings();
		const legacy = all.find((l) => l.id === "io.brainstorm.legacy");
		expect(legacy).toBeDefined();
		expect(legacy?.summary).toBeUndefined();
	});

	it("the active theme reports Active; the other built-ins report Installed", async () => {
		const svc = makeService({ theme: ThemeName.Sepia });
		const all = await svc.listings();
		const sepia = all.find((l) => l.id === ThemeName.Sepia);
		const dark = all.find((l) => l.id === ThemeName.DefaultDark);
		expect(sepia?.installState).toBe(InstallState.Active);
		expect(dark?.installState).toBe(InstallState.Installed);
		expect(dark?.source).toBe(ListingSource.BuiltIn);
	});

	it("when no active theme is set every built-in still surfaces as Installed", async () => {
		const svc = makeService({ theme: null });
		const all = await svc.listings();
		const themes = all.filter((l) => l.kind === ContentKind.Theme);
		expect(themes.every((t) => t.installState === InstallState.Installed)).toBe(true);
	});

	it("theme listings carry the catalog preview so the renderer can paint a swatch", async () => {
		const svc = makeService();
		const all = await svc.listings();
		for (const entry of themeCatalog) {
			const listing = all.find((l) => l.id === entry.id);
			expect(listing?.preview).toEqual(entry.preview);
		}
	});

	it("installed() filters out NotInstalled rows", async () => {
		const svc = makeService();
		const installed = await svc.installed();
		// Everything we currently surface is installed (apps registered;
		// themes built-in). When the catalog ships remote listings, this
		// assertion turns into a strict subset check.
		const all = await svc.listings();
		expect(installed).toHaveLength(all.length);
		expect(installed.every((l) => l.installState !== InstallState.NotInstalled)).toBe(true);
	});

	it("a catalog app that isn't installed surfaces as NotInstalled and BuiltIn", async () => {
		const svc = makeService({
			apps: [],
			catalog: [{ id: "io.brainstorm.graph", name: "Graph", version: "0.1.0" }],
		});
		const all = await svc.listings();
		const graph = all.find((l) => l.id === "io.brainstorm.graph");
		expect(graph).toBeDefined();
		expect(graph?.kind).toBe(ContentKind.App);
		expect(graph?.installState).toBe(InstallState.NotInstalled);
		expect(graph?.source).toBe(ListingSource.BuiltIn);
	});

	it("an installed catalog app is listed once, as Installed (not duplicated)", async () => {
		const svc = makeService({
			apps: [sampleApp],
			catalog: [{ id: sampleApp.id, name: sampleApp.name, version: "9.9.9" }],
		});
		const all = await svc.listings();
		const notes = all.filter((l) => l.id === sampleApp.id);
		expect(notes).toHaveLength(1);
		expect(notes[0]?.installState).toBe(InstallState.Installed);
		expect(notes[0]?.version).toBe(sampleApp.version);
	});

	it("installed() excludes NotInstalled catalog apps but keeps installed ones", async () => {
		const svc = makeService({
			apps: [sampleApp],
			catalog: [{ id: "io.brainstorm.graph", name: "Graph", version: "0.1.0" }],
			theme: null,
		});
		const installed = await svc.installed();
		expect(installed.some((l) => l.id === sampleApp.id)).toBe(true);
		expect(installed.some((l) => l.id === "io.brainstorm.graph")).toBe(false);
		expect(installed.every((l) => l.installState !== InstallState.NotInstalled)).toBe(true);
	});

	it("listings with no installed apps still surface every theme", async () => {
		const svc = makeService({ apps: [] });
		const all = await svc.listings();
		expect(all.every((l) => l.kind === ContentKind.Theme)).toBe(true);
		expect(all).toHaveLength(themeCatalog.length);
	});
});
