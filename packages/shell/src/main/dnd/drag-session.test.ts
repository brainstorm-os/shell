import { DragPayloadKind, DropEffect, type ObjectDragItem } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { DragSessionStore } from "./drag-session";

function items(...ids: string[]): ObjectDragItem[] {
	return ids.map((id) => ({ entityId: id, entityType: "brainstorm/Note/v1", label: id }));
}

function begin(store: DragSessionStore, app = "app.a") {
	return store.begin({ sourceApp: app, payloadKind: DragPayloadKind.Object, items: items("e1") });
}

describe("DragSessionStore", () => {
	it("begin opens a session with a unique id and default effect", () => {
		const store = new DragSessionStore();
		const s = begin(store);
		expect(s.sessionId).toBe("drag-1");
		expect(s.sourceApp).toBe("app.a");
		expect(s.target).toBeNull();
		expect(s.effect).toBe(DropEffect.None);
		expect(store.getActive()).toBe(s);
	});

	it("a second begin replaces (implicitly cancels) the first", () => {
		const store = new DragSessionStore();
		const a = begin(store, "app.a");
		const b = begin(store, "app.b");
		expect(b.sessionId).toBe("drag-2");
		expect(store.get(a.sessionId)).toBeNull(); // first is gone
		expect(store.getActive()).toBe(b);
	});

	it("get only matches the active session id", () => {
		const store = new DragSessionStore();
		const s = begin(store);
		expect(store.get(s.sessionId)).toBe(s);
		expect(store.get("drag-999")).toBeNull();
	});

	it("setTarget reports change and resets effect on entering empty space", () => {
		const store = new DragSessionStore();
		const s = begin(store);
		expect(store.setTarget(s.sessionId, { appId: "t", windowId: "w" })).toBe(true);
		expect(store.setTarget(s.sessionId, { appId: "t", windowId: "w" })).toBe(false); // same
		store.setEffect(s.sessionId, DropEffect.Link);
		expect(s.effect).toBe(DropEffect.Link);
		expect(store.setTarget(s.sessionId, null)).toBe(true); // left to empty space
		expect(s.effect).toBe(DropEffect.None); // effect reset
	});

	it("setTarget on a stale session id is a no-op", () => {
		const store = new DragSessionStore();
		begin(store);
		expect(store.setTarget("drag-999", { appId: "t", windowId: "w" })).toBe(false);
	});

	it("end closes the matching session only", () => {
		const store = new DragSessionStore();
		const s = begin(store);
		store.end("drag-999");
		expect(store.getActive()).toBe(s);
		store.end(s.sessionId);
		expect(store.getActive()).toBeNull();
	});

	it("endForApp drops the active session iff that app owns it", () => {
		const store = new DragSessionStore();
		begin(store, "app.a");
		store.endForApp("app.b");
		expect(store.getActive()).not.toBeNull();
		store.endForApp("app.a");
		expect(store.getActive()).toBeNull();
	});

	it("payloadOf builds the reference-only wire payload", () => {
		const store = new DragSessionStore();
		const s = store.begin({
			sourceApp: "app.a",
			payloadKind: DragPayloadKind.Object,
			items: items("e1", "e2"),
		});
		expect(store.payloadOf(s)).toEqual({
			v: 1,
			sourceApp: "app.a",
			items: items("e1", "e2"),
		});
	});
});
