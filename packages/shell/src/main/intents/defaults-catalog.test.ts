import { describe, expect, it } from "vitest";
import {
	DEFAULT_HANDLER_VERB,
	GENERIC_OBJECT_EDITOR_APP_ID,
	OS_HANDOFF_APP_ID,
	OS_HANDOFF_APP_LABEL,
	buildDefaultsCatalog,
} from "./defaults-catalog";

describe("buildDefaultsCatalog", () => {
	const base = {
		appLabel: (id: string) => id.replace("io.brainstorm.", ""),
		genericEditorAppId: GENERIC_OBJECT_EDITOR_APP_ID,
		currentDefaults: {} as Record<string, string>,
	};

	it("offers capable apps ∪ the generic editor, deduped + label-sorted", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			entityTypes: ["brainstorm/Person/v1"],
			capableApps: () => ["io.brainstorm.database", "io.brainstorm.notes"],
		});
		expect(catalog.verb).toBe(DEFAULT_HANDLER_VERB);
		const entry = catalog.entries[0];
		expect(entry?.entityType).toBe("brainstorm/Person/v1");
		expect(entry?.label).toBe("Person");
		// notes appears once (capable + generic), database too; sorted by label.
		expect(entry?.apps.map((a) => a.appId)).toEqual([
			"io.brainstorm.database",
			"io.brainstorm.notes",
		]);
		expect(entry?.defaultAppId).toBeNull();
	});

	it("drops types no app claims — generic editor alone is not enough (F-414)", () => {
		// Pre-F-414 every type inherited Notes as a pick and flooded the
		// list with TokenSet / WhiteboardEdge / AutomationHostDesignation.
		const catalog = buildDefaultsCatalog({
			...base,
			entityTypes: ["brainstorm/Person/v1", "brainstorm/TokenSet/v1"],
			capableApps: (type) => (type === "brainstorm/Person/v1" ? ["io.brainstorm.contacts"] : []),
		});
		expect(catalog.entries.map((e) => e.entityType)).toEqual(["brainstorm/Person/v1"]);
		expect(catalog.entries[0]?.label).toBe("Person");
	});

	it("drops plumbing types even when an opener claims them (F-414)", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			entityTypes: ["brainstorm/Person/v1", "brainstorm/BrowsingSession/v1"],
			capableApps: () => ["io.brainstorm.browser"],
		});
		expect(catalog.entries.map((e) => e.entityType)).toEqual(["brainstorm/Person/v1"]);
	});

	it("reflects the current pin from the dashboard snapshot", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			entityTypes: ["brainstorm/Person/v1"],
			capableApps: () => ["io.brainstorm.database"],
			currentDefaults: { "open:brainstorm/Person/v1": "io.brainstorm.database" },
		});
		expect(catalog.entries[0]?.defaultAppId).toBe("io.brainstorm.database");
	});

	it("sorts entity types by human label and omits a pin for an unrelated key", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			entityTypes: ["brainstorm/Zebra/v1", "brainstorm/Apple/v1"],
			capableApps: () => ["io.brainstorm.notes"],
			currentDefaults: { "open:something/else/v1": "io.brainstorm.notes" },
		});
		expect(catalog.entries.map((e) => e.label)).toEqual(["Apple", "Zebra"]);
		expect(catalog.entries.every((e) => e.defaultAppId === null)).toBe(true);
	});

	it("a null generic editor isn't injected (keeps the builder pure)", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			genericEditorAppId: null,
			entityTypes: ["t/T/v1"],
			capableApps: () => ["io.brainstorm.notes"],
		});
		expect(catalog.entries[0]?.apps).toEqual([{ appId: "io.brainstorm.notes", label: "notes" }]);
	});

	it("emits empty schemes + extensions arrays when no scheme/ext data is passed (back-compat)", () => {
		// The old IPC call site that only passes entity-type inputs must
		// still produce a structurally complete catalog; the renderer's
		// scheme / extension sections collapse on empty arrays.
		const catalog = buildDefaultsCatalog({
			...base,
			entityTypes: ["t/T/v1"],
			capableApps: () => ["io.brainstorm.notes"],
		});
		expect(catalog.schemes).toEqual([]);
		expect(catalog.extensions).toEqual([]);
	});
});

describe("buildDefaultsCatalog — scheme entries (OpenRes-1c slice 2)", () => {
	const base = {
		entityTypes: [] as string[],
		capableApps: () => [],
		appLabel: (id: string) => id.replace("io.brainstorm.", ""),
		genericEditorAppId: GENERIC_OBJECT_EDITOR_APP_ID,
		currentDefaults: {} as Record<string, string>,
	};

	it("offers capable in-vault handlers + the OS-handoff sentinel, sorted with OS LAST", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			schemes: ["https"],
			capableAppsForScheme: () => ["io.brainstorm.browser", "io.brainstorm.notes"],
		});
		const https = catalog.schemes[0];
		expect(https?.scheme).toBe("https");
		// browser + notes sorted by label, OS-handoff appended last.
		expect(https?.apps.map((a) => a.appId)).toEqual([
			"io.brainstorm.browser",
			"io.brainstorm.notes",
			OS_HANDOFF_APP_ID,
		]);
		// The OS option carries the centralised label so it doesn't drift
		// across translations / re-styles.
		expect(https?.apps.at(-1)?.label).toBe(OS_HANDOFF_APP_LABEL);
		expect(https?.defaultAppId).toBeNull();
	});

	it("schemes with no capable handlers still surface the OS-handoff pick", () => {
		// A `mailto:` URL with no in-vault Mailbox app installed should
		// still let the user pin "always open in system mail client".
		const catalog = buildDefaultsCatalog({
			...base,
			schemes: ["mailto"],
			capableAppsForScheme: () => [],
		});
		expect(catalog.schemes[0]?.apps).toEqual([
			{ appId: OS_HANDOFF_APP_ID, label: OS_HANDOFF_APP_LABEL },
		]);
	});

	it("reflects the current pin from the dashboard snapshot via osHandoffSignature key", () => {
		// The bus stores pins keyed by `open:scheme:https`; the builder
		// has to produce the same key shape OR a same-side-of-the-mirror
		// equivalent. We pass the exact key the bus would write to.
		const catalog = buildDefaultsCatalog({
			...base,
			schemes: ["https"],
			capableAppsForScheme: () => ["io.brainstorm.browser"],
			currentDefaults: { "open:scheme:https": "io.brainstorm.browser" },
		});
		expect(catalog.schemes[0]?.defaultAppId).toBe("io.brainstorm.browser");
	});

	it("pin sentinel '__os__' round-trips so the bus can detect the OS-handoff choice", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			schemes: ["https"],
			capableAppsForScheme: () => ["io.brainstorm.browser"],
			currentDefaults: { "open:scheme:https": OS_HANDOFF_APP_ID },
		});
		expect(catalog.schemes[0]?.defaultAppId).toBe(OS_HANDOFF_APP_ID);
	});

	it("sorts the scheme list alphabetically", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			schemes: ["sftp", "https", "mailto"],
			capableAppsForScheme: () => [],
		});
		expect(catalog.schemes.map((s) => s.scheme)).toEqual(["https", "mailto", "sftp"]);
	});
});

describe("buildDefaultsCatalog — extension entries (OpenRes-1c slice 2)", () => {
	const base = {
		entityTypes: [] as string[],
		capableApps: () => [],
		appLabel: (id: string) => id.replace("io.brainstorm.", ""),
		genericEditorAppId: null,
		currentDefaults: {} as Record<string, string>,
	};

	it("offers capable handlers + OS-handoff for each extension, alphabetical", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			extensions: ["pdf", "csv"],
			capableAppsForExtension: (ext) =>
				ext === "csv" ? ["io.brainstorm.database"] : ext === "pdf" ? ["io.brainstorm.preview"] : [],
		});
		expect(catalog.extensions.map((e) => e.extension)).toEqual(["csv", "pdf"]);
		expect(catalog.extensions[0]?.apps.map((a) => a.appId)).toEqual([
			"io.brainstorm.database",
			OS_HANDOFF_APP_ID,
		]);
		expect(catalog.extensions[1]?.apps.map((a) => a.appId)).toEqual([
			"io.brainstorm.preview",
			OS_HANDOFF_APP_ID,
		]);
	});

	it("pin via osHandoffSignature key `open:ext:pdf` reflects in defaultAppId", () => {
		const catalog = buildDefaultsCatalog({
			...base,
			extensions: ["pdf"],
			capableAppsForExtension: () => ["io.brainstorm.preview"],
			currentDefaults: { "open:ext:pdf": "io.brainstorm.preview" },
		});
		expect(catalog.extensions[0]?.defaultAppId).toBe("io.brainstorm.preview");
	});

	it(`verb is "${DEFAULT_HANDLER_VERB}" across all three section kinds`, () => {
		// One verb governs the whole catalog; the IntentsBus calls
		// resolveDefaultHandler(verb, signature) so a section-mismatched
		// verb would silently miss every pin.
		const catalog = buildDefaultsCatalog({
			...base,
			entityTypes: ["t/T/v1"],
			capableApps: () => [],
			schemes: ["https"],
			capableAppsForScheme: () => [],
			extensions: ["pdf"],
			capableAppsForExtension: () => [],
		});
		expect(catalog.verb).toBe(DEFAULT_HANDLER_VERB);
	});
});
