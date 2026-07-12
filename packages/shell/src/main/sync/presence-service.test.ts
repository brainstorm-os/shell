/**
 * PRES-2b — the `presence` broker service. Proves the capability gate keys on
 * the entity's REAL (server-resolved) type — never the app-supplied one — is
 * fail-closed, and that publish/untrack delegate to the router. Mirrors
 * `sharing-service`'s server-side re-check tests.
 */

import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import type { CapabilityLedger } from "../capabilities/ledger";
import type { PresenceRouter } from "./presence-router";
import { type PresenceServiceOptions, makePresenceServiceHandler } from "./presence-service";

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

/** Build a handler with sensible defaults (entity resolves to TYPE, cap held). */
function makeHandler(overrides: Partial<PresenceServiceOptions> = {}) {
	return makePresenceServiceHandler({
		getRouter: () => fakeRouter(),
		resolveEntityType: async () => TYPE,
		getLedger: async () => fakeLedger(true),
		...overrides,
	});
}

describe("presence service — capability gate", () => {
	it("denies publish when the app lacks entities.read for the type", async () => {
		const router = fakeRouter();
		const handler = makeHandler({
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
		const handler = makeHandler({ getLedger: async () => ledger });
		await handler(envelope("publish", [{ entityId: ENT, type: TYPE, state: {} }]));
		expect(ledger.has).toHaveBeenCalledWith(APP, `entities.read:${TYPE}`);
	});

	it("gates on the SERVER-RESOLVED type, not the app-supplied one (forged-type bypass)", async () => {
		// The entity is really `secret`, but the app only holds `entities.read:note`
		// and forges `type: note`. The gate must resolve `secret` and deny.
		const router = fakeRouter();
		const ledger = {
			has: vi.fn((_app: string, cap: string) => cap === "entities.read:io.brainstorm/note/v1"),
		} as unknown as CapabilityLedger;
		const handler = makeHandler({
			getRouter: () => router,
			resolveEntityType: async () => "io.brainstorm/secret/v1",
			getLedger: async () => ledger,
		});
		await expect(
			handler(envelope("publish", [{ entityId: ENT, type: "io.brainstorm/note/v1", state: {} }])),
		).rejects.toMatchObject({ name: "Denied" });
		expect(ledger.has).toHaveBeenCalledWith(APP, "entities.read:io.brainstorm/secret/v1");
		expect(ledger.has).not.toHaveBeenCalledWith(APP, "entities.read:io.brainstorm/note/v1");
		expect(router.publish).not.toHaveBeenCalled();
	});

	it("denies publish for an entity unknown to the vault", async () => {
		const router = fakeRouter();
		const ledger = fakeLedger(true);
		const handler = makeHandler({
			getRouter: () => router,
			resolveEntityType: async () => null,
			getLedger: async () => ledger,
		});
		await expect(
			handler(envelope("publish", [{ entityId: ENT, type: TYPE, state: {} }])),
		).rejects.toMatchObject({ name: "Invalid" });
		expect(ledger.has).not.toHaveBeenCalled();
		expect(router.publish).not.toHaveBeenCalled();
	});

	it("fails closed as Unavailable when there's no ledger (no vault)", async () => {
		const handler = makeHandler({ getLedger: async () => null });
		await expect(
			handler(envelope("publish", [{ entityId: ENT, type: TYPE, state: {} }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("passes the gate and delegates publish to the router", async () => {
		const router = fakeRouter();
		const handler = makeHandler({ getRouter: () => router });
		const state = { presence: { id: "u", name: "U" } };
		await handler(envelope("publish", [{ entityId: ENT, type: TYPE, state }]));
		expect(router.publish).toHaveBeenCalledWith(APP, ENT, state);
	});

	it("coerces a non-object state to null (clear)", async () => {
		const router = fakeRouter();
		const handler = makeHandler({ getRouter: () => router });
		await handler(envelope("publish", [{ entityId: ENT, type: TYPE, state: null }]));
		expect(router.publish).toHaveBeenCalledWith(APP, ENT, null);
	});
});

describe("presence service — validation + untrack", () => {
	it("rejects publish without an entityId before touching the resolver or ledger", async () => {
		const ledger = fakeLedger(true);
		const resolveEntityType = vi.fn(async () => TYPE);
		const handler = makeHandler({ resolveEntityType, getLedger: async () => ledger });
		await expect(handler(envelope("publish", [{ type: TYPE }]))).rejects.toMatchObject({
			name: "Invalid",
		});
		expect(resolveEntityType).not.toHaveBeenCalled();
		expect(ledger.has).not.toHaveBeenCalled();
	});

	it("untrack needs no capability and delegates to the router", async () => {
		const router = fakeRouter();
		const ledger = fakeLedger(false);
		const resolveEntityType = vi.fn(async () => TYPE);
		const handler = makeHandler({
			getRouter: () => router,
			resolveEntityType,
			getLedger: async () => ledger,
		});
		await handler(envelope("untrack", [{ entityId: ENT }]));
		expect(router.untrack).toHaveBeenCalledWith(APP, ENT);
		expect(ledger.has).not.toHaveBeenCalled();
		expect(resolveEntityType).not.toHaveBeenCalled();
	});

	it("fails closed as Unavailable when there's no router", async () => {
		const handler = makeHandler({ getRouter: () => null });
		await expect(handler(envelope("untrack", [{ entityId: ENT }]))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("rejects an unknown method", async () => {
		const handler = makeHandler();
		await expect(handler(envelope("nope", [{}]))).rejects.toMatchObject({ name: "Invalid" });
	});
});
