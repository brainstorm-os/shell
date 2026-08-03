import { describe, expect, it } from "vitest";
import {
	type Entity,
	hasDisplayName,
	readName,
	resolveDisplayName,
} from "./entity";

const bare = (properties: Record<string, unknown>): Entity =>
	({
		id: "e1",
		type: "brainstorm/File/v1",
		properties,
		createdAt: 1,
		updatedAt: 1,
		deletedAt: null,
	}) as Entity;

describe("resolveDisplayName / readName", () => {
	it("prefers title over name (Notes shape)", () => {
		expect(resolveDisplayName({ title: "Thesis", name: "fallback" })).toBe("Thesis");
		expect(readName(bare({ title: "Thesis" }))).toBe("Thesis");
	});

	it("falls back to name for File/Folder", () => {
		expect(resolveDisplayName({ name: "invoice.pdf" })).toBe("invoice.pdf");
		expect(readName(bare({ name: "invoice.pdf" }))).toBe("invoice.pdf");
	});

	it("uses CodeFile path leaf when name/title are absent (329 audit)", () => {
		expect(resolveDisplayName({ path: "src/lib/main.ts" })).toBe("main.ts");
		expect(resolveDisplayName({ path: "readme.md" })).toBe("readme.md");
		expect(readName(bare({ path: "src/lib/main.ts" }))).toBe("main.ts");
		expect(hasDisplayName(bare({ path: "readme.md" }))).toBe(true);
	});

	it("returns null / (untitled) when nothing is set", () => {
		expect(resolveDisplayName({})).toBeNull();
		expect(readName(bare({}))).toBe("(untitled)");
		expect(hasDisplayName(bare({}))).toBe(false);
		expect(hasDisplayName(bare({ name: "" }))).toBe(false);
		expect(hasDisplayName(bare({ path: "" }))).toBe(false);
	});
});
