import { describe, expect, it } from "vitest";
import { firstFreeName, splitFileSuffix } from "./path-names";

describe("splitFileSuffix", () => {
	it("splits the stem from the extension", () => {
		expect(splitFileSuffix("manifest.json")).toEqual({ base: "manifest", suffix: ".json" });
		expect(splitFileSuffix("app.test.ts")).toEqual({ base: "app.test", suffix: ".ts" });
	});

	it("treats a leading dot as part of the name, not an extension", () => {
		expect(splitFileSuffix(".gitignore")).toEqual({ base: ".gitignore", suffix: "" });
		expect(splitFileSuffix("Makefile")).toEqual({ base: "Makefile", suffix: "" });
		expect(splitFileSuffix("")).toEqual({ base: "", suffix: "" });
	});

	it("keeps a trailing dot as the suffix rather than losing it", () => {
		expect(splitFileSuffix("weird.")).toEqual({ base: "weird", suffix: "." });
	});
});

describe("firstFreeName", () => {
	const takenIn = (...names: string[]) => {
		const set = new Set(names);
		return (name: string) => set.has(name);
	};

	it("returns the plain name when nothing is taken", () => {
		expect(firstFreeName("untitled", ".ts", takenIn())).toBe("untitled.ts");
	});

	it("walks -2, -3, … past every taken variant", () => {
		expect(firstFreeName("untitled", ".ts", takenIn("untitled.ts"))).toBe("untitled-2.ts");
		expect(firstFreeName("untitled", ".ts", takenIn("untitled.ts", "untitled-2.ts"))).toBe(
			"untitled-3.ts",
		);
		// Gaps are filled, not skipped past.
		expect(firstFreeName("untitled", ".ts", takenIn("untitled.ts", "untitled-3.ts"))).toBe(
			"untitled-2.ts",
		);
	});

	it("works with an empty suffix (an extensionless name or a folder)", () => {
		expect(firstFreeName("new-folder", "", takenIn("new-folder"))).toBe("new-folder-2");
	});

	it("terminates on a pathologically saturated set instead of spinning", () => {
		expect(firstFreeName("x", ".ts", () => true)).toBe("x-10000.ts");
	});
});
