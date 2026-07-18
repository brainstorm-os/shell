import { buildObjectMenuItems } from "@brainstorm/sdk/object-menu";
import { describe, expect, it, vi } from "vitest";
import type { FilesStore } from "../store/use-files-store";
import { type Entity, FILE_TYPE, FOLDER_TYPE } from "../types/entity";
import type { BrainstormRuntime } from "../types/runtime";
import { filesObjectMenuContext } from "./object-menu-context";

function fakeStore(over: Partial<FilesStore> = {}): FilesStore {
	return {
		selectRow: vi.fn(),
		startRenameOnAnchor: vi.fn(),
		duplicateIds: vi.fn(),
		deleteIds: vi.fn(),
		...over,
	} as unknown as FilesStore;
}

function fakeRuntime(): BrainstormRuntime {
	return {
		capabilities: ["intents.dispatch:open", "dashboard.pin"],
		services: {
			intents: { dispatch: vi.fn(async () => ({ handled: true })) },
			dashboard: {
				pin: vi.fn(async () => true),
				unpin: vi.fn(async () => true),
				isPinned: vi.fn(async () => false),
			},
		},
	} as unknown as BrainstormRuntime;
}

function folder(id: string, name: string): Entity {
	return {
		id,
		type: FOLDER_TYPE,
		properties: { name },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

function file(id: string, name: string): Entity {
	return {
		id,
		type: FILE_TYPE,
		properties: { name },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

const noop = vi.fn();

describe("filesObjectMenuContext (shared by content rows + the header breadcrumb)", () => {
	it("targets the entity with its Files type + name", () => {
		const ctx = filesObjectMenuContext({
			entity: folder("f_1", "Projects"),
			store: fakeStore(),
			runtime: fakeRuntime(),
			onEditIcon: noop,
			onEditCover: noop,
		});
		expect(ctx.target).toEqual({
			entityId: "f_1",
			entityType: FOLDER_TYPE,
			label: "Projects",
		});
	});

	it("a folder exposes Open → Pin → Rename/Duplicate/Edit-icon/Edit-cover → Remove", () => {
		const ctx = filesObjectMenuContext({
			entity: folder("f_1", "Projects"),
			store: fakeStore(),
			runtime: fakeRuntime(),
			onEditIcon: noop,
			onEditCover: noop,
		});
		const ids = buildObjectMenuItems({
			target: ctx.target,
			runtime: ctx.runtime,
			pinned: false,
			...(ctx.labels ? { labels: ctx.labels } : {}),
			...(ctx.onRemove ? { onRemove: ctx.onRemove } : {}),
			...(ctx.extraItems ? { extraItems: ctx.extraItems } : {}),
		}).map((i) => i.id);
		expect(ids[0]).toBe("open");
		expect(ids).toContain("pin");
		expect(ids).toContain("rename");
		expect(ids).toContain("duplicate");
		expect(ids).toContain("edit-icon");
		expect(ids).toContain("edit-cover");
		expect(ids[ids.length - 1]).toBe("remove");
	});

	it("a file omits the folder-only Edit icon / Edit cover items", () => {
		const ctx = filesObjectMenuContext({
			entity: file("x_1", "notes.txt"),
			store: fakeStore(),
			runtime: fakeRuntime(),
			onEditIcon: noop,
			onEditCover: noop,
		});
		const ids = (ctx.extraItems ?? []).map((i) => i.id);
		expect(ids).toEqual(["rename", "duplicate"]);
	});

	it("Remove routes to store.deleteIds(entity)", () => {
		const deleteIds = vi.fn();
		const ctx = filesObjectMenuContext({
			entity: folder("f_9", "Trashable"),
			store: fakeStore({ deleteIds }),
			runtime: fakeRuntime(),
			onEditIcon: noop,
			onEditCover: noop,
		});
		void ctx.onRemove?.();
		expect(deleteIds).toHaveBeenCalledWith(["f_9"]);
	});

	it("DND-6 — 'Move to folder…' twin appears when `onMoveTo` is supplied and runs it", () => {
		const onMoveTo = vi.fn();
		const ctx = filesObjectMenuContext({
			entity: file("x_1", "notes.txt"),
			store: fakeStore(),
			runtime: fakeRuntime(),
			onEditIcon: noop,
			onEditCover: noop,
			onMoveTo,
		});
		const item = (ctx.extraItems ?? []).find((i) => i.id === "move-to");
		expect(item).toBeDefined();
		item?.run();
		expect(onMoveTo).toHaveBeenCalledTimes(1);
	});

	it("DND-6 — 'Save to disk…' twin appears only when `onSaveToDisk` is supplied", () => {
		const onSaveToDisk = vi.fn();
		const withSave = filesObjectMenuContext({
			entity: file("x_1", "notes.txt"),
			store: fakeStore(),
			runtime: fakeRuntime(),
			onEditIcon: noop,
			onEditCover: noop,
			onSaveToDisk,
		});
		const item = (withSave.extraItems ?? []).find((i) => i.id === "save-to-disk");
		expect(item).toBeDefined();
		item?.run();
		expect(onSaveToDisk).toHaveBeenCalledTimes(1);

		const withoutSave = filesObjectMenuContext({
			entity: file("x_2", "other.txt"),
			store: fakeStore(),
			runtime: fakeRuntime(),
			onEditIcon: noop,
			onEditCover: noop,
		});
		expect((withoutSave.extraItems ?? []).map((i) => i.id)).not.toContain("save-to-disk");
	});

	it("Edit icon / Edit cover route to the supplied callbacks for the folder", () => {
		const onEditIcon = vi.fn();
		const onEditCover = vi.fn();
		const ctx = filesObjectMenuContext({
			entity: folder("f_3", "Pics"),
			store: fakeStore(),
			runtime: fakeRuntime(),
			onEditIcon,
			onEditCover,
		});
		const items = ctx.extraItems ?? [];
		items.find((i) => i.id === "edit-icon")?.run();
		items.find((i) => i.id === "edit-cover")?.run();
		expect(onEditIcon).toHaveBeenCalledWith("f_3");
		expect(onEditCover).toHaveBeenCalledWith("f_3");
	});
});
