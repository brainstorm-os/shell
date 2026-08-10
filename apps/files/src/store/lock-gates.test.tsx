// @vitest-environment jsdom
/**
 * The Files STORE lock gates — Lock-5(e), F-484.
 *
 * `FolderTree.rename` / `softDelete` had tests; the store layer above them —
 * `patchEntityProperties` (every name / description / icon / cover / bulk-
 * rename write), `deleteIds` (which rides the tree's answer before tombstoning
 * the entity in the vault), `startRenameOnAnchor` (which must not open an
 * editor on a row whose commit will be refused) and `toggleEntityLock` (the one
 * write a locked row still takes) — had none at all.
 *
 * Each test asserts BOTH halves of a refusal: the in-memory mirror is unchanged
 * AND no `entities.*` call goes out. A gate that only stops the optimistic
 * paint still tombstones the row in the vault.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenameStatus } from "../logic/rename";
import { SelectionModifier } from "../logic/selection";
import { type Entity, FILE_TYPE, FOLDER_TYPE, ROOT_FOLDER_ID, readName } from "../types/entity";
import { useFilesStore } from "./use-files-store";

type Store = ReturnType<typeof useFilesStore>;
type Probe = { store: Store | null };

let update: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;

function installShell(): void {
	update = vi.fn(() => Promise.resolve(null));
	remove = vi.fn(() => Promise.resolve(null));
	// Entities only — no `vaultEntities`, so nothing re-applies a snapshot over
	// the tree this test seeds by hand.
	(window as { brainstorm?: unknown }).brainstorm = {
		services: { entities: { update, delete: remove, create: vi.fn(() => Promise.resolve(null)) } },
	};
}

function folder(id: string, name: string, members: string[]): Entity {
	return {
		id,
		type: FOLDER_TYPE,
		properties: { name, members },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

function file(id: string, name: string, locked = false): Entity {
	return {
		id,
		type: FILE_TYPE,
		properties: { name, mime: "text/plain", size: 1, ...(locked ? { locked: true } : {}) },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

let probe: Probe;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(): Store {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	function Harness() {
		probe.store = useFilesStore();
		return null;
	}
	act(() => root?.render(<Harness />));
	const store = probe.store;
	if (!store) throw new Error("store did not mount");
	act(() => {
		store.tree.applySnapshot([
			folder(ROOT_FOLDER_ID, "(vault)", ["lk", "free"]),
			file("lk", "budget.xlsx", true),
			file("free", "notes.txt"),
		]);
	});
	if (!probe.store) throw new Error("store went away");
	return probe.store;
}

beforeEach(() => {
	probe = { store: null };
	installShell();
});

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	(window as { brainstorm?: unknown }).brainstorm = undefined;
	vi.restoreAllMocks();
});

describe("useFilesStore — property writes on a locked row", () => {
	it("refuses the rename write and never reaches the vault", () => {
		const store = mount();
		act(() => store.setEntityName("lk", "renamed.xlsx"));
		expect(readName(store.tree.get("lk") as Entity)).toBe("budget.xlsx");
		expect(update).not.toHaveBeenCalled();
	});

	it("refuses icon / cover / description writes too — every field, one gate", () => {
		const store = mount();
		act(() => {
			store.setEntityIcon("lk", { kind: "emoji", value: "📦" });
			store.setEntityCover("lk", { kind: "solid", value: "#fff" });
			store.setEntityDescription("lk", "notes about the lock");
		});
		const row = store.tree.get("lk") as Entity;
		expect(row.properties.icon).toBeUndefined();
		expect(row.properties.cover).toBeUndefined();
		expect(row.properties.description).toBeUndefined();
		expect(update).not.toHaveBeenCalled();
	});

	it("still writes an UNLOCKED row (the gate is the lock, not the app)", () => {
		const store = mount();
		act(() => store.setEntityName("free", "renamed.txt"));
		expect(readName(store.tree.get("free") as Entity)).toBe("renamed.txt");
		expect(update).toHaveBeenCalledWith("free", { name: "renamed.txt" });
	});

	it("lets the lock-flip through — the one write a locked row takes", () => {
		const store = mount();
		act(() => store.toggleEntityLock("lk"));
		expect(store.tree.isLocked("lk")).toBe(false);
		expect(update).toHaveBeenCalledWith("lk", { locked: false });
	});

	it("locks an unlocked row through the same path", () => {
		const store = mount();
		act(() => store.toggleEntityLock("free"));
		expect(store.tree.isLocked("free")).toBe(true);
		expect(update).toHaveBeenCalledWith("free", { locked: true });
	});
});

describe("useFilesStore — the inline rename editor", () => {
	it("does not open on a locked row (typing into a refusal is the worst of both)", () => {
		const store = mount();
		act(() => store.selectRow("lk", SelectionModifier.None));
		if (!probe.store) throw new Error("store went away");
		act(() => probe.store?.startRenameOnAnchor());
		expect(probe.store?.rename.status).toBe(RenameStatus.Idle);
	});

	it("opens on an unlocked row", () => {
		const store = mount();
		act(() => store.selectRow("free", SelectionModifier.None));
		act(() => probe.store?.startRenameOnAnchor());
		expect(probe.store?.rename.status).toBe(RenameStatus.Editing);
	});
});

describe("useFilesStore — deleteIds", () => {
	it("leaves a locked row standing and never tombstones it in the vault", () => {
		const store = mount();
		act(() => store.deleteIds(["lk"]));
		expect(store.tree.get("lk")?.deletedAt).toBeNull();
		expect(remove).not.toHaveBeenCalled();
	});

	it("deletes the unlocked rows of a MIXED selection and leaves the locked one", () => {
		const store = mount();
		act(() => store.deleteIds(["lk", "free"]));
		expect(store.tree.get("lk")?.deletedAt).toBeNull();
		expect(store.tree.get("free")?.deletedAt).not.toBeNull();
		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith("free");
	});
});
