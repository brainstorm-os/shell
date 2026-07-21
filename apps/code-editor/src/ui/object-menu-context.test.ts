import { buildObjectMenuItems } from "@brainstorm-os/sdk/object-menu";
import { describe, expect, it, vi } from "vitest";
import type { CodeEditorRuntime } from "../runtime";
import { codeFileObjectMenuContext } from "./object-menu-context";

const CODE_FILE_TYPE = "brainstorm/CodeFile/v1";

function fakeRuntime(): CodeEditorRuntime {
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
	} as unknown as CodeEditorRuntime;
}

describe("codeFileObjectMenuContext (shared by the file list rows + the pane header)", () => {
	it("returns null without a runtime (inert trigger)", () => {
		expect(codeFileObjectMenuContext({ id: "c_1", path: "src/a.ts" }, null)).toBeNull();
	});

	it("targets the CodeFile with its entity type + the leaf filename", () => {
		const ctx = codeFileObjectMenuContext(
			{ id: "c_42", path: "packages/shell/src/main/app.ts" },
			fakeRuntime(),
		);
		expect(ctx?.target).toEqual({
			entityId: "c_42",
			entityType: CODE_FILE_TYPE,
			label: "app.ts",
		});
	});

	it("builds Open + Pin through the shared SDK builder", () => {
		const ctx = codeFileObjectMenuContext({ id: "c_1", path: "x.ts" }, fakeRuntime());
		if (!ctx) throw new Error("expected a context");
		const ids = buildObjectMenuItems({
			target: ctx.target,
			runtime: ctx.runtime,
			pinned: false,
			...(ctx.labels ? { labels: ctx.labels } : {}),
		}).map((i) => i.id);
		expect(ids[0]).toBe("open");
		expect(ids).toContain("pin");
	});

	it("omits Rename + Delete when no app actions are passed (read-only surface)", () => {
		const ctx = codeFileObjectMenuContext({ id: "c_1", path: "x.ts" }, fakeRuntime());
		if (!ctx) throw new Error("expected a context");
		expect(ctx.extraItems).toBeUndefined();
		expect(ctx.onRemove).toBeUndefined();
	});

	it("wires Rename (extra item, before Remove) + Delete (onRemove) when actions are passed (F-238)", () => {
		const onRename = vi.fn();
		const onDelete = vi.fn();
		const ctx = codeFileObjectMenuContext({ id: "c_1", path: "x.ts" }, fakeRuntime(), {
			onRename,
			onDelete,
		});
		if (!ctx) throw new Error("expected a context");
		const items = buildObjectMenuItems({
			target: ctx.target,
			runtime: ctx.runtime,
			pinned: false,
			...(ctx.labels ? { labels: ctx.labels } : {}),
			...(ctx.extraItems ? { extraItems: ctx.extraItems } : {}),
			...(ctx.onRemove ? { onRemove: ctx.onRemove } : {}),
		});
		const ids = items.map((i) => i.id);
		expect(ids).toEqual(["open", "pin", "rename", "remove"]);
		const rename = items.find((i) => i.id === "rename");
		const remove = items.find((i) => i.id === "remove");
		rename?.run();
		remove?.run();
		expect(onRename).toHaveBeenCalledOnce();
		expect(onDelete).toHaveBeenCalledOnce();
		expect(remove?.destructive).toBe(true);
	});
});
