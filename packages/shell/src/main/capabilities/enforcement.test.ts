/**
 * Stage 4.8 — fail-closed integration test.
 *
 * End-to-end: broker + ledger + storage. Verifies that:
 *   - With the ledger up + grants present, calls succeed.
 *   - With the ledger up + grants missing, calls return CapabilityDenied.
 *   - With the ledger DB closed (corruption proxy), calls return
 *  Unavailable — the broker MUST NOT fail open per §Failure-open
 *     vs fail-closed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Broker } from "../../ipc/broker";
import { makeEnvelope } from "../../ipc/envelope";
import { DataStores } from "../storage/data-stores";
import { applyDefaultAppGrants, applyShellGrants } from "./default-grants";
import { CapabilityLedger, GrantedVia } from "./ledger";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-cap-enforce-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("ledger");
	const ledger = new CapabilityLedger(db);
	applyShellGrants(ledger);
	applyDefaultAppGrants(ledger, "io.example.app");

	const broker = new Broker({
		services: new Map([["storage", () => "ok"]]),
		checkCapability: (app, _service, _method, declaredCaps) => {
			// Verify every declared cap is actually granted (or that none are
			// declared — methods that need no cap are allowed).
			return declaredCaps.every((cap) => ledger.has(app, cap));
		},
	});
	return { vaultDir, stores, ledger, broker };
}

function mk(app: string, service: string, method: string, caps: string[]) {
	return makeEnvelope({
		msg: `m_${Math.random().toString(36).slice(2, 8)}`,
		app,
		service,
		method,
		args: [],
		caps,
	});
}

describe("capability enforcement (end-to-end)", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("allows shell calls with broad-scope grants", async () => {
		const reply = await env.broker.dispatch(
			mk("shell", "storage", "ping", ["entities.read:any.type/v1"]),
			"src",
		);
		expect(reply.ok).toBe(true);
	});

	it("allows default-minimum app calls (storage.kv)", async () => {
		const reply = await env.broker.dispatch(
			mk("io.example.app", "storage", "ping", ["storage.kv"]),
			"src",
		);
		expect(reply.ok).toBe(true);
	});

	it("rejects app calls that claim a capability they don't have", async () => {
		const reply = await env.broker.dispatch(
			mk("io.example.app", "storage", "ping", ["entities.read:io.example/Note/v1"]),
			"src",
		);
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("CapabilityDenied");
	});

	it("rejects calls from unknown apps that claim any cap", async () => {
		const reply = await env.broker.dispatch(
			mk("never.installed", "storage", "ping", ["storage.kv"]),
			"src",
		);
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("CapabilityDenied");
	});

	it("after revocation, calls with the revoked cap are denied", async () => {
		const before = await env.broker.dispatch(
			mk("io.example.app", "storage", "ping", ["storage.kv"]),
			"src",
		);
		expect(before.ok).toBe(true);

		env.ledger.revoke("io.example.app", "storage.kv");

		const after = await env.broker.dispatch(
			mk("io.example.app", "storage", "ping", ["storage.kv"]),
			"src",
		);
		expect(after.ok).toBe(false);
		expect(after.ok === false && after.error.kind).toBe("CapabilityDenied");
	});

	it("fail-closed: closed ledger DB causes Unavailable, never approval", async () => {
		// Simulate ledger corruption / unavailability by closing the underlying DB.
		// The CapabilityLedger will throw LedgerUnavailableError on has(); the
		// broker MUST map that to Unavailable per
		env.stores.close();
		const reply = await env.broker.dispatch(
			mk("io.example.app", "storage", "ping", ["storage.kv"]),
			"src",
		);
		expect(reply.ok).toBe(false);
		expect(reply.ok === false && reply.error.kind).toBe("Unavailable");
		expect(reply.ok === false && reply.error.message).toMatch(/ledger/i);
	});

	it("a call with no declared caps proceeds (method requires nothing)", async () => {
		const reply = await env.broker.dispatch(mk("io.example.app", "storage", "ping", []), "src");
		expect(reply.ok).toBe(true);
	});

	it("onDenied emits CapabilityDenied with full context", async () => {
		const events: Array<{ kind: string; app: string }> = [];
		const broker = new Broker({
			services: new Map([["storage", () => "ok"]]),
			checkCapability: (app, _s, _m, caps) => caps.every((c) => env.ledger.has(app, c)),
			onDenied: (e) => events.push({ kind: e.kind, app: e.app }),
		});
		await broker.dispatch(
			mk("io.example.app", "storage", "ping", ["entities.read:io.example/Note/v1"]),
			"src",
		);
		expect(events).toEqual([{ kind: "CapabilityDenied", app: "io.example.app" }]);
	});

	// F-241 / doc 75 — the Agent → Notes seam's capability gate. The write
	// chain's broker chokepoint is the verb-scoped `intents.dispatch:insert`
	// grant: NOT in the default-minimum set (only `:open` is), so an app that
	// wasn't explicitly granted it — sideloaded agent, revoked grant — is
	// denied before the intents bus ever runs.
	describe("intents.dispatch:insert gate (F-241)", () => {
		function dispatchInsert(app: string) {
			return env.broker.dispatch(
				makeEnvelope({
					msg: `m_${Math.random().toString(36).slice(2, 8)}`,
					app,
					service: "intents",
					method: "dispatch",
					args: [
						{
							verb: "insert",
							payload: { entityId: "note-1", entityType: "io.brainstorm.notes/Note/v1" },
						},
					],
					caps: ["intents.dispatch:insert"],
				}),
				"src",
			);
		}

		beforeEach(() => {
			env.broker.registerService("intents", () => ({ handled: true }));
		});

		it("denies an insert dispatch without the verb-scoped grant (default grants carry only :open)", async () => {
			const reply = await dispatchInsert("io.example.app");
			expect(reply.ok).toBe(false);
			expect(reply.ok === false && reply.error.kind).toBe("CapabilityDenied");
		});

		it("allows the insert dispatch once the grant is recorded, and denies again after revoke", async () => {
			env.ledger.grant({
				appId: "io.example.app",
				capability: "intents.dispatch",
				scope: "insert",
				grantedVia: GrantedVia.Install,
			});
			const granted = await dispatchInsert("io.example.app");
			expect(granted.ok).toBe(true);

			env.ledger.revoke("io.example.app", "intents.dispatch", "insert");
			const revoked = await dispatchInsert("io.example.app");
			expect(revoked.ok).toBe(false);
			expect(revoked.ok === false && revoked.error.kind).toBe("CapabilityDenied");
		});
	});
});
