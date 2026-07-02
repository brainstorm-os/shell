// @vitest-environment jsdom
/**
 * 9.8.7 — `intent.move` handler unit tests.
 *
 * Exercises `handleMoveIntent` against a hand-built `FolderTree` with a
 * stubbed `window.brainstorm.services.entities.update`. The handler is
 * the cross-app entry point: every drag-drop call ultimately rides the
 * same code path (via `moveIds` / `copyIds` calling
 * `persistFolderMembers`), so a contract pin here protects every move /
 * copy / intent.move call in the app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderTree } from "../src/logic/folder-tree";
import {
	type RetainedMember,
	type VaultEntityInput,
	buildVaultFileTree,
} from "../src/logic/vault-tree";
import { handleMoveIntent } from "../src/store/use-files-store";
import { type Entity, FILE_TYPE, FOLDER_TYPE } from "../src/types/entity";

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
		fld("root", "root", ["src", "dst", "f1"]),
		fld("src", "src", ["f2"]),
		fld("dst", "dst", []),
		fil("f1", "file-one"),
		fil("f2", "file-two"),
	]);
	return tree;
}

type Brainstorm = {
	services?: { entities?: { update: ReturnType<typeof vi.fn> } };
};

function stampRuntime(update: ReturnType<typeof vi.fn>): void {
	(window as unknown as { brainstorm: Brainstorm }).brainstorm = {
		services: { entities: { update } },
	};
}

function clearRuntime(): void {
	(window as unknown as { brainstorm?: Brainstorm }).brainstorm = undefined;
}

beforeEach(() => {
	clearRuntime();
});

afterEach(() => {
	clearRuntime();
	vi.restoreAllMocks();
});

describe("handleMoveIntent — move path", () => {
	it("moves the entity in-memory + persists both folders", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		stampRuntime(update);
		const tree = makeTree();
		handleMoveIntent({ entityIds: ["f1"], fromFolderId: "root", toFolderId: "dst" }, tree);
		// In-memory move applied immediately.
		const root = tree.get("root");
		const dst = tree.get("dst");
		if (!root || !dst) throw new Error("unreachable");
		expect(root.properties.members).not.toContain("f1");
		expect(dst.properties.members).toContain("f1");
		// Persistence calls are fire-and-forget — let microtasks drain.
		await new Promise((r) => setTimeout(r, 0));
		expect(update).toHaveBeenCalledTimes(2);
		expect(update.mock.calls.some((c) => c[0] === "root")).toBe(true);
		expect(update.mock.calls.some((c) => c[0] === "dst")).toBe(true);
		const dstCall = update.mock.calls.find((c) => c[0] === "dst");
		expect(dstCall?.[1]).toEqual({ members: expect.arrayContaining(["f1"]) });
	});

	it("rejects a cycle without persisting (folder can't be its own descendant)", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		stampRuntime(update);
		const tree = new FolderTree();
		tree.applySnapshot([fld("root", "root", ["a"]), fld("a", "a", ["aa"]), fld("aa", "aa", [])]);
		handleMoveIntent({ entityIds: ["a"], fromFolderId: "root", toFolderId: "aa" }, tree);
		await new Promise((r) => setTimeout(r, 0));
		expect(update).not.toHaveBeenCalled();
	});

	it("is a no-op on missing fromFolderId, toFolderId, or entityIds", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		stampRuntime(update);
		const tree = makeTree();
		handleMoveIntent(undefined, tree);
		handleMoveIntent({}, tree);
		handleMoveIntent({ entityIds: [], fromFolderId: "root", toFolderId: "dst" }, tree);
		handleMoveIntent({ entityIds: ["f1"], toFolderId: "dst" }, tree);
		handleMoveIntent({ entityIds: ["f1"], fromFolderId: "root" }, tree);
		await new Promise((r) => setTimeout(r, 0));
		expect(update).not.toHaveBeenCalled();
	});

	it("filters non-string entityIds defensively (cross-app payload trust)", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		stampRuntime(update);
		const tree = makeTree();
		handleMoveIntent(
			{ entityIds: ["f1", 42, null, ""], fromFolderId: "root", toFolderId: "dst" },
			tree,
		);
		const dst = tree.get("dst");
		expect(dst?.properties.members).toEqual(["f1"]);
		await new Promise((r) => setTimeout(r, 0));
		expect(update).toHaveBeenCalledTimes(2);
	});
});

describe("handleMoveIntent — copy path", () => {
	it("with copy:true adds members to dest WITHOUT removing from source", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		stampRuntime(update);
		const tree = makeTree();
		handleMoveIntent({ entityIds: ["f1"], toFolderId: "dst", copy: true }, tree);
		const root = tree.get("root");
		const dst = tree.get("dst");
		if (!root || !dst) throw new Error("unreachable");
		expect(root.properties.members).toContain("f1");
		expect(dst.properties.members).toContain("f1");
		await new Promise((r) => setTimeout(r, 0));
		expect(update).toHaveBeenCalledTimes(1);
		expect(update.mock.calls[0]?.[0]).toBe("dst");
	});

	it("does not require fromFolderId when copy:true (membership-add doesn't touch source)", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		stampRuntime(update);
		const tree = makeTree();
		handleMoveIntent({ entityIds: ["f1"], toFolderId: "dst", copy: true }, tree);
		await new Promise((r) => setTimeout(r, 0));
		expect(update).toHaveBeenCalledWith("dst", expect.anything());
	});
});

describe("handleMoveIntent — hidden-member retention (F-318 must not become delete-on-persist)", () => {
	const MSG_TYPE = "brainstorm/Message/v1";

	function msg(id: string): VaultEntityInput {
		return {
			id,
			type: MSG_TYPE,
			properties: { conversation: "chan_1", role: "user", body: "hi" },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
		};
	}

	/** The real snapshot pipeline: raw vault rows → buildVaultFileTree (which
	 *  hides the Message from the rendered members) → tree + retained map —
	 *  exactly what `loadFromVault` wires up. */
	function makeTreeFromVault(rawMembers: string[]): FolderTree {
		const raw: VaultEntityInput[] = [
			fld("root", "root", ["dst", "fil_b"]),
			fld("dst", "dst", rawMembers),
			fil("fil_a", "a.txt"),
			fil("fil_b", "b.txt"),
			{ ...fil("fil_gone", "gone.txt"), deletedAt: 999 },
			msg("msg_1"),
		];
		const retained = new Map<string, RetainedMember[]>();
		const tree = new FolderTree();
		tree.applySnapshot(buildVaultFileTree(raw, "root", 0, new Set(), retained));
		tree.setRetainedHiddenMembers(retained);
		return tree;
	}

	it("a membership op persists the folder WITH its hidden Message member (round-trip, no data loss)", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		stampRuntime(update);
		const tree = makeTreeFromVault(["msg_1", "fil_a"]);
		// The Message never renders…
		expect(tree.get("msg_1")).toBeUndefined();
		expect(tree.get("dst")?.properties.members).toEqual(["fil_a"]);
		// …but a membership-touching op must not erase its stored membership.
		handleMoveIntent({ entityIds: ["fil_b"], toFolderId: "dst", copy: true }, tree);
		await new Promise((r) => setTimeout(r, 0));
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith("dst", { members: ["msg_1", "fil_a", "fil_b"] });
	});

	it("genuinely-deleted member ids are still pruned on persist", async () => {
		const update = vi.fn().mockResolvedValue(undefined);
		stampRuntime(update);
		const tree = makeTreeFromVault(["msg_1", "fil_gone", "fil_a"]);
		handleMoveIntent({ entityIds: ["fil_b"], toFolderId: "dst", copy: true }, tree);
		await new Promise((r) => setTimeout(r, 0));
		const call = update.mock.calls[0];
		expect(call?.[0]).toBe("dst");
		const members = (call?.[1] as { members: string[] }).members;
		expect(members).toContain("msg_1");
		expect(members).not.toContain("fil_gone");
	});
});

describe("handleMoveIntent — persistence resilience", () => {
	it("is silent when services.entities.update is missing (preview-build path)", async () => {
		clearRuntime();
		const tree = makeTree();
		expect(() =>
			handleMoveIntent({ entityIds: ["f1"], fromFolderId: "root", toFolderId: "dst" }, tree),
		).not.toThrow();
		// In-memory move still applies — the UI repaints; the next
		// vault snapshot is what reverts in production.
		const root = tree.get("root");
		const dst = tree.get("dst");
		expect(root?.properties.members).not.toContain("f1");
		expect(dst?.properties.members).toContain("f1");
	});

	it("swallows entities.update rejections (next vault snapshot reverts)", async () => {
		const update = vi.fn().mockRejectedValue(new Error("storage down"));
		stampRuntime(update);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const tree = makeTree();
		handleMoveIntent({ entityIds: ["f1"], fromFolderId: "root", toFolderId: "dst" }, tree);
		// Drain the microtask + the macrotask the warn was scheduled on.
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
		expect(update).toHaveBeenCalledTimes(2);
	});
});
