/**
 * Stage 10.11 — the rotation coordinator's fail-closed state machine:
 * intent persisted before the wire, table flipped ONLY on the node's ack,
 * crash-resume idempotency, denial/timeout keeping the old token live,
 * and grace end unsubscribing the previous token.
 */

import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import type { RelaySurface } from "./relay-port";
import {
	MemoryRotationStateStore,
	RotationOutcome,
	RoutingRotationCoordinator,
} from "./routing-rotation";
import { RoutingTokenTable, deriveRoutingToken } from "./routing-token";

const ENTITY = "ent_a";

type FakeRelay = RelaySurface & {
	rotates: Array<{ from: string; to: string; account?: string }>;
	subscribes: string[];
	unsubscribes: string[];
	failWith: Error | null;
};

function makeRelay(): FakeRelay {
	const relay: FakeRelay = {
		rotates: [],
		subscribes: [],
		unsubscribes: [],
		failWith: null,
		currentPort: () => {
			throw new Error("not used");
		},
		onFrame: () => {},
		offFrame: () => {},
		subscribe: (key) => relay.subscribes.push(key),
		unsubscribe: (key) => relay.unsubscribes.push(key),
		requestRotate: (from, to, account) => {
			relay.rotates.push({ from, to, ...(account ? { account } : {}) });
			return relay.failWith ? Promise.reject(relay.failWith) : Promise.resolve();
		},
	};
	return relay;
}

function makeHarness(relay: RelaySurface | null = makeRelay()) {
	const table = new RoutingTokenTable();
	const store = new MemoryRotationStateStore();
	const coordinator = new RoutingRotationCoordinator({
		table,
		store,
		getRelay: () => relay,
		account: "acct-1",
	});
	return { table, store, coordinator };
}

describe("RoutingRotationCoordinator", () => {
	it("happy path: re-home acked → table flips, new token subscribed, intent cleared", async () => {
		const relay = makeRelay();
		const { table, coordinator } = makeHarness(relay);
		const oldDek = generateSymmetricKey();
		const newDek = generateSymmetricKey();
		const from = table.install(ENTITY, oldDek);
		const to = deriveRoutingToken(newDek, ENTITY);

		const outcome = await coordinator.rotate(ENTITY, newDek);

		expect(outcome).toBe(RotationOutcome.Rotated);
		expect(relay.rotates).toEqual([{ from, to, account: "acct-1" }]);
		expect(table.tokenFor(ENTITY)).toBe(to);
		expect(table.resolve(from)).toBe(ENTITY); // grace: old still resolves
		expect(relay.subscribes).toEqual([to]);
		expect(coordinator.pending()).toEqual([]);
	});

	it("same DEK again is AlreadyCurrent — nothing crosses the wire", async () => {
		const relay = makeRelay();
		const { table, coordinator } = makeHarness(relay);
		const dek = generateSymmetricKey();
		table.install(ENTITY, dek);
		expect(await coordinator.rotate(ENTITY, dek)).toBe(RotationOutcome.AlreadyCurrent);
		expect(relay.rotates).toEqual([]);
	});

	it("first-ever install has nothing to re-home", async () => {
		const relay = makeRelay();
		const { table, coordinator } = makeHarness(relay);
		const dek = generateSymmetricKey();
		expect(await coordinator.rotate(ENTITY, dek)).toBe(RotationOutcome.AlreadyCurrent);
		expect(table.tokenFor(ENTITY)).toBe(deriveRoutingToken(dek, ENTITY));
		expect(relay.rotates).toEqual([]);
	});

	it("FAIL-CLOSED: denial/timeout keeps the OLD token current and the intent persisted", async () => {
		const relay = makeRelay();
		relay.failWith = new Error("denied (conflict)");
		const { table, coordinator } = makeHarness(relay);
		const from = table.install(ENTITY, generateSymmetricKey());
		const newDek = generateSymmetricKey();

		await expect(coordinator.rotate(ENTITY, newDek)).rejects.toThrow("denied");

		expect(table.tokenFor(ENTITY)).toBe(from); // emission unaffected
		expect(relay.subscribes).toEqual([]);
		expect(coordinator.pending()).toEqual([
			{ entityId: ENTITY, from, to: deriveRoutingToken(newDek, ENTITY) },
		]);
	});

	it("resumePending re-drives a crashed rotation to completion (idempotent)", async () => {
		const relay = makeRelay();
		relay.failWith = new Error("timeout");
		const { table, coordinator } = makeHarness(relay);
		const from = table.install(ENTITY, generateSymmetricKey());
		const newDek = generateSymmetricKey();
		await coordinator.rotate(ENTITY, newDek).catch(() => {});
		expect(coordinator.pending().length).toBe(1);

		// "Reboot": the node is reachable now.
		relay.failWith = null;
		await coordinator.resumePending((id) => (id === ENTITY ? newDek : null));

		const to = deriveRoutingToken(newDek, ENTITY);
		expect(relay.rotates).toEqual([
			{ from, to, account: "acct-1" },
			{ from, to, account: "acct-1" },
		]);
		expect(table.tokenFor(ENTITY)).toBe(to);
		expect(coordinator.pending()).toEqual([]);
	});

	it("resumePending drops a superseded intent (the DEK rotated again since)", async () => {
		const relay = makeRelay();
		relay.failWith = new Error("timeout");
		const harness = makeHarness(relay);
		harness.table.install(ENTITY, generateSymmetricKey());
		await harness.coordinator.rotate(ENTITY, generateSymmetricKey()).catch(() => {});
		expect(harness.coordinator.pending().length).toBe(1);
		relay.failWith = null;
		// The current DEK is now a THIRD generation — the intent is stale.
		const dek3 = generateSymmetricKey();
		await harness.coordinator.resumePending(() => dek3);
		expect(harness.coordinator.pending()).toEqual([]);
		expect(relay.rotates.length).toBe(1); // only the original (failed) attempt
	});

	it("resumePending keeps the intent when the DEK is unavailable or the relay is down", async () => {
		const relay = makeRelay();
		relay.failWith = new Error("timeout");
		const harness = makeHarness(relay);
		harness.table.install(ENTITY, generateSymmetricKey());
		const newDek = generateSymmetricKey();
		await harness.coordinator.rotate(ENTITY, newDek).catch(() => {});
		relay.failWith = null;
		await harness.coordinator.resumePending(() => null); // DEK gone
		expect(harness.coordinator.pending().length).toBe(1);
	});

	it("no durable transport: local-only flip (nothing to re-home)", async () => {
		const relay = makeRelay();
		(relay as { requestRotate?: unknown }).requestRotate = undefined;
		const { table, coordinator } = makeHarness(relay);
		table.install(ENTITY, generateSymmetricKey());
		const newDek = generateSymmetricKey();
		expect(await coordinator.rotate(ENTITY, newDek)).toBe(RotationOutcome.LocalOnly);
		expect(table.tokenFor(ENTITY)).toBe(deriveRoutingToken(newDek, ENTITY));
	});

	it("endGrace unsubscribes the previous token and drops its resolution", async () => {
		const relay = makeRelay();
		const { table, coordinator } = makeHarness(relay);
		const from = table.install(ENTITY, generateSymmetricKey());
		await coordinator.rotate(ENTITY, generateSymmetricKey());
		expect(table.resolve(from)).toBe(ENTITY);
		coordinator.endGrace(ENTITY);
		expect(relay.unsubscribes).toEqual([from]);
		expect(table.resolve(from)).toBeNull();
	});
});
