import { CANONICAL_TOKEN_NAMES } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { groupTokens, isColorToken, sectionFor } from "./token-rows";

describe("isColorToken", () => {
	it("is true only for --color-* tokens", () => {
		expect(isColorToken("--color-background-primary")).toBe(true);
		expect(isColorToken("--shadow-md")).toBe(false);
		expect(isColorToken("--space-2")).toBe(false);
		expect(isColorToken("--glass-blur")).toBe(false);
	});
});

describe("sectionFor", () => {
	it("sub-groups colour tokens by their second segment", () => {
		expect(sectionFor("--color-background-primary")).toBe("color.background");
		expect(sectionFor("--color-accent-strong")).toBe("color.accent");
		expect(sectionFor("--color-graph-subject-1")).toBe("color.graph");
	});

	it("groups other families by their first segment", () => {
		expect(sectionFor("--space-2")).toBe("space");
		expect(sectionFor("--radius-md")).toBe("radius");
		expect(sectionFor("--text-size-md")).toBe("text");
		expect(sectionFor("--z-modal")).toBe("z");
	});
});

describe("groupTokens", () => {
	it("covers every token exactly once across sections", () => {
		const groups = groupTokens(CANONICAL_TOKEN_NAMES);
		const flat = groups.flatMap((g) => g.rows.map((r) => r.name));
		expect(flat).toEqual([...CANONICAL_TOKEN_NAMES]);
	});

	it("produces non-empty, uniquely-labelled sections", () => {
		const groups = groupTokens(CANONICAL_TOKEN_NAMES);
		const labels = groups.map((g) => g.section);
		expect(new Set(labels).size).toBe(labels.length);
		expect(groups.every((g) => g.rows.length > 0)).toBe(true);
	});

	it("tags colour rows", () => {
		const groups = groupTokens(["--color-text-primary", "--space-2"]);
		const rows = groups.flatMap((g) => g.rows);
		expect(rows.find((r) => r.name === "--color-text-primary")?.isColor).toBe(true);
		expect(rows.find((r) => r.name === "--space-2")?.isColor).toBe(false);
	});
});
