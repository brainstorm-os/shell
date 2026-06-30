import { describe, expect, it } from "vitest";
import type { VaultSnapshot } from "../runtime";
import { LanguageKey } from "../types/code-file";
import {
	entityToCodeFileRow,
	entityToStylePackRow,
	isCodeFileEditable,
	projectCodeFiles,
} from "./code-projection";

function snapshot(entities: VaultSnapshot["entities"]): VaultSnapshot {
	return { entities, links: [] };
}

function ent(
	id: string,
	properties: Record<string, unknown>,
	overrides: Partial<VaultSnapshot["entities"][number]> = {},
): VaultSnapshot["entities"][number] {
	return {
		id,
		type: "brainstorm/CodeFile/v1",
		properties,
		createdAt: 1000,
		updatedAt: 2000,
		deletedAt: null,
		ownerAppId: "io.brainstorm.code-editor",
		...overrides,
	};
}

describe("entityToCodeFileRow", () => {
	it("maps the property bag onto the CodeFile contract", () => {
		const row = entityToCodeFileRow({
			id: "cf1",
			properties: {
				path: "snippets/x.ts",
				language: "typescript",
				content: "export const x = 1;",
				sizeBytes: 19,
				lineCount: 1,
				isDirty: true,
				lastOpenedAt: 42,
			},
			createdAt: 1,
			updatedAt: 2,
		});
		expect(row).toEqual({
			id: "cf1",
			path: "snippets/x.ts",
			language: LanguageKey.TypeScript,
			content: "export const x = 1;",
			contentKey: "content",
			icon: null,
			sizeBytes: 19,
			lineCount: 1,
			isDirty: true,
			locked: false,
			lastOpenedAt: 42,
			createdAt: 1,
			updatedAt: 2,
		});
	});

	it("threads the object's OWN icon through via the shared parseIcon", () => {
		const row = entityToCodeFileRow({
			id: "cf-icon",
			properties: {
				path: "a.ts",
				content: "x",
				icon: { kind: "emoji", value: "🦀" },
			},
			createdAt: 0,
			updatedAt: 0,
		});
		expect(row.icon).toEqual({ kind: "emoji", value: "🦀" });
	});

	it("drops a malformed icon blob to null (renderer falls back to the type glyph)", () => {
		const row = entityToCodeFileRow({
			id: "cf-bad-icon",
			properties: { path: "a.ts", content: "x", icon: { kind: "bogus", value: 7 } },
			createdAt: 0,
			updatedAt: 0,
		});
		expect(row.icon).toBeNull();
	});

	it("falls back to body when content is absent", () => {
		const row = entityToCodeFileRow({
			id: "cf2",
			properties: { path: "a.py", body: "print(1)" },
			createdAt: 0,
			updatedAt: 0,
		});
		expect(row.content).toBe("print(1)");
	});

	it("detects language from the path when the stored value is invalid", () => {
		const row = entityToCodeFileRow({
			id: "cf3",
			properties: { path: "main.rs", language: 7, content: "fn main() {}" },
			createdAt: 0,
			updatedAt: 0,
		});
		expect(row.language).toBe(LanguageKey.Rust);
	});

	it("never yields Unknown — it collapses to PlainText", () => {
		const row = entityToCodeFileRow({
			id: "cf4",
			properties: { path: "notes", content: "free text" },
			createdAt: 0,
			updatedAt: 0,
		});
		expect(row.language).toBe(LanguageKey.PlainText);
	});

	it("degrades a malformed bag to an empty buffer + id path", () => {
		const row = entityToCodeFileRow({
			id: "cf5",
			properties: { sizeBytes: "big", lineCount: Number.NaN },
			createdAt: 0,
			updatedAt: 0,
		});
		expect(row.content).toBe("");
		expect(row.path).toBe("cf5");
		expect(row.sizeBytes).toBeNull();
		expect(row.lineCount).toBeNull();
		expect(row.isDirty).toBe(false);
	});
});

describe("projectCodeFiles", () => {
	it("keeps only live CodeFile rows, sorted by path then recency", () => {
		const rows = projectCodeFiles(
			snapshot([
				ent("b", { path: "b.ts", content: "" }, { updatedAt: 10 }),
				ent("a", { path: "a.ts", content: "" }),
				ent("note", { path: "n" }, { type: "io.brainstorm.notes/Note/v1" }),
				ent("del", { path: "z.ts" }, { deletedAt: 999 }),
				ent("b2", { path: "B.ts", content: "" }, { updatedAt: 20 }),
			]),
		);
		expect(rows.map((r) => r.id)).toEqual(["a", "b2", "b"]);
	});

	it("returns [] for an empty / non-CodeFile snapshot", () => {
		expect(projectCodeFiles(snapshot([]))).toEqual([]);
		expect(projectCodeFiles(snapshot([ent("x", {}, { type: "other/Thing/v1" })]))).toEqual([]);
	});
});

describe("entityToStylePackRow (cross-app handoff)", () => {
	it("adapts a StylePack into a css row keyed to properties.css", () => {
		const row = entityToStylePackRow({
			id: "sp1",
			properties: { name: "Neon", css: ".dashboard { color: red; }" },
			createdAt: 1,
			updatedAt: 2,
		});
		expect(row.language).toBe(LanguageKey.CSS);
		expect(row.content).toBe(".dashboard { color: red; }");
		expect(row.contentKey).toBe("css");
		expect(row.path).toBe("Neon.css");
	});

	it("falls back to a default path + empty css", () => {
		const row = entityToStylePackRow({ id: "sp", properties: {}, createdAt: 1, updatedAt: 2 });
		expect(row.path).toBe("style-pack.css");
		expect(row.content).toBe("");
	});
});

describe("projectCodeFiles — opened StylePack", () => {
	const pack = ent("sp1", { name: "Polish", css: ".x{}" }, { type: "brainstorm/StylePack/v1" });

	it("does not list StylePacks unless explicitly opened", () => {
		expect(projectCodeFiles(snapshot([pack]))).toEqual([]);
	});

	it("appends the opened StylePack as a css row", () => {
		const rows = projectCodeFiles(snapshot([ent("a", { path: "a.ts", content: "" }), pack]), "sp1");
		expect(rows.map((r) => r.id)).toContain("sp1");
		expect(rows.find((r) => r.id === "sp1")?.contentKey).toBe("css");
	});

	it("ignores an openStylePackId that isn't a live StylePack", () => {
		expect(projectCodeFiles(snapshot([pack]), "nope")).toEqual([]);
		const deleted = ent("sp2", { css: "" }, { type: "brainstorm/StylePack/v1", deletedAt: 5 });
		expect(projectCodeFiles(snapshot([deleted]), "sp2")).toEqual([]);
	});
});

describe("isCodeFileEditable (gates rename/delete in the file object menu)", () => {
	it("allows an unlocked native content file", () => {
		expect(isCodeFileEditable({ contentKey: "content", locked: false })).toBe(true);
	});

	it("blocks a locked content file — rename/delete must not bypass the lock", () => {
		expect(isCodeFileEditable({ contentKey: "content", locked: true })).toBe(false);
	});

	it("blocks an adapted read-only CSS/StylePack row regardless of lock", () => {
		expect(isCodeFileEditable({ contentKey: "css", locked: false })).toBe(false);
		expect(isCodeFileEditable({ contentKey: "css", locked: true })).toBe(false);
	});
});
