// @vitest-environment jsdom
/**
 * Notes and the read-only lock — Lock-5(h).
 *
 * The sweep that produced Lock-5(f)/(g) missed this app the same way the two
 * before it missed Mailbox and Contacts: Notes read `note.locked` in five
 * places, ALL of them chrome (`readOnly` on the editor, the properties panel's
 * per-row read-only, the ⋯ Lock row) plus one call-site check on the property
 * cells. The store's `update` / `setValue` / `remove` — the one funnel behind
 * the icon picker, the cover picker, the body denormaliser, the properties
 * panel, delete, AND the dictionary rewrite that patches OTHER notes wholesale
 * — had no gate at all. A locked note took every one of those writes.
 *
 * These tests drive the store's real API against a stub entities service and
 * assert the PERSISTED write: a refusal means the repository never saw it.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_TYPE } from "./entities-repository";
import type { StoredNote } from "./note";
import { type UseNotes, useNotes } from "./use-notes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Rec = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
};

let store: Map<string, Rec>;
let update: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;

function installShell(rows: Rec[]): void {
	store = new Map(rows.map((r) => [r.id, r]));
	update = vi.fn(async (id: string, patch: Record<string, unknown>) => {
		const ex = store.get(id);
		if (!ex) throw new Error(`update: ${id}`);
		const next = { ...ex, properties: { ...ex.properties, ...patch }, updatedAt: ex.updatedAt + 1 };
		store.set(id, next);
		return next;
	});
	create = vi.fn(async (type: string, properties: Record<string, unknown>, id?: string) => {
		const rec: Rec = {
			id: id ?? `n_${store.size + 1}`,
			type,
			properties,
			createdAt: 1,
			updatedAt: 1,
		};
		store.set(rec.id, rec);
		return rec;
	});
	remove = vi.fn(async (id: string) => void store.delete(id));
	(window as { brainstorm?: unknown }).brainstorm = {
		on: (event: string, cb: () => void) => {
			if (event === "ready") cb();
			return { unsubscribe: () => {} };
		},
		services: {
			entities: {
				get: async (id: string) => store.get(id) ?? null,
				query: async () => [...store.values()],
				create,
				update,
				delete: remove,
			},
		},
	};
}

function noteRow(id: string, properties: Record<string, unknown> = {}): Rec {
	return {
		id,
		type: NOTE_TYPE,
		properties: { title: id, body: "", values: {}, ...properties },
		createdAt: 1,
		updatedAt: 1,
	};
}

let api: UseNotes;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Host(): null {
	api = useNotes();
	return null;
}

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(<Host />);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

/** The store coalesces persistence on a timer, so drain it before asserting. */
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 400));
	});
}

beforeEach(() => {
	vi.useRealTimers();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
	vi.restoreAllMocks();
});

describe("useNotes — the read-only lock holds on the store funnel", () => {
	it("persists an icon / cover / title patch on an UNLOCKED note", async () => {
		installShell([noteRow("n1")]);
		await mount();
		await act(async () => api.update("n1", { title: "Renamed" }));
		await settle();
		expect(update).toHaveBeenCalled();
		expect(store.get("n1")?.properties.title).toBe("Renamed");
	});

	it("refuses EVERY property write on a LOCKED note", async () => {
		installShell([noteRow("n1", { locked: true })]);
		await mount();
		await act(async () => {
			// The five real writers, one by one.
			api.update("n1", { title: "Renamed" }); // the body denormaliser
			api.update("n1", { icon: null }); // the icon picker
			api.update("n1", { cover: null }); // the cover picker
			api.update("n1", { body: "snippet" }); // autosave's snippet mirror
			api.update("n1", { values: { k: "v" } as never }); // the dictionary rewrite
		});
		await settle();
		expect(update).not.toHaveBeenCalled();
		expect(store.get("n1")?.properties.title).toBe("n1");
	});

	it("lets the lock-flip through, so a lock can always be undone", async () => {
		installShell([noteRow("n1", { locked: true })]);
		await mount();
		await act(async () => api.update("n1", { locked: false }));
		await settle();
		expect(store.get("n1")?.properties.locked).toBe(false);
	});

	it("refuses a MIXED patch wholesale — the lock key carries nothing with it", async () => {
		installShell([noteRow("n1", { locked: true })]);
		await mount();
		await act(async () => api.update("n1", { locked: false, title: "renamed behind the lock" }));
		await settle();
		expect(update).not.toHaveBeenCalled();
		expect(store.get("n1")?.properties.locked).toBe(true);
	});

	it("refuses a property-VALUE write on a locked note, and lands it on a free one", async () => {
		installShell([noteRow("n1", { locked: true }), noteRow("n2")]);
		await mount();
		const def = { key: "status", valueType: "text", name: "Status" } as never;
		await act(async () => {
			api.setValue("n1", def, "done" as never);
			api.setValue("n2", def, "done" as never);
		});
		await settle();
		expect(update).toHaveBeenCalledTimes(1);
		expect((store.get("n2")?.properties.values as Record<string, unknown>).status).toBe("done");
		expect((store.get("n1")?.properties.values as Record<string, unknown>) ?? {}).toEqual({});
	});

	it("refuses to DELETE a locked note, and deletes an unlocked one", async () => {
		installShell([noteRow("n1", { locked: true }), noteRow("n2")]);
		await mount();
		await act(async () => {
			await api.remove("n1");
			await api.remove("n2");
		});
		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith("n2");
		expect(store.has("n1")).toBe(true);
	});
});

describe("useNotes — a locked note is untouched by a write aimed at ANOTHER note", () => {
	it("rewrites the unlocked notes and leaves the locked one standing", async () => {
		// The dictionary rewrite (renaming a select option) patches every note
		// that uses the value — a fan-out write no per-note affordance gates.
		installShell([noteRow("a"), noteRow("b", { locked: true }), noteRow("c")]);
		await mount();
		const changed: Array<Pick<StoredNote, "id" | "values">> = [
			{ id: "a", values: { tag: "renamed" } as never },
			{ id: "b", values: { tag: "renamed" } as never },
			{ id: "c", values: { tag: "renamed" } as never },
		];
		await act(async () => {
			for (const c of changed) api.update(c.id, { values: c.values });
		});
		await settle();
		expect(store.get("a")?.properties.values).toEqual({ tag: "renamed" });
		expect(store.get("c")?.properties.values).toEqual({ tag: "renamed" });
		expect(store.get("b")?.properties.values).toEqual({});
	});
});
