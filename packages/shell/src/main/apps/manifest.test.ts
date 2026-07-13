import { describe, expect, it } from "vitest";
import {
	type AppManifest,
	diffCapabilities,
	validateManifest,
	validateShortcutShellCollisions,
} from "./manifest";

const valid = {
	id: "io.example.text-editor",
	name: "Text Editor",
	version: "1.4.2",
	sdk: "1",
	entry: "dist/index.html",
	capabilities: ["storage.kv", "entities.read:io.example/Note/v1"],
	registrations: {
		openers: [
			{ kind: "primary", entityType: "io.example/Note/v1" },
			{ kind: "secondary", mime: "text/markdown" },
		],
		blocks: [{ id: "io.example.text-editor/paragraph", name: "Paragraph" }],
		entityTypes: [
			{
				id: "io.example/Note/v1",
				schemaUrl: "https://schemas.example.io/Note/v1",
				schema: { properties: { title: { type: "string" } } },
			},
		],
		widgets: [{ id: "recent-notes", name: "Recent notes", size: "small" }],
		intents: [
			{ verb: "open", entityType: "io.example/Note/v1", priority: "primary", label: "Open Note" },
			{ verb: "insert", blockId: "io.example.text-editor/paragraph" },
			{ verb: "export", entityType: "io.example/Note/v1", format: "text/csv", label: "Note as CSV" },
			{ verb: "process", kind: "summarize" },
		],
	},
	shortcuts: [{ id: "save", default: "Mod+S", label: "Save", scope: "window" }],
	menus: [{ menu: "File", items: [{ id: "new-document", label: "New" }] }],
	layouts: [
		{
			type: "io.example/Note/v1",
			context: "full",
			config: { mode: "stacked", cells: [] },
		},
	],
};

describe("validateManifest", () => {
	it("accepts a fully-populated valid manifest", () => {
		const result = validateManifest(valid);
		expect(result.ok).toBe(true);
	});

	it("accepts a minimal manifest (no registrations / shortcuts / menus / layouts)", () => {
		const minimal = {
			id: "io.example.minimal",
			name: "Minimal",
			version: "0.1.0",
			sdk: "1",
			entry: "index.html",
			capabilities: [],
		};
		expect(validateManifest(minimal).ok).toBe(true);
	});

	it.each([null, undefined, "string", 42, []])("rejects non-objects: %s", (v) => {
		expect(validateManifest(v).ok).toBe(false);
	});

	it("accepts a valid i18n declaration (12.15 15c)", () => {
		const r = validateManifest({ ...valid, i18n: { source: "en", locales: ["en", "es", "de"] } });
		expect(r.ok).toBe(true);
	});

	it.each([
		{ source: "en", locales: [] },
		{ source: "en", locales: ["es", "de"] },
		{ source: "", locales: ["en"] },
		{ source: "en", locales: ["en", ""] },
		{ locales: ["en"] },
		"en",
	])("rejects a malformed i18n declaration: %o", (i18n) => {
		expect(validateManifest({ ...valid, i18n }).ok).toBe(false);
	});

	it.each(["bad space", "123invalid", "WITH/SLASH", "a", "a".repeat(200)])(
		"rejects invalid app ids: %s",
		(id) => {
			expect(validateManifest({ ...valid, id }).ok).toBe(false);
		},
	);

	it("rejects an SDK version newer than the shell supports", () => {
		const result = validateManifest({ ...valid, sdk: "99" });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.path).toBe("$.sdk");
	});

	it("rejects entry with `..` or absolute path", () => {
		expect(validateManifest({ ...valid, entry: "/abs/path" }).ok).toBe(false);
		expect(validateManifest({ ...valid, entry: "../escape" }).ok).toBe(false);
	});

	it("rejects malformed capability strings", () => {
		const result = validateManifest({ ...valid, capabilities: ["BadCase"] });
		expect(result.ok).toBe(false);
	});

	it("opener must specify exactly one of entityType or mime", () => {
		expect(
			validateManifest({
				...valid,
				registrations: { openers: [{ kind: "primary" }] },
			}).ok,
		).toBe(false);
		expect(
			validateManifest({
				...valid,
				registrations: {
					openers: [{ kind: "primary", entityType: "io.example/Note/v1", mime: "text/markdown" }],
				},
			}).ok,
		).toBe(false);
	});

	it("opener.entityType must be a versioned type URL", () => {
		expect(
			validateManifest({
				...valid,
				registrations: { openers: [{ kind: "primary", entityType: "not.a.type" }] },
			}).ok,
		).toBe(false);
	});

	it("accepts scheme and extension opener forms (OpenRes-1a, doc 57)", () => {
		expect(
			validateManifest({
				...valid,
				// Replacing registrations drops entityTypes; this test isn't
				// about layouts, so it ships none (else the inherited default
				// layout's type would be unowned → ForeignType).
				layouts: [],
				registrations: {
					openers: [
						{ kind: "primary", scheme: "https" },
						{ kind: "secondary", extension: "csv" },
						{ kind: "secondary", extension: "tar.gz" },
					],
				},
			}).ok,
		).toBe(true);
	});

	it("rejects a hard-blocked scheme opener (security floor)", () => {
		for (const scheme of ["javascript", "data", "vbscript", "about"]) {
			expect(
				validateManifest({
					...valid,
					registrations: { openers: [{ kind: "primary", scheme }] },
				}).ok,
			).toBe(false);
		}
	});

	it("rejects a malformed scheme / extension", () => {
		expect(
			validateManifest({
				...valid,
				registrations: { openers: [{ kind: "primary", scheme: "ht tp:" }] },
			}).ok,
		).toBe(false);
		expect(
			validateManifest({
				...valid,
				registrations: { openers: [{ kind: "secondary", extension: ".csv" }] },
			}).ok,
		).toBe(false);
		expect(
			validateManifest({
				...valid,
				registrations: {
					openers: [{ kind: "primary", scheme: "https", extension: "csv" }],
				},
			}).ok,
		).toBe(false);
	});

	it("block.id must be namespaced under the app id", () => {
		expect(
			validateManifest({
				...valid,
				registrations: { blocks: [{ id: "io.example.other/block", name: "X" }] },
			}).ok,
		).toBe(false);
	});

	it("entityType.schemaUrl is required (OQ-2 — URL is canonical)", () => {
		expect(
			validateManifest({
				...valid,
				registrations: {
					entityTypes: [{ id: "io.example/Note/v1", schema: { x: 1 } }],
				},
			}).ok,
		).toBe(false);
	});

	it("entityType.schemaUrl must be a valid URL", () => {
		expect(
			validateManifest({
				...valid,
				registrations: {
					entityTypes: [{ id: "io.example/Note/v1", schemaUrl: "not a url" }],
				},
			}).ok,
		).toBe(false);
	});

	it("entityType.schema (when present) must be an object", () => {
		expect(
			validateManifest({
				...valid,
				registrations: {
					entityTypes: [
						{
							id: "io.example/Note/v1",
							schemaUrl: "https://schemas.example.io/Note/v1",
							schema: "not-an-object",
						},
					],
				},
			}).ok,
		).toBe(false);
	});

	it("widget.size must be one of small | medium | large", () => {
		expect(
			validateManifest({
				...valid,
				registrations: { widgets: [{ id: "w", name: "W", size: "huge" }] },
			}).ok,
		).toBe(false);
	});

	it("layout.context must be one of the documented values", () => {
		expect(
			validateManifest({
				...valid,
				layouts: [{ type: "io.example/Note/v1", context: "bogus", config: { mode: "stacked" } }],
			}).ok,
		).toBe(false);
	});

	it("rejects an app-default layout for a type the app does not introduce (doc 27 §App-shipped defaults)", () => {
		const result = validateManifest({
			...valid,
			layouts: [
				{ type: "io.other/Foreign/v1", context: "full", config: { mode: "stacked", cells: [] } },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/does not introduce/);
			expect(result.path).toBe("$.layouts[0]");
		}
	});

	it("rejects a malformed layout config body at install (delegates to the frozen contract)", () => {
		// `config` has no `mode` → the contract's validateLayout flags it,
		// surfaced as an InvalidConfig issue (was silently accepted before).
		const result = validateManifest({
			...valid,
			layouts: [{ type: "io.example/Note/v1", context: "full", config: { cells: [] } }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.path).toBe("$.layouts[0]");
	});

	it("accepts a valid app-owned default layout with a well-formed config", () => {
		const result = validateManifest({
			...valid,
			layouts: [
				{
					type: "io.example/Note/v1",
					context: "card",
					config: {
						mode: "stacked",
						cells: [{ id: "title", kind: "property", property: "title" }],
					},
				},
			],
		});
		expect(result.ok).toBe(true);
	});

	it("reports a path in the failure reason", () => {
		const result = validateManifest({ ...valid, version: "not-semver" });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.path).toBe("$.version");
	});

	it("intent.verb must be one of the curated namespace", () => {
		const result = validateManifest({
			...valid,
			registrations: { intents: [{ verb: "do-magic" }] },
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.path).toBe("$.registrations.intents[0].verb");
	});

	it("intent.entityType must be a versioned type URL", () => {
		const result = validateManifest({
			...valid,
			registrations: { intents: [{ verb: "open", entityType: "Note" }] },
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.path).toBe("$.registrations.intents[0].entityType");
	});

	it("intent.blockId must be namespaced", () => {
		const result = validateManifest({
			...valid,
			registrations: { intents: [{ verb: "insert", blockId: "paragraph" }] },
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.path).toBe("$.registrations.intents[0].blockId");
	});

	it("intent.priority must be primary or secondary", () => {
		const result = validateManifest({
			...valid,
			registrations: {
				intents: [{ verb: "open", entityType: "io.example/Note/v1", priority: "default" }],
			},
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.path).toBe("$.registrations.intents[0].priority");
	});

	it("accepts an intent with no discriminators (process all-things)", () => {
		const result = validateManifest({
			...valid,
			layouts: [], // not a layout test; replacing registrations drops entityTypes
			registrations: { intents: [{ verb: "process", kind: "summarize" }] },
		});
		expect(result.ok).toBe(true);
	});

	it("accepts action-surface presentation metadata (icon + group, doc 63 / AS-3)", () => {
		const result = validateManifest({
			...valid,
			layouts: [],
			registrations: {
				intents: [
					{ verb: "process", kind: "summarize", label: "Summarize", icon: "sparkle", group: "actions" },
					{ verb: "share", label: "Share to X", icon: "open-external", group: "share" },
				],
			},
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a non-curated intent.group", () => {
		const result = validateManifest({
			...valid,
			layouts: [],
			registrations: { intents: [{ verb: "process", group: "ai" }] },
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.path).toBe("$.registrations.intents[0].group");
	});

	it("rejects a malformed intent.icon (not an IconName slug)", () => {
		const result = validateManifest({
			...valid,
			layouts: [],
			registrations: { intents: [{ verb: "process", icon: "Bad Icon!" }] },
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.path).toBe("$.registrations.intents[0].icon");
	});
});

describe("diffCapabilities", () => {
	it("reports added/removed/unchanged", () => {
		const result = diffCapabilities(
			["storage.kv", "entities.read:io.example/Note/v1"],
			["storage.kv", "entities.write:io.example/Note/v1"],
		);
		expect(result.added).toEqual(["entities.write:io.example/Note/v1"]);
		expect(result.removed).toEqual(["entities.read:io.example/Note/v1"]);
		expect(result.unchanged).toEqual(["storage.kv"]);
	});

	it("handles all-new on first install", () => {
		expect(diffCapabilities([], ["storage.kv"]).added).toEqual(["storage.kv"]);
	});

	it("handles all-removed on update that drops caps", () => {
		expect(diffCapabilities(["storage.kv"], []).removed).toEqual(["storage.kv"]);
	});
});

// --- 6.10b — manifest shortcut validation -----------------------------------

const baseManifest: AppManifest = {
	id: "io.example.app",
	name: "App",
	version: "1.0.0",
	sdk: "1",
	entry: "dist/index.html",
	capabilities: [],
};

describe("validateManifest — shortcuts (6.10b)", () => {
	it("rejects shortcut.shadowsShell as non-boolean", () => {
		const r = validateManifest({
			...baseManifest,
			shortcuts: [{ id: "save", default: "Mod+S", label: "Save", shadowsShell: "yes" }],
		});
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.path).toBe("$.shortcuts[0].shadowsShell");
	});

	it("accepts shortcut.shadowsShell:true", () => {
		const r = validateManifest({
			...baseManifest,
			shortcuts: [{ id: "palette", default: "Mod+Shift+P", label: "Palette", shadowsShell: true }],
		});
		expect(r.ok).toBe(true);
	});

	it("rejects duplicate shortcut ids", () => {
		const r = validateManifest({
			...baseManifest,
			shortcuts: [
				{ id: "save", default: "Mod+S", label: "Save" },
				{ id: "save", default: "Mod+Alt+S", label: "Save As" },
			],
		});
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.path).toBe("$.shortcuts[1].id");
	});

	it("rejects two shortcuts that resolve to the same chord", () => {
		const r = validateManifest({
			...baseManifest,
			shortcuts: [
				{ id: "save", default: "Cmd+S", label: "Save" },
				{ id: "save-also", default: "Command+S", label: "Save Also" },
			],
		});
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.path).toBe("$.shortcuts[1].default");
	});

	it("rejects shortcut.scope as non-string", () => {
		const r = validateManifest({
			...baseManifest,
			shortcuts: [{ id: "save", default: "Mod+S", label: "Save", scope: 42 }],
		});
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.path).toBe("$.shortcuts[0].scope");
	});
});

describe("validateShortcutShellCollisions (6.10b)", () => {
	const shellChords = new Set(["cmdorctrl+k", "cmdorctrl+space", "cmdorctrl+shift+p"]);

	it("passes when manifest has no shortcuts", () => {
		expect(validateShortcutShellCollisions(baseManifest, shellChords)).toBeNull();
	});

	it("rejects a manifest chord that collides with a shell chord without shadowsShell", () => {
		const manifest: AppManifest = {
			...baseManifest,
			shortcuts: [{ id: "palette", default: "Mod+Shift+P", label: "Palette" }],
		};
		const r = validateShortcutShellCollisions(manifest, shellChords);
		expect(r).not.toBeNull();
		expect(r?.path).toBe("$.shortcuts[0].default");
	});

	it("accepts a manifest chord that collides with shell when shadowsShell:true", () => {
		const manifest: AppManifest = {
			...baseManifest,
			shortcuts: [{ id: "palette", default: "Mod+Shift+P", label: "Palette", shadowsShell: true }],
		};
		expect(validateShortcutShellCollisions(manifest, shellChords)).toBeNull();
	});

	it("accepts a manifest chord that does not collide", () => {
		const manifest: AppManifest = {
			...baseManifest,
			shortcuts: [{ id: "save", default: "Mod+S", label: "Save" }],
		};
		expect(validateShortcutShellCollisions(manifest, shellChords)).toBeNull();
	});

	it("normalizes the chord (modifier synonyms / order) before comparing", () => {
		const manifest: AppManifest = {
			...baseManifest,
			shortcuts: [{ id: "palette", default: "Shift+Command+P", label: "Palette" }],
		};
		const r = validateShortcutShellCollisions(manifest, new Set(["cmd+shift+p"]));
		expect(r).not.toBeNull();
	});
});
