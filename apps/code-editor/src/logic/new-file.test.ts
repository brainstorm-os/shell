import { describe, expect, it } from "vitest";
import {
	type FolderPlanFile,
	RenameError,
	nextFolderPath,
	nextUntitledPath,
	planFileMove,
	planFolderMove,
	planFolderRename,
	validateRenamePath,
} from "./new-file";

const file = (id: string, path: string, locked = false): FolderPlanFile => ({ id, path, locked });

const TREE: FolderPlanFile[] = [
	file("a", "lib/one.ts"),
	file("b", "lib/deep/two.ts"),
	file("c", "other/three.ts"),
	file("d", "root.ts"),
];

describe("nextUntitledPath", () => {
	it("first new file is untitled.ts", () => {
		expect(nextUntitledPath([])).toBe("untitled.ts");
		expect(nextUntitledPath(["main.ts"])).toBe("untitled.ts");
	});

	it("avoids collisions, case-insensitively", () => {
		expect(nextUntitledPath(["untitled.ts"])).toBe("untitled-2.ts");
		expect(nextUntitledPath(["Untitled.ts", "untitled-2.ts"])).toBe("untitled-3.ts");
	});

	it("creates inside a folder when one is given", () => {
		expect(nextUntitledPath(["untitled.ts"], "lib")).toBe("lib/untitled.ts");
		expect(nextUntitledPath(["lib/untitled.ts"], "lib")).toBe("lib/untitled-2.ts");
		expect(nextUntitledPath(["lib/untitled.ts"], "")).toBe("untitled.ts");
	});
});

describe("nextFolderPath", () => {
	it("mints a free folder name at the root and inside a parent", () => {
		expect(nextFolderPath([])).toBe("new-folder");
		expect(nextFolderPath(["new-folder"])).toBe("new-folder-2");
		expect(nextFolderPath(["lib", "New-Folder"], "lib")).toBe("lib/new-folder");
		expect(nextFolderPath(["lib/new-folder"], "lib")).toBe("lib/new-folder-2");
	});
});

describe("planFolderRename", () => {
	it("rewrites every descendant path in one plan", () => {
		const plan = planFolderRename("src", "lib", TREE);
		expect(plan).toEqual({
			ok: true,
			path: "src",
			moves: [
				{ id: "a", from: "lib/one.ts", to: "src/one.ts" },
				{ id: "b", from: "lib/deep/two.ts", to: "src/deep/two.ts" },
			],
		});
	});

	it("moves a folder under a new parent when the typed path is nested", () => {
		const plan = planFolderRename("other/lib", "lib", TREE);
		expect(plan.ok && plan.moves.map((m) => m.to)).toEqual([
			"other/lib/one.ts",
			"other/lib/deep/two.ts",
		]);
	});

	it("rejects an empty name", () => {
		expect(planFolderRename("   ", "lib", TREE)).toEqual({ ok: false, reason: RenameError.Empty });
	});

	it("rejects a collision with another folder or a pending folder", () => {
		expect(planFolderRename("other", "lib", TREE)).toEqual({
			ok: false,
			reason: RenameError.Duplicate,
		});
		expect(planFolderRename("drafts", "lib", TREE, ["drafts"])).toEqual({
			ok: false,
			reason: RenameError.Duplicate,
		});
	});

	it("rejects a rewrite that would collide a descendant onto an existing file", () => {
		const files = [file("a", "lib/one.ts"), file("b", "src/one.ts")];
		expect(planFolderRename("src", "lib", files)).toEqual({
			ok: false,
			reason: RenameError.Duplicate,
		});
	});

	it("refuses when any descendant carries the read-only lock", () => {
		const files = [file("a", "lib/one.ts", true), file("b", "lib/two.ts")];
		expect(planFolderRename("src", "lib", files)).toEqual({
			ok: false,
			reason: RenameError.Locked,
		});
	});

	it("rejects moving a folder into its own subtree", () => {
		expect(planFolderRename("lib/deep/lib", "lib", TREE)).toEqual({
			ok: false,
			reason: RenameError.Cycle,
		});
	});

	it("accepts a pure re-casing as a no-op plan", () => {
		expect(planFolderRename("Lib", "lib", TREE)).toEqual({ ok: true, path: "Lib", moves: [] });
	});

	it("sanitizes stray separators and spoofing characters out of the typed path", () => {
		const plan = planFolderRename("/sr‮c//", "lib", TREE);
		expect(plan.ok && plan.path).toBe("src");
	});
});

describe("planFolderMove", () => {
	it("keeps the folder name and swaps the parent", () => {
		const plan = planFolderMove("lib/deep", "", TREE);
		expect(plan).toEqual({
			ok: true,
			path: "deep",
			moves: [{ id: "b", from: "lib/deep/two.ts", to: "deep/two.ts" }],
		});
	});

	it("refuses a drop into its own subtree", () => {
		expect(planFolderMove("lib", "lib/deep", TREE)).toEqual({
			ok: false,
			reason: RenameError.Cycle,
		});
	});
});

describe("planFileMove", () => {
	it("re-prefixes the file and reports one move", () => {
		expect(planFileMove(file("a", "lib/one.ts"), "other", TREE)).toEqual({
			ok: true,
			path: "other/one.ts",
			moves: [{ id: "a", from: "lib/one.ts", to: "other/one.ts" }],
		});
	});

	it("is a no-op (null) when the file already lives there", () => {
		expect(planFileMove(file("a", "lib/one.ts"), "lib", TREE)).toBeNull();
		expect(planFileMove(file("d", "root.ts"), "", TREE)).toBeNull();
	});

	it("refuses a locked file and a name collision at the destination", () => {
		expect(planFileMove(file("a", "lib/one.ts", true), "other", TREE)).toEqual({
			ok: false,
			reason: RenameError.Locked,
		});
		const files = [file("a", "lib/one.ts"), file("b", "other/one.ts")];
		expect(planFileMove(file("a", "lib/one.ts"), "other", files)).toEqual({
			ok: false,
			reason: RenameError.Duplicate,
		});
	});
});

describe("validateRenamePath", () => {
	it("trims and accepts a fresh name", () => {
		expect(validateRenamePath("  app.ts  ", "untitled.ts", ["untitled.ts", "main.ts"])).toEqual({
			ok: true,
			path: "app.ts",
		});
	});

	it("rejects an empty / whitespace-only name", () => {
		expect(validateRenamePath("   ", "untitled.ts", [])).toEqual({
			ok: false,
			reason: RenameError.Empty,
		});
	});

	it("rejects a case-insensitive collision with a different file", () => {
		expect(validateRenamePath("Main.ts", "untitled.ts", ["untitled.ts", "main.ts"])).toEqual({
			ok: false,
			reason: RenameError.Duplicate,
		});
	});

	it("allows renaming a file to a re-cased spelling of its own path", () => {
		expect(validateRenamePath("Main.ts", "main.ts", ["main.ts"])).toEqual({
			ok: true,
			path: "Main.ts",
		});
	});

	it("strips control / bidi-override / zero-width characters from the name", () => {
		expect(validateRenamePath("a‮b.ts​", "untitled.ts", [])).toEqual({
			ok: true,
			path: "ab.ts",
		});
	});

	it("clamps an over-long name to the 200-char cap", () => {
		const result = validateRenamePath(`${"x".repeat(5000)}.ts`, "untitled.ts", []);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path.length).toBe(200);
	});

	it("rejects a name that is only spoofing characters", () => {
		expect(validateRenamePath("‮​", "untitled.ts", [])).toEqual({
			ok: false,
			reason: RenameError.Empty,
		});
	});
});
