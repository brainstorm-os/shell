import { describe, expect, it } from "vitest";
import {
	type Entity,
	FILE_TYPE,
	FOLDER_TYPE,
	NOTE_TYPE,
	readMembers,
	readName,
} from "../types/entity";
import { CYCLE_DEPTH_LIMIT, FolderTree, foldName } from "./folder-tree";

function fld(id: string, name: string, members: string[] = []): Entity {
	return {
		id,
		type: FOLDER_TYPE,
		properties: { name, members },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

function fil(id: string, name: string): Entity {
	return {
		id,
		type: FILE_TYPE,
		properties: { name, mime: "text/plain", size: 0 },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

function makeTree(): FolderTree {
	const tree = new FolderTree();
	tree.applySnapshot([
		fld("root", "(vault)", ["a", "b", "f1"]),
		fld("a", "A", ["aa"]),
		fld("aa", "A·A", []),
		fld("b", "B", ["bb"]),
		fld("bb", "B·B", []),
		fil("f1", "file.txt"),
	]);
	return tree;
}

describe("FolderTree.applySnapshot + reads", () => {
	it("loads entities, listFolderMembers returns named entities by member order", () => {
		const tree = makeTree();
		const members = tree.listFolderMembers("root");
		expect(members.map((m) => m.id)).toEqual(["a", "b", "f1"]);
	});

	it("returns clones — caller cannot mutate internal state", () => {
		const tree = makeTree();
		const a = tree.get("a");
		expect(a).toBeDefined();
		if (!a) throw new Error("unreachable");
		(a.properties as { name: string }).name = "MUTATED";
		expect(tree.getName("a")).toBe("A");
	});

	it("listByType filters out deleted entities", () => {
		const tree = makeTree();
		expect(tree.listByType(FOLDER_TYPE).map((e) => e.id)).toEqual(
			expect.arrayContaining(["root", "a", "aa", "b", "bb"]),
		);
		tree.softDelete("aa");
		expect(tree.listByType(FOLDER_TYPE).map((e) => e.id)).not.toContain("aa");
		expect(tree.listDeleted().map((e) => e.id)).toContain("aa");
	});

	it("notifies subscribers exactly once per mutation", () => {
		const tree = makeTree();
		let count = 0;
		tree.subscribe(() => {
			count += 1;
		});
		tree.rename("a", "A renamed");
		expect(count).toBe(1);
		tree.softDelete("aa");
		expect(count).toBe(2);
	});
});

describe("FolderTree.createFolder / createFile", () => {
	it("creates a folder under the named parent and adds to members", () => {
		const tree = makeTree();
		const created = tree.createFolder({ name: "new", parentId: "a" });
		expect(created).toBeDefined();
		if (!created) throw new Error("unreachable");
		const parent = tree.get("a");
		if (!parent) throw new Error("unreachable");
		expect(readMembers(parent)).toContain(created.id);
		expect(created.type).toBe(FOLDER_TYPE);
		expect(readName(created)).toBe("new");
	});

	it("returns undefined when parent does not exist", () => {
		const tree = makeTree();
		expect(tree.createFolder({ name: "x", parentId: "nope" })).toBeUndefined();
	});

	it("returns undefined when parent is not a folder (caller passed a file)", () => {
		const tree = makeTree();
		expect(tree.createFolder({ name: "x", parentId: "f1" })).toBeUndefined();
	});

	it("createFile stamps mime + size on the entity", () => {
		const tree = makeTree();
		const created = tree.createFile({
			name: "photo.png",
			mime: "image/png",
			size: 12345,
			parentId: "root",
		});
		if (!created) throw new Error("unreachable");
		expect(created.type).toBe(FILE_TYPE);
		expect(created.properties.mime).toBe("image/png");
		expect(created.properties.size).toBe(12345);
	});

	it("createFile carries the stored-blob coordinates (assetId/assetMime) when present, omits them when not", () => {
		const tree = makeTree();
		const stored = tree.createFile({
			name: "photo.png",
			mime: "image/png",
			size: 7,
			hash: "h".repeat(64),
			assetId: "asset-1",
			assetMime: "image/png",
			parentId: "root",
		});
		if (!stored) throw new Error("unreachable");
		expect(stored.properties.assetId).toBe("asset-1");
		expect(stored.properties.assetMime).toBe("image/png");

		const bare = tree.createFile({
			name: "plain.txt",
			mime: "text/plain",
			size: 1,
			parentId: "root",
		});
		if (!bare) throw new Error("unreachable");
		expect("assetId" in bare.properties).toBe(false);
		expect("assetMime" in bare.properties).toBe(false);
	});
});

describe("FolderTree.rename + collisions", () => {
	it("renames and bumps updatedAt", () => {
		const tree = makeTree();
		tree.rename("a", "alpha", 9999);
		const a = tree.get("a");
		if (!a) throw new Error("unreachable");
		expect(readName(a)).toBe("alpha");
		expect(a.updatedAt).toBe(9999);
	});

	it("hasNameCollision detects case-insensitive duplicates within the active folder", () => {
		const tree = makeTree();
		expect(tree.hasNameCollision("root", "A")).toBe(true);
		expect(tree.hasNameCollision("root", "a")).toBe(true);
		// Á folds to a → collides with existing folder "A".
		expect(tree.hasNameCollision("root", "Á")).toBe(true);
		tree.rename("a", "café");
		expect(tree.hasNameCollision("root", "Cafe")).toBe(true);
		expect(tree.hasNameCollision("root", "different")).toBe(false);
	});

	it("hasNameCollision excludes the entity being renamed", () => {
		const tree = makeTree();
		expect(tree.hasNameCollision("root", "A", "a")).toBe(false);
	});

	it("foldName normalises diacritics + case", () => {
		expect(foldName("Café")).toBe(foldName("cafe"));
		expect(foldName("RÉSUMÉ.pdf")).toBe(foldName("resume.pdf"));
	});
});

describe("FolderTree.move + cycle detection", () => {
	it("moves entities from source.members to dest.members in one notification", () => {
		const tree = makeTree();
		let notifications = 0;
		tree.subscribe(() => {
			notifications += 1;
		});
		const result = tree.move("root", "a", ["b", "f1"]);
		expect(result).toEqual({ ok: true, movedIds: ["b", "f1"] });
		expect(notifications).toBe(1);
		const a = tree.get("a");
		const root = tree.get("root");
		if (!a || !root) throw new Error("unreachable");
		expect(readMembers(a)).toContain("b");
		expect(readMembers(a)).toContain("f1");
		expect(readMembers(root)).not.toContain("b");
		expect(readMembers(root)).not.toContain("f1");
	});

	it("rejects cycles (moving an ancestor into its descendant)", () => {
		const tree = makeTree();
		const result = tree.move("root", "aa", ["a"]);
		expect(result).toEqual({ ok: false, reason: "cycle" });
	});

	it("rejects moving a folder into itself", () => {
		const tree = makeTree();
		const result = tree.move("root", "a", ["a"]);
		expect(result).toEqual({ ok: false, reason: "cycle" });
	});

	it("rejects when source folder is missing", () => {
		const tree = makeTree();
		expect(tree.move("nope", "a", ["b"])).toEqual({ ok: false, reason: "missing-source" });
	});

	it("rejects when dest folder is missing", () => {
		const tree = makeTree();
		expect(tree.move("root", "nope", ["b"])).toEqual({ ok: false, reason: "missing-dest" });
	});

	it("no-ops when source === dest", () => {
		const tree = makeTree();
		const result = tree.move("a", "a", []);
		expect(result).toEqual({ ok: true, movedIds: [] });
	});

	it("wouldCycle is false for non-folder moves (files cannot be ancestors)", () => {
		const tree = makeTree();
		expect(tree.wouldCycle("f1", "a")).toBe(false);
	});

	it("wouldCycle respects the depth limit (deep chains short-circuit)", () => {
		const tree = new FolderTree();
		const entities: Entity[] = [];
		for (let i = 0; i <= CYCLE_DEPTH_LIMIT + 2; i++) {
			entities.push(fld(`f${i}`, `F${i}`, i < CYCLE_DEPTH_LIMIT + 2 ? [`f${i + 1}`] : []));
		}
		tree.applySnapshot(entities);
		// Moving the deepest folder into f0 should not cycle (no path back).
		expect(tree.wouldCycle(`f${CYCLE_DEPTH_LIMIT + 1}`, "f0")).toBe(false);
	});

	it("bulk move 100 entities completes atomically", () => {
		const tree = new FolderTree();
		const fileIds = Array.from({ length: 100 }, (_, i) => `bulk_${i}`);
		const entities: Entity[] = [
			fld("root", "root", ["src", "dst"]),
			fld("src", "src", fileIds),
			fld("dst", "dst", []),
			...fileIds.map((id) => fil(id, id)),
		];
		tree.applySnapshot(entities);
		let notifications = 0;
		tree.subscribe(() => {
			notifications += 1;
		});
		const result = tree.move("src", "dst", fileIds);
		expect(result.ok).toBe(true);
		expect(notifications).toBe(1);
		const dst = tree.get("dst");
		if (!dst) throw new Error("unreachable");
		expect(readMembers(dst)).toHaveLength(100);
	});
});

describe("FolderTree.copy + cycle detection (9.8.7 — membership-add)", () => {
	it("adds members to dest without touching the source folder", () => {
		const tree = makeTree();
		let notifications = 0;
		tree.subscribe(() => {
			notifications += 1;
		});
		const result = tree.copy("a", ["b", "f1"]);
		expect(result).toEqual({ ok: true, copiedIds: ["b", "f1"] });
		expect(notifications).toBe(1);
		const a = tree.get("a");
		const root = tree.get("root");
		if (!a || !root) throw new Error("unreachable");
		// dest got both new members.
		expect(readMembers(a)).toContain("b");
		expect(readMembers(a)).toContain("f1");
		// source still has them (multi-membership default per design 30).
		expect(readMembers(root)).toContain("b");
		expect(readMembers(root)).toContain("f1");
	});

	it("skips ids already in dest.members (idempotent)", () => {
		const tree = makeTree();
		// First copy populates dest.
		tree.copy("a", ["b"]);
		// Second copy of the same id is a no-op (no duplicate, no notify).
		let notifications = 0;
		tree.subscribe(() => {
			notifications += 1;
		});
		const result = tree.copy("a", ["b"]);
		expect(result).toEqual({ ok: true, copiedIds: [] });
		expect(notifications).toBe(0);
		const a = tree.get("a");
		if (!a) throw new Error("unreachable");
		expect(readMembers(a).filter((m) => m === "b")).toHaveLength(1);
	});

	it("rejects cycles (copying an ancestor into its descendant)", () => {
		const tree = makeTree();
		expect(tree.copy("aa", ["a"])).toEqual({ ok: false, reason: "cycle" });
	});

	it("rejects when dest folder is missing", () => {
		const tree = makeTree();
		expect(tree.copy("nope", ["b"])).toEqual({ ok: false, reason: "missing-dest" });
	});

	it("rejects when a copied entity does not exist", () => {
		const tree = makeTree();
		expect(tree.copy("a", ["ghost"])).toEqual({ ok: false, reason: "missing-entity" });
	});

	it("bulk copy 100 entities completes atomically", () => {
		const tree = new FolderTree();
		const fileIds = Array.from({ length: 100 }, (_, i) => `c_${i}`);
		const entities: Entity[] = [
			fld("root", "root", ["src", "dst"]),
			fld("src", "src", fileIds),
			fld("dst", "dst", []),
			...fileIds.map((id) => fil(id, id)),
		];
		tree.applySnapshot(entities);
		let notifications = 0;
		tree.subscribe(() => {
			notifications += 1;
		});
		const result = tree.copy("dst", fileIds);
		expect(result.ok).toBe(true);
		expect(notifications).toBe(1);
		const dst = tree.get("dst");
		const src = tree.get("src");
		if (!dst || !src) throw new Error("unreachable");
		expect(readMembers(dst)).toHaveLength(100);
		// Source untouched.
		expect(readMembers(src)).toHaveLength(100);
	});
});

describe("FolderTree.addMembers (DND-4 — cross-app membership-add)", () => {
	it("adds local entities to dest.members without removing them from their source", () => {
		const tree = makeTree();
		const result = tree.addMembers("a", ["b", "f1"]);
		expect(result).toEqual({ ok: true, addedIds: ["b", "f1"] });
		const a = tree.get("a");
		const root = tree.get("root");
		if (!a || !root) throw new Error("unreachable");
		expect(readMembers(a)).toContain("b");
		expect(readMembers(a)).toContain("f1");
		// Source membership is untouched (add, not move).
		expect(readMembers(root)).toContain("b");
		expect(readMembers(root)).toContain("f1");
	});

	it("adds a FOREIGN id (an object from another app, not in this tree) verbatim", () => {
		const tree = makeTree();
		const result = tree.addMembers("a", ["io.brainstorm.note/Note/v1:n1"]);
		expect(result).toEqual({ ok: true, addedIds: ["io.brainstorm.note/Note/v1:n1"] });
		const a = tree.get("a");
		if (!a) throw new Error("unreachable");
		expect(readMembers(a)).toContain("io.brainstorm.note/Note/v1:n1");
	});

	it("skips ids already present in dest.members (no duplicate)", () => {
		const tree = makeTree();
		tree.addMembers("a", ["b"]);
		const second = tree.addMembers("a", ["b"]);
		expect(second).toEqual({ ok: true, addedIds: [] });
		const a = tree.get("a");
		if (!a) throw new Error("unreachable");
		expect(readMembers(a).filter((m) => m === "b")).toHaveLength(1);
	});

	it("rejects a folder-cycle (adding an ancestor into its descendant)", () => {
		const tree = makeTree();
		expect(tree.addMembers("aa", ["a"])).toEqual({ ok: false, reason: "cycle" });
	});

	it("rejects when dest folder is missing", () => {
		const tree = makeTree();
		expect(tree.addMembers("nope", ["b"])).toEqual({ ok: false, reason: "missing-dest" });
	});

	it("notifies exactly once for a batch", () => {
		const tree = makeTree();
		let notifications = 0;
		tree.subscribe(() => {
			notifications += 1;
		});
		tree.addMembers("a", ["foreign-1", "foreign-2"]);
		expect(notifications).toBe(1);
	});
});

describe("FolderTree.softDelete + restore + permanentDelete", () => {
	it("soft-delete removes from parent.members and sets deletedAt", () => {
		const tree = makeTree();
		expect(tree.softDelete("a")).toBe(true);
		const root = tree.get("root");
		if (!root) throw new Error("unreachable");
		expect(readMembers(root)).not.toContain("a");
		const aDeleted = tree.list().find((e) => e.id === "a");
		expect(aDeleted?.deletedAt).not.toBe(null);
	});

	it("soft-delete is idempotent — second call returns false", () => {
		const tree = makeTree();
		expect(tree.softDelete("a")).toBe(true);
		expect(tree.softDelete("a")).toBe(false);
	});

	it("restore puts the entity back into the named parent", () => {
		const tree = makeTree();
		tree.softDelete("a");
		expect(tree.restore("a", "root")).toBe(true);
		const root = tree.get("root");
		if (!root) throw new Error("unreachable");
		expect(readMembers(root)).toContain("a");
	});

	it("permanentDelete erases the entity and removes from parent.members", () => {
		const tree = makeTree();
		tree.permanentDelete("a");
		expect(tree.get("a")).toBeUndefined();
		const root = tree.get("root");
		if (!root) throw new Error("unreachable");
		expect(readMembers(root)).not.toContain("a");
	});

	it("findParentId returns the parent folder of any entity", () => {
		const tree = makeTree();
		expect(tree.findParentId("a")).toBe("root");
		expect(tree.findParentId("aa")).toBe("a");
		expect(tree.findParentId("nope")).toBeUndefined();
	});
});

describe("FolderTree.persistableMembers — hidden-member retention (display filter ≠ delete)", () => {
	const HIDDEN_MSG = "msg_hidden";

	function makeTreeWithRetained(): FolderTree {
		const tree = new FolderTree();
		// The rendered snapshot (what buildVaultFileTree emitted): the folder's
		// stored members were [msg_hidden, fil_a] but the Message is hidden.
		tree.applySnapshot([
			{
				id: "fld",
				type: FOLDER_TYPE,
				properties: { name: "F", members: ["fil_a"] },
				createdAt: 0,
				updatedAt: 0,
				deletedAt: null,
			},
			{
				id: "fil_a",
				type: FILE_TYPE,
				properties: { name: "a.txt", mime: "text/plain", size: 0 },
				createdAt: 0,
				updatedAt: 0,
				deletedAt: null,
			},
			{
				id: "fil_b",
				type: FILE_TYPE,
				properties: { name: "b.txt", mime: "text/plain", size: 0 },
				createdAt: 0,
				updatedAt: 0,
				deletedAt: null,
			},
		]);
		tree.setRetainedHiddenMembers(new Map([["fld", [{ id: HIDDEN_MSG, afterId: null }]]]));
		return tree;
	}

	it("round-trips a hidden member through a membership op (addMembers) instead of deleting it", () => {
		const tree = makeTreeWithRetained();
		const result = tree.addMembers("fld", ["fil_b"]);
		expect(result.ok).toBe(true);
		// The rendered members never show the hidden Message…
		const fld = tree.get("fld");
		if (!fld) throw new Error("unreachable");
		expect(readMembers(fld)).toEqual(["fil_a", "fil_b"]);
		// …but the array written back to the vault still carries it.
		expect(tree.persistableMembers("fld")).toEqual([HIDDEN_MSG, "fil_a", "fil_b"]);
	});

	it("returns rendered members verbatim for folders with nothing retained", () => {
		const tree = makeTreeWithRetained();
		expect(tree.persistableMembers("nope")).toEqual([]);
		tree.setRetainedHiddenMembers(new Map());
		expect(tree.persistableMembers("fld")).toEqual(["fil_a"]);
	});
});

describe("FolderTree.applySnapshot — readMembers on a Note (non-folder)", () => {
	it("listFolderMembers on a non-folder id returns empty", () => {
		const tree = new FolderTree();
		tree.applySnapshot([
			{
				id: "note",
				type: NOTE_TYPE,
				properties: { name: "Note" },
				createdAt: 0,
				updatedAt: 0,
				deletedAt: null,
			},
		]);
		expect(tree.listFolderMembers("note")).toEqual([]);
	});
});
