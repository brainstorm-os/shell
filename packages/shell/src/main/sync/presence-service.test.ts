/**
 * PRES-2b — the `presence` broker service. Proves the capability gate
 * (`entities.read:<type>`, fail-closed) and that publish/untrack delegate to the
 * router. Mirrors `sharing-service`'s server-side re-check tests.
 */

import { describe, expect, it, vi } from "vitest";
import type { CapabilityLedger } from "../capabilities/ledger";
import type { Envelope } from "../../ipc/envelope";
import type { PresenceRouter } from "./presence-router";
import { makePresenceServiceHandler } from "./presence-service";

const TYPE = "io.brainstorm/whiteboard/v1";
const ENT = "ent_1";
const APP = "io.brainstorm.whiteboard";

function envelope(method: string, args: unknown[], app = APP): Envelope {
	return { v: 1, msg: "m", app, service: "presence", method, args, caps: [] };
}

function fakeRouter() {
	return { publish: vi.fn(), untrack: vi.fn() } as unknown as PresenceRouter & {
		publish: ReturnType<typeof vi.fn>;
		untrack: ReturnType<typeof vi.fn>;
	};
}

function fakeLedger(held: boolean) {
	return { has: vi.fn(() => held) } as unknown as CapabilityLedger;
}

describe("presence service — capability gate", () => {
	it("denies publish when the app lacks entities.read for the type", async () => {
		const router = fakeRouter();
		const handler = makePresenceServiceHandler({
			getRouter: () => router,
			getLedger: async () => fakeLedger(false),
		});
		await expect(
			handler(envelope("publish", [{ entityId: ENT, type: TYPE, state: {} }])),
		).rejects.toMatchObject({ name: "Denied" });
		expect(router.publish).not.toHaveBeenCalled();
	});

	it("checks the specific entities.read:<type> capability", async () => {
		const ledger = fakeLedger(true);
		const handler = makePresenceServiceHandler({
			getRouter: () => fakeRouter(),
			getLedger: async () => ledger,
		});
		await handler(envelope("publish", [{ entityId: ENT, type: TYPE, state: {} }]));
		expect(ledger.has).toHaveBeenCalledWith(APP, `entities.read:${TYPE}`);
	});

	it("fails closed as Unavailable when there's no ledger (no vault)", async () => {
		const handler = makePresenceServiceHandler({
			getRouter: () => fakeRouter(),
			getLedger: async () => null,
		});
		await expect(
			handler(envelope("publish", [{ entityId: ENT, type: TYPE, state: {} }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("passes the gate and delegates publish to the router", async () => {
		const router = fakeRouter();
		const handler = makePresenceServiceHandler({
			getRouter: () => router,
			getLedger: async () => fakeLedger(true),
		});
		const state = { presence: { id: "u", name: "U" } };
		await handler(envelope("publish", [{ entityId: ENT, type: TYPE, state }]));
		expect(router.publish).toHaveBeenCalledWith(APP, ENT, state);
	});

	it("coerces a non-object state to null (clear)", async () => {
		const router = fakeRouter();
		const handler = makePresenceServiceHandler({
			getRouter: () => router,
			getLedger: async () => fakeLedger(true),
		});
		await handler(envelope("publish", [{ entityId: ENT, type: TYPE, state: null }]));
		expect(router.publish).toHaveBeenCalledWith(APP, ENT, null);
	});
});

describe("presence service — validation + untrack", () => {
	it("rejects publish without entityId or type before touching the ledger", async () => {
		const ledger = fakeLedger(true);
		const handler = makePresenceServiceHandler({
			getRouter: () => fakeRouter(),
			getLedger: async () => ledger,
		});
		await expect(handler(envelope("publish", [{ entityId: ENT }]))).rejects.toMatchObject({
			name: "Invalid",
		});
		expect(ledger.has).not.toHaveBeenCalled();
	});

	it("untrack needs no capability and delegates to the router", async () => {
		const router = fakeRouter();
		const ledger = fakeLedger(false);
		const handler = makePresenceServiceHandler({
			getRouter: () => router,
			getLedger: async () => ledger,
		});
		await handler(envelope("untrack", [{ entityId: ENT }]));
		expect(router.untrack).toHaveBeenCalledWith(APP, ENT);
		expect(ledger.has).not.toHaveBeenCalled();
	});

	it("fails closed as Unavailable when there's no router", async () => {
		const handler = makePresenceServiceHandler({ getRouter: () => null });
		await expect(handler(envelope("untrack", [{ entityId: ENT }]))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("rejects an unknown method", async () => {
		const handler = makePresenceServiceHandler({ getRouter: () => fakeRouter() });
		await expect(handler(envelope("nope", [{}]))).rejects.toMatchObject({ name: "Invalid" });
	});
});
