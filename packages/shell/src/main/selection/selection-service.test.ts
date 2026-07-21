import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import type { ObjectDragItem } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import {
	SELECTION_PUBLISH_CAPABILITY,
	SELECTION_READ_CAPABILITY,
	SelectionMethod,
	type SelectionServiceOptions,
	SelectionStore,
	makeSelectionServiceHandler,
} from "./selection-service";

function envelope(method: string, args: unknown[] = [], app = "io.example.app"): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m1",
		app,
		service: "selection",
		method,
		args,
		caps: [],
	};
}

const grantAll: CapabilityLedger = {
	has: (_app: string, cap: string) =>
		cap === SELECTION_PUBLISH_CAPABILITY || cap === SELECTION_READ_CAPABILITY,
} as unknown as CapabilityLedger;

const denyAll: CapabilityLedger = { has: () => false } as unknown as CapabilityLedger;

function items(...ids: string[]): ObjectDragItem[] {
	return ids.map((id) => ({ entityId: id, entityType: "brainstorm/Note/v1", label: id }));
}

function handlerWith(
	ledger: CapabilityLedger | null,
	extra: Partial<SelectionServiceOptions> = {},
): { store: SelectionStore; handler: ReturnType<typeof makeSelectionServiceHandler> } {
	const store = new SelectionStore();
	const handler = makeSelectionServiceHandler({
		store,
		getLedger: async () => ledger,
		...extra,
	});
	return { store, handler };
}

describe("SelectionStore", () => {
	it("publish then current returns the stamped snapshot", () => {
		const store = new SelectionStore();
		store.publish("app.a", items("e1", "e2"));
		expect(store.current()).toEqual({
			sourceApp: "app.a",
			items: items("e1", "e2"),
		});
	});

	it("hardens + dedupes published items, drops malformed", () => {
		const store = new SelectionStore();
		store.publish("app.a", [
			{ entityId: "e1", entityType: "t", label: "one" },
			{ entityId: "e1", entityType: "t", label: "dup" }, // deduped
			{ entityId: "", entityType: "t", label: "empty-id" }, // dropped
			"garbage", // dropped
		]);
		const snap = store.current();
		expect(snap?.items.map((i) => i.entityId)).toEqual(["e1"]);
		expect(snap?.items[0]?.label).toBe("one");
	});

	it("publishing an empty set clears only the owner's slot", () => {
		const store = new SelectionStore();
		store.publish("app.a", items("e1"));
		// a different app's empty publish does not clobber app.a's slot
		store.publish("app.b", []);
		expect(store.current()?.sourceApp).toBe("app.a");
		// the owner's empty publish clears it (a deselect)
		store.publish("app.a", []);
		expect(store.current()).toBeNull();
	});

	it("clearForFocus drops the slot when focus leaves the owner", () => {
		const store = new SelectionStore();
		store.publish("app.a", items("e1"));
		store.clearForFocus("app.a"); // still focused → kept
		expect(store.current()?.sourceApp).toBe("app.a");
		store.clearForFocus("app.b"); // focus moved → cleared
		expect(store.current()).toBeNull();
	});

	it("clearForFocus(null) clears (no app focused)", () => {
		const store = new SelectionStore();
		store.publish("app.a", items("e1"));
		store.clearForFocus(null);
		expect(store.current()).toBeNull();
	});

	it("clearApp drops only the named app's slot", () => {
		const store = new SelectionStore();
		store.publish("app.a", items("e1"));
		store.clearApp("app.b");
		expect(store.current()?.sourceApp).toBe("app.a");
		store.clearApp("app.a");
		expect(store.current()).toBeNull();
	});
});

describe("selection-service handler", () => {
	it("publish stamps sourceApp from the verified envelope.app", async () => {
		const { store, handler } = handlerWith(grantAll);
		await handler(envelope(SelectionMethod.Publish, [items("e1")], "io.real.app"));
		expect(store.current()).toEqual({ sourceApp: "io.real.app", items: items("e1") });
	});

	it("current returns the slot", async () => {
		const { store, handler } = handlerWith(grantAll);
		store.publish("io.example.app", items("e1", "e2"));
		await expect(handler(envelope(SelectionMethod.Current))).resolves.toEqual({
			sourceApp: "io.example.app",
			items: items("e1", "e2"),
		});
	});

	it("current self-clears a stale slot against live focus (privacy)", async () => {
		const { store, handler } = handlerWith(grantAll, { getFocusedApp: () => "io.other.app" });
		store.publish("io.example.app", items("e1"));
		// reader is io.example.app but focus is io.other.app → slot is stale → null
		await expect(handler(envelope(SelectionMethod.Current))).resolves.toBeNull();
		expect(store.current()).toBeNull();
	});

	it("current keeps the slot when the owner is focused", async () => {
		const { handler } = handlerWith(grantAll, { getFocusedApp: () => "io.example.app" });
		await handler(envelope(SelectionMethod.Publish, [items("e1")], "io.example.app"));
		await expect(handler(envelope(SelectionMethod.Current))).resolves.toMatchObject({
			sourceApp: "io.example.app",
		});
	});

	it("denies publish without selection.publish", async () => {
		const { handler } = handlerWith(denyAll);
		await expect(handler(envelope(SelectionMethod.Publish, [items("e1")]))).rejects.toMatchObject({
			name: "Denied",
		});
	});

	it("denies current without selection.read", async () => {
		const { handler } = handlerWith(denyAll);
		await expect(handler(envelope(SelectionMethod.Current))).rejects.toMatchObject({
			name: "Denied",
		});
	});

	it("Unavailable when the ledger resolves to null (no vault session)", async () => {
		const handler = makeSelectionServiceHandler({
			store: new SelectionStore(),
			getLedger: async () => null,
		});
		await expect(handler(envelope(SelectionMethod.Current))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("skips the gate entirely when no getLedger is wired (test/non-vault host)", async () => {
		const handler = makeSelectionServiceHandler({ store: new SelectionStore() });
		await expect(handler(envelope(SelectionMethod.Current))).resolves.toBeNull();
	});

	it("rejects an unknown method", async () => {
		const { handler } = handlerWith(grantAll);
		await expect(handler(envelope("bogus"))).rejects.toMatchObject({ name: "Invalid" });
	});
});
