import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../../packages/shell/src/main/apps/manifest";

const MANIFEST_PATH = join(__dirname, "..", "manifest.json");

function readManifest(): unknown {
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

describe("apps/journal/manifest.json", () => {
	it("passes the shell's manifest validator", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) {
			throw new Error(`manifest invalid at ${result.path}: ${result.reason}`);
		}
		expect(result.ok).toBe(true);
	});

	it("declares the expected app id + sdk pin", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		expect(result.manifest.id).toBe("io.brainstorm.journal");
		expect(result.manifest.sdk).toBe("1");
	});

	it("declares NO new entity types — journal does not register a type schema", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		const types = result.manifest.registrations?.entityTypes ?? [];
		expect(types).toEqual([]);
	});

	it("requests narrowly-scoped Journal/Entry write — inline day-body editor needs entities.applyDoc on the dated entry", () => {
		// Journal entries are their own object type (so the Notes app's
		// `{ type: Note/v1 }` list never surfaces them). The inline
		// `<BrainstormEditor>` day-body edits the entry's Y.Doc, which flows
		// through `services.entities.applyDoc` and gates on
		// `entities.write:<type>`. The cap is the narrowest possible (only
		// `io.brainstorm.journal/Entry/v1`, never wildcard); the old shared
		// Note-typed caps stay rejected.
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		const caps = result.manifest.capabilities;
		expect(caps).not.toContain("entities.write:*");
		expect(caps).not.toContain("entities.write:io.brainstorm.notes/Note/v1");
		expect(caps).toContain("entities.write:io.brainstorm.journal/Entry/v1");
	});

	it("quick capture (9.16.14) files into a collection with the two narrow writes it needs, no wider", () => {
		// A `#collection` capture mints a generic Object (the shared
		// `decideRowCreate` member type for a manual collection) and pins it
		// into the List's manual members. Typed lists (Tasks, Notes…) are NOT
		// offered — Journal holds no write for their types.
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		const caps = result.manifest.capabilities;
		expect(caps).toContain("entities.write:brainstorm/Object/v1");
		expect(caps).toContain("entities.write:brainstorm/List/v1");
		expect(caps.filter((c) => c.startsWith("entities.write:")).sort()).toEqual([
			"entities.write:brainstorm/Comment/v1",
			"entities.write:brainstorm/List/v1",
			"entities.write:brainstorm/Object/v1",
			"entities.write:io.brainstorm.journal/Entry/v1",
		]);
	});

	it("requests `entities.read:*` for backlinks-panel cross-app rendering (B6.3 channel)", () => {
		// 9.16.3's backlinks panel needs to walk every `@`-mention of the
		// day's journal entry — that's a vault-wide read.
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		expect(result.manifest.capabilities).toContain("entities.read:*");
	});

	it("registers itself as the PRIMARY opener for its own entry type", () => {
		// A linked journal entry (backlink / mention / graph node) must open
		// IN Journal — the date navigator swings to that day — not spawn a new
		// generic-editor (Notes) window. Without a registered opener the intents
		// bus fell back to the generic entity viewer (Notes), so a plain click
		// on a same-app link opened a fresh Notes window (the reported
		// regression). Journal claiming the primary opener routes `open` for
		// `Entry/v1` back to the running Journal window, which navigates to the
		// entry's day.
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		const openers = result.manifest.registrations?.openers ?? [];
		expect(openers).toContainEqual({
			kind: "primary",
			entityType: "io.brainstorm.journal/Entry/v1",
		});
	});

	it("requests narrowly-scoped Task write — `/task` in the day body creates + completes a Task/v1 (B11.24)", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		const caps = result.manifest.capabilities;
		expect(caps).toContain("entities.write:brainstorm/Task/v1");
		expect(caps).not.toContain("entities.write:*");
	});
});
