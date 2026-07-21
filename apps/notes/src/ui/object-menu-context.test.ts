import { buildObjectMenuItems } from "@brainstorm-os/sdk/object-menu";
import { describe, expect, it, vi } from "vitest";
import type { NotesBrainstorm } from "../store/runtime";
import { noteObjectMenuContext } from "./object-menu-context";

const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

function fakeRuntime(over: Partial<NotesBrainstorm> = {}): NotesBrainstorm {
	return {
		app: { id: "io.brainstorm.notes", version: "0.1.0", sdkVersion: "1" },
		launch: { reason: "test" },
		capabilities: ["intents.dispatch:open", "dashboard.pin"],
		services: {
			storage: {} as never,
			properties: {} as never,
			vaultEntities: {} as never,
			intents: { dispatch: vi.fn(async () => ({ handled: true })) } as never,
			dashboard: {
				pin: vi.fn(async () => true),
				unpin: vi.fn(async () => true),
				isPinned: vi.fn(async () => false),
			},
		},
		on: vi.fn(),
		...over,
	} as NotesBrainstorm;
}

describe("noteObjectMenuContext", () => {
	it("returns null when the runtime is not ready (inert trigger)", () => {
		expect(noteObjectMenuContext({ noteId: "n_1", noteTitle: "T", runtime: null })).toBeNull();
	});

	it("targets the note with the Notes entity type and its title", () => {
		const ctx = noteObjectMenuContext({
			noteId: "n_42",
			noteTitle: "My note",
			runtime: fakeRuntime(),
		});
		expect(ctx).not.toBeNull();
		expect(ctx?.target).toEqual({
			entityId: "n_42",
			entityType: NOTE_TYPE,
			label: "My note",
		});
	});

	it("carries localised chrome labels (no bare English in the menu)", () => {
		const ctx = noteObjectMenuContext({
			noteId: "n_1",
			noteTitle: "T",
			runtime: fakeRuntime(),
		});
		expect(ctx?.labels).toMatchObject({
			open: "Open",
			pin: "Pin to dashboard",
			unpin: "Remove from dashboard",
			remove: "Delete note",
			menuRegion: "Note actions",
			moreActions: "Note actions",
		});
	});

	it("wires onRemove only when provided", () => {
		const onRemove = vi.fn();
		const withRemove = noteObjectMenuContext({
			noteId: "n_1",
			noteTitle: "T",
			runtime: fakeRuntime(),
			onRemove,
		});
		expect(withRemove?.onRemove).toBe(onRemove);

		const withoutRemove = noteObjectMenuContext({
			noteId: "n_1",
			noteTitle: "T",
			runtime: fakeRuntime(),
		});
		expect(withoutRemove?.onRemove).toBeUndefined();
	});

	it("builds Open + Pin + Delete through the shared SDK builder", () => {
		const onRemove = vi.fn();
		const ctx = noteObjectMenuContext({
			noteId: "n_1",
			noteTitle: "T",
			runtime: fakeRuntime(),
			onRemove,
		});
		if (!ctx) throw new Error("expected a context");
		const items = buildObjectMenuItems({
			target: ctx.target,
			runtime: ctx.runtime,
			pinned: false,
			...(ctx.labels ? { labels: ctx.labels } : {}),
			...(ctx.onRemove ? { onRemove: ctx.onRemove } : {}),
		});
		const ids = items.map((i) => i.id);
		expect(ids[0]).toBe("open");
		expect(ids).toContain("pin");
		expect(ids[ids.length - 1]).toBe("remove");
		const remove = items.find((i) => i.id === "remove");
		expect(remove?.destructive).toBe(true);
		expect(remove?.label).toBe("Delete note");
	});

	it("omits Pin when the runtime lacks the dashboard.pin capability", () => {
		const ctx = noteObjectMenuContext({
			noteId: "n_1",
			noteTitle: "T",
			runtime: fakeRuntime({ capabilities: ["intents.dispatch:open"] }),
		});
		if (!ctx) throw new Error("expected a context");
		const items = buildObjectMenuItems({
			target: ctx.target,
			runtime: ctx.runtime,
			pinned: false,
			...(ctx.labels ? { labels: ctx.labels } : {}),
		});
		expect(items.map((i) => i.id)).not.toContain("pin");
	});

	it("wires the cross-app collection surface when the entities service is present (9.3.5.V 7c)", () => {
		const entities = { query: vi.fn(), get: vi.fn(), update: vi.fn() };
		const ctx = noteObjectMenuContext({
			noteId: "n_7",
			noteTitle: "T",
			runtime: fakeRuntime({
				services: { ...fakeRuntime().services, entities: entities as never },
			}),
		});
		expect(ctx?.collections?.appId).toBe("io.brainstorm.notes");
		expect(ctx?.collections?.service).toBe(entities);
		expect(ctx?.labels?.addToCollection).toBe("Add to collection…");
	});

	it("omits the collection surface when no entities service is exposed", () => {
		const ctx = noteObjectMenuContext({
			noteId: "n_8",
			noteTitle: "T",
			runtime: fakeRuntime(),
		});
		expect(ctx?.collections).toBeUndefined();
	});
});
