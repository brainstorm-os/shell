import { describe, expect, it } from "vitest";
import { FILE_TYPE, FOLDER_TYPE, ROOT_FOLDER_ID } from "../types/entity";
import { type OpenerMeta, browsableTypeSet } from "./browsable-types";
import {
	type RetainedMember,
	type VaultEntityInput,
	buildVaultFileTree,
	mergeRetainedMembers,
} from "./vault-tree";

function folder(id: string, name: string, members: string[] = []): VaultEntityInput {
	return {
		id,
		type: FOLDER_TYPE,
		properties: { name, members },
		createdAt: 1,
		updatedAt: 2,
		deletedAt: null,
	};
}

function file(id: string, name: string): VaultEntityInput {
	return {
		id,
		type: FILE_TYPE,
		properties: { name, mime: "text/plain", size: 0 },
		createdAt: 1,
		updatedAt: 2,
		deletedAt: null,
	};
}

const NOW = 1_000;

describe("buildVaultFileTree", () => {
	it("synthesises an empty root for an empty vault (no demo bleed)", () => {
		const tree = buildVaultFileTree([], ROOT_FOLDER_ID, NOW);
		expect(tree).toHaveLength(1);
		const root = tree[0];
		expect(root?.id).toBe(ROOT_FOLDER_ID);
		expect(root?.type).toBe(FOLDER_TYPE);
		expect(root?.properties.members).toEqual([]);
		expect(root?.properties.name).toBe("Vault");
	});

	it("uses the real bootstrapped root Folder row when the snapshot carries it", () => {
		const entities: VaultEntityInput[] = [
			{
				id: ROOT_FOLDER_ID,
				type: FOLDER_TYPE,
				properties: { name: "My Vault", members: ["fld_a"], icon: { kind: "emoji", value: "📁" } },
				createdAt: 111,
				updatedAt: 222,
				deletedAt: null,
			},
			folder("fld_a", "Alpha"),
		];
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW);
		const root = tree.find((e) => e.id === ROOT_FOLDER_ID);
		expect(root?.properties.name).toBe("My Vault");
		// Real row's own metadata (icon) + timestamps survive the projection.
		expect(root?.properties.icon).toEqual({ kind: "emoji", value: "📁" });
		expect(root?.createdAt).toBe(111);
		expect(root?.updatedAt).toBe(222);
		expect(root?.properties.members).toContain("fld_a");
	});

	it("respects nested folder membership and surfaces orphans at root", () => {
		const entities: VaultEntityInput[] = [
			folder(ROOT_FOLDER_ID, "Vault", ["fld_docs"]),
			folder("fld_docs", "Docs", ["fil_inner"]),
			file("fil_inner", "inner.txt"),
			file("fil_orphan", "orphan.txt"),
		];
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW);
		const root = tree.find((e) => e.id === ROOT_FOLDER_ID);
		const docs = tree.find((e) => e.id === "fld_docs");
		expect(docs?.properties.members).toEqual(["fil_inner"]);
		const rootMembers = root?.properties.members as string[];
		// Declared first (fld_docs), then the orphan no folder contains.
		expect(rootMembers).toEqual(["fld_docs", "fil_orphan"]);
		expect(rootMembers).not.toContain("fil_inner");
	});

	it("drops soft-deleted rows and dangling member refs", () => {
		const entities: VaultEntityInput[] = [
			folder(ROOT_FOLDER_ID, "Vault", ["fld_gone", "fld_live"]),
			{ ...folder("fld_gone", "Gone"), deletedAt: 999 },
			folder("fld_live", "Live", ["missing-id"]),
		];
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW);
		const root = tree.find((e) => e.id === ROOT_FOLDER_ID);
		const live = tree.find((e) => e.id === "fld_live");
		expect(tree.find((e) => e.id === "fld_gone")).toBeUndefined();
		expect((root?.properties.members as string[]).includes("fld_gone")).toBe(false);
		expect(live?.properties.members).toEqual([]);
	});

	it("never lets the root appear as another folder's member", () => {
		const entities: VaultEntityInput[] = [
			folder(ROOT_FOLDER_ID, "Vault", []),
			folder("fld_x", "X", [ROOT_FOLDER_ID, "fld_x"]),
		];
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW);
		const x = tree.find((e) => e.id === "fld_x");
		expect(x?.properties.members).toEqual([]);
	});

	it("falls back to a synthetic root when the snapshot lacks the bootstrap row", () => {
		const entities: VaultEntityInput[] = [folder("fld_a", "Alpha"), file("fil_b", "b.txt")];
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW);
		const root = tree.find((e) => e.id === ROOT_FOLDER_ID);
		expect(root?.createdAt).toBe(NOW);
		expect(root?.properties.members).toEqual(["fld_a", "fil_b"]);
	});

	const foreign = (id: string, type: string): VaultEntityInput => ({
		id,
		type,
		properties: { title: id, name: id },
		createdAt: 1,
		updatedAt: 2,
		deletedAt: null,
	});

	it("excludes non-File/Folder types when no browsable set is supplied (legacy projection)", () => {
		const entities: VaultEntityInput[] = [
			folder(ROOT_FOLDER_ID, "Vault", ["fld_docs", "note_x"]),
			folder("fld_docs", "Docs", ["fil_inner", "task_y"]),
			file("fil_inner", "inner.txt"),
			file("fil_orphan", "orphan.txt"),
			foreign("note_x", "io.brainstorm.notes/Note/v1"),
			foreign("task_y", "brainstorm/Task/v1"),
		];
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW);
		const ids = tree.map((e) => e.id);
		// Only the root + the two folders + the two files survive.
		expect(ids.sort()).toEqual([ROOT_FOLDER_ID, "fld_docs", "fil_inner", "fil_orphan"].sort());
		const root = tree.find((e) => e.id === ROOT_FOLDER_ID);
		const docs = tree.find((e) => e.id === "fld_docs");
		expect((root?.properties.members as string[]).includes("note_x")).toBe(false);
		expect((docs?.properties.members as string[]).includes("task_y")).toBe(false);
		expect(docs?.properties.members).toEqual(["fil_inner"]);
	});

	it("surfaces browsable non-file types (members + orphans), still dropping unbrowsable ones", () => {
		const entities: VaultEntityInput[] = [
			folder(ROOT_FOLDER_ID, "Vault", ["fld_docs", "note_orphan"]),
			folder("fld_docs", "Docs", ["fil_inner", "task_y"]),
			file("fil_inner", "inner.txt"),
			foreign("note_orphan", "io.brainstorm.notes/Note/v1"),
			foreign("task_y", "brainstorm/Task/v1"),
			// An internal view-state row no app opens: never browsable.
			foreign("calview_1", "brainstorm/CalendarView/v1"),
		];
		const browsable = new Set(["io.brainstorm.notes/Note/v1", "brainstorm/Task/v1"]);
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW, browsable);
		const ids = tree.map((e) => e.id).sort();
		// Note + Task survive (as folder member and root orphan); CalendarView does not.
		expect(ids).toEqual([ROOT_FOLDER_ID, "fld_docs", "fil_inner", "note_orphan", "task_y"].sort());
		const root = tree.find((e) => e.id === ROOT_FOLDER_ID);
		const docs = tree.find((e) => e.id === "fld_docs");
		// The browsable task is kept inside its folder; the orphan note surfaces at root.
		expect(docs?.properties.members).toEqual(["fil_inner", "task_y"]);
		expect((root?.properties.members as string[]).includes("note_orphan")).toBe(true);
		expect((root?.properties.members as string[]).includes("calview_1")).toBe(false);
	});

	it("chat Message rows never surface as top-level items; untitled Notes still do (F-318)", () => {
		// The generic fallback viewer answers `intents.suggest` for ANY typed
		// entity, so the opener cache resolves Message too — the type filter is
		// what must keep conversation children out of the browser.
		const cache = new Map<string, OpenerMeta | null>([
			["io.brainstorm.notes/Note/v1", { appId: "notes", label: "Notes" }],
			["brainstorm/Message/v1", { appId: "preview", label: "Preview" }],
		]);
		const message = (id: string): VaultEntityInput => ({
			id,
			type: "brainstorm/Message/v1",
			properties: { conversation: "chan_1", role: "user", body: "hi", createdAt: "2026-07-01" },
			createdAt: 1,
			updatedAt: 2,
			deletedAt: null,
		});
		const untitledNote: VaultEntityInput = {
			id: "note_1",
			type: "io.brainstorm.notes/Note/v1",
			properties: {},
			createdAt: 1,
			updatedAt: 2,
			deletedAt: null,
		};
		const entities = [untitledNote, message("msg_1"), message("msg_2"), message("msg_3")];
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW, browsableTypeSet(cache));
		const ids = tree.map((e) => e.id);
		expect(ids.filter((id) => id.startsWith("msg_"))).toEqual([]);
		expect(ids).toContain("note_1");
		expect(tree.find((e) => e.id === "note_1")?.properties.name).toBe("(untitled)");
	});

	const message = (id: string): VaultEntityInput => ({
		id,
		type: "brainstorm/Message/v1",
		properties: { conversation: "chan_1", role: "user", body: "hi" },
		createdAt: 1,
		updatedAt: 2,
		deletedAt: null,
	});

	it("retains hidden-but-live member ids per folder instead of dropping them (display filter ≠ delete)", () => {
		const entities: VaultEntityInput[] = [
			folder(ROOT_FOLDER_ID, "Vault", ["msg_root", "fld_docs"]),
			folder("fld_docs", "Docs", ["msg_1", "fil_a", "msg_2"]),
			file("fil_a", "a.txt"),
			message("msg_1"),
			message("msg_2"),
			message("msg_root"),
		];
		const retained = new Map<string, RetainedMember[]>();
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW, new Set(), retained);
		// Hidden from the rendered listing…
		const docs = tree.find((e) => e.id === "fld_docs");
		expect(docs?.properties.members).toEqual(["fil_a"]);
		expect(tree.map((e) => e.id).filter((id) => id.startsWith("msg_"))).toEqual([]);
		// …but retained for persistence, with a position anchor.
		expect(retained.get("fld_docs")).toEqual([
			{ id: "msg_1", afterId: null },
			{ id: "msg_2", afterId: "fil_a" },
		]);
		expect(retained.get(ROOT_FOLDER_ID)).toEqual([{ id: "msg_root", afterId: null }]);
	});

	it("still prunes genuinely-dangling member refs (deleted / unknown ids are NOT retained)", () => {
		const entities: VaultEntityInput[] = [
			folder(ROOT_FOLDER_ID, "Vault", ["fld_docs"]),
			folder("fld_docs", "Docs", ["fil_gone", "missing-id", "msg_deleted", "fil_a"]),
			file("fil_a", "a.txt"),
			{ ...file("fil_gone", "gone.txt"), deletedAt: 999 },
			{ ...message("msg_deleted"), deletedAt: 999 },
		];
		const retained = new Map<string, RetainedMember[]>();
		const tree = buildVaultFileTree(entities, ROOT_FOLDER_ID, NOW, new Set(), retained);
		const docs = tree.find((e) => e.id === "fld_docs");
		expect(docs?.properties.members).toEqual(["fil_a"]);
		expect(retained.has("fld_docs")).toBe(false);
	});
});

describe("mergeRetainedMembers", () => {
	it("re-inserts retained hidden ids at their anchored positions", () => {
		const merged = mergeRetainedMembers(
			["fil_a", "fil_b"],
			[
				{ id: "msg_front", afterId: null },
				{ id: "msg_mid", afterId: "fil_a" },
			],
		);
		expect(merged).toEqual(["msg_front", "fil_a", "msg_mid", "fil_b"]);
	});

	it("appends retained ids whose visible anchor left the folder, and never duplicates", () => {
		const merged = mergeRetainedMembers(
			["fil_b", "msg_already"],
			[
				{ id: "msg_orphaned", afterId: "fil_moved_away" },
				{ id: "msg_already", afterId: null },
			],
		);
		expect(merged).toEqual(["fil_b", "msg_already", "msg_orphaned"]);
	});

	it("is a no-op copy when nothing was retained", () => {
		expect(mergeRetainedMembers(["a", "b"], undefined)).toEqual(["a", "b"]);
		expect(mergeRetainedMembers(["a", "b"], [])).toEqual(["a", "b"]);
	});
});
