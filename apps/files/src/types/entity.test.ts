import { describe, expect, it } from "vitest";
import { type Entity, hasDisplayName, readName } from "./entity";

const bare = (properties: Record<string, unknown>): Entity =>
	({
		id: "e1",
		type: "brainstorm/File/v1",
		properties,
		createdAt: 1,
		updatedAt: 1,
		deletedAt: null,
	}) as Entity;

describe("readName / hasDisplayName", () => {
	// The chain itself is the SDK's (`@brainstorm-os/sdk/entity-title`, unit
	// tested there); these pin that Files reads it — the vault browser is
	// where the divergence showed up as a wall of "(untitled)" tiles.
	it("prefers title over name (Notes shape)", () => {
		expect(readName(bare({ title: "Thesis", name: "fallback" }))).toBe("Thesis");
	});

	it("falls back to name for File/Folder", () => {
		expect(readName(bare({ name: "invoice.pdf" }))).toBe("invoice.pdf");
	});

	it("reads the shared chain's displayName + label legs (DS-entity-title-1)", () => {
		// `brainstorm/Profile/v1` carries ONLY displayName; several
		// app-authored rows carry only `label`. Files' private resolver knew
		// neither, so both tiles read "(untitled)".
		expect(readName(bare({ displayName: "Mira" }))).toBe("Mira");
		expect(readName(bare({ label: "Weekly digest" }))).toBe("Weekly digest");
		expect(readName(bare({ title: "   ", name: "Ada" }))).toBe("Ada");
	});

	it("uses CodeFile path leaf when name/title are absent (329 audit)", () => {
		expect(readName(bare({ path: "src/lib/main.ts" }))).toBe("main.ts");
		expect(readName(bare({ path: "readme.md" }))).toBe("readme.md");
		expect(hasDisplayName(bare({ path: "readme.md" }))).toBe(true);
	});

	it("returns (untitled) when nothing is set", () => {
		expect(readName(bare({}))).toBe("(untitled)");
		expect(hasDisplayName(bare({}))).toBe(false);
		expect(hasDisplayName(bare({ name: "" }))).toBe(false);
		expect(hasDisplayName(bare({ path: "" }))).toBe(false);
	});
});
