import { describe, expect, it } from "vitest";
import {
	PathNodeKind,
	ancestorFolders,
	baseOf,
	buildPathTree,
	dirOf,
	folderNodeId,
	folderPathFromNodeId,
	foldersOf,
	isUnder,
	joinPath,
	pathSegments,
	rewritePathPrefix,
} from "./path-tree";

const FILES = [
	{ id: "a", path: "snippets/greet.ts" },
	{ id: "b", path: "config/app.json" },
	{ id: "c", path: "readme.md" },
	{ id: "d", path: "snippets/deep/nested.ts" },
];

const shape = (nodes: ReturnType<typeof buildPathTree>) =>
	nodes.map((n) => `${"  ".repeat(n.level)}${n.kind === PathNodeKind.Folder ? "/" : ""}${n.name}`);

describe("path primitives", () => {
	it("splits, drops empty segments, and rejoins", () => {
		expect(pathSegments("a//b.ts")).toEqual(["a", "b.ts"]);
		expect(pathSegments("/lead.ts")).toEqual(["lead.ts"]);
		expect(dirOf("a/b/c.ts")).toBe("a/b");
		expect(dirOf("root.ts")).toBe("");
		expect(baseOf("a/b/c.ts")).toBe("c.ts");
		expect(joinPath("", "x.ts")).toBe("x.ts");
		expect(joinPath("a/b", "x.ts")).toBe("a/b/x.ts");
		expect(joinPath("/a//b/", "x.ts")).toBe("a/b/x.ts");
	});

	it("lists ancestor folders outermost first", () => {
		expect(ancestorFolders("a/b/c.ts")).toEqual(["a", "a/b"]);
		expect(ancestorFolders("a/b", true)).toEqual(["a", "a/b"]);
		expect(ancestorFolders("root.ts")).toEqual([]);
	});

	it("containment is case-insensitive and strict; the root holds everything", () => {
		expect(isUnder("A/b.ts", "a")).toBe(true);
		expect(isUnder("a", "a")).toBe(false);
		expect(isUnder("ab/c.ts", "a")).toBe(false);
		expect(isUnder("anything.ts", "")).toBe(true);
	});

	it("rewrites a folder prefix, leaving outsiders and the root alone", () => {
		expect(rewritePathPrefix("lib/util/x.ts", "lib", "src")).toBe("src/util/x.ts");
		expect(rewritePathPrefix("lib/x.ts", "lib", "")).toBe("x.ts");
		expect(rewritePathPrefix("other/x.ts", "lib", "src")).toBe("other/x.ts");
		expect(rewritePathPrefix("x.ts", "", "src")).toBe("x.ts");
	});

	it("round-trips a folder node id", () => {
		expect(folderPathFromNodeId(folderNodeId("a/b"))).toBe("a/b");
		expect(folderPathFromNodeId("entity-123")).toBeNull();
	});

	it("collects every implied folder prefix", () => {
		expect(foldersOf(["a/b/c.ts", "a/d.ts", "e.ts"]).sort()).toEqual(["a", "a/b"]);
	});
});

describe("buildPathTree", () => {
	it("derives folders from prefixes, folders before files, name-sorted", () => {
		expect(shape(buildPathTree(FILES))).toEqual([
			"/config",
			"  app.json",
			"/snippets",
			"  /deep",
			"    nested.ts",
			"  greet.ts",
			"readme.md",
		]);
	});

	it("omits a collapsed folder's subtree but keeps the folder row", () => {
		const nodes = buildPathTree(FILES, { collapsed: new Set(["snippets"]) });
		expect(shape(nodes)).toEqual(["/config", "  app.json", "/snippets", "readme.md"]);
		const snippets = nodes.find((n) => n.path === "snippets");
		expect(snippets?.expanded).toBe(false);
		expect(snippets?.hasChildren).toBe(true);
	});

	it("threads level / parentId so the flat array is the on-screen order", () => {
		const nodes = buildPathTree(FILES);
		const nested = nodes.find((n) => n.path === "snippets/deep/nested.ts");
		expect(nested).toMatchObject({
			kind: PathNodeKind.File,
			level: 2,
			parentId: folderNodeId("snippets/deep"),
			fileId: "d",
		});
		expect(nodes.find((n) => n.path === "config")).toMatchObject({ level: 0, parentId: null });
	});

	it("surfaces a pending (file-less) folder and marks it empty", () => {
		const nodes = buildPathTree(FILES, { extraFolders: ["drafts", "snippets/wip"] });
		expect(shape(nodes)).toContain("/drafts");
		expect(nodes.find((n) => n.path === "drafts")?.empty).toBe(true);
		expect(nodes.find((n) => n.path === "snippets/wip")?.empty).toBe(true);
		expect(nodes.find((n) => n.path === "snippets")?.empty).toBe(false);
	});

	it("merges case-variant spellings of one folder into a single node", () => {
		const nodes = buildPathTree([
			{ id: "a", path: "Lib/one.ts" },
			{ id: "b", path: "lib/two.ts" },
		]);
		expect(nodes.filter((n) => n.kind === PathNodeKind.Folder)).toHaveLength(1);
	});

	it("tolerates stray separators and a path that is only separators", () => {
		const nodes = buildPathTree([
			{ id: "a", path: "/lead.ts" },
			{ id: "b", path: "a//b.ts" },
			{ id: "c", path: "///" },
		]);
		expect(shape(nodes)).toEqual(["/a", "  b.ts", "lead.ts"]);
	});

	it("is empty for no files", () => {
		expect(buildPathTree([])).toEqual([]);
	});
});
