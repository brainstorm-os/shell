/**
 * PRES-4 — two-device presence over the live-sync awareness path (the
 * `/pentester` gate, automated). Mirrors `collab-scenario.test.ts` + the
 * loopback harness in `presence-router.test.ts`: two PresenceRouters wired
 * through paired PresenceManagers whose relay emit crosses the loopback, with
 * adversarial checks on entity isolation and the forged-type service gate.
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { AWARENESS_DEBOUNCE_MS } from "./awareness-broadcaster";
import type { PipelineContext } from "./envelope-pipeline";
import { PresenceManager } from "./presence-manager";
import type { PresenceRouter } from "./presence-router";
import { type PresenceServiceOptions, makePresenceServiceHandler } from "./presence-service";

const stub = {} as PipelineContext;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(AWARENESS_DEBOUNCE_MS + 40);

const ENT = "ent_shared";
const OTHER = "ent_other";
const TYPE = "brainstorm/Note/v1";
const APP = "io.brainstorm.notes";
const mira = { presence: { id: "u_mira", name: "Mira", color: "#e8590c" } };
const marcus = { presence: { id: "u_marcus", name: "Marcus", color: "#2f6df6" } };

function peerNames(states: Record<string, unknown>[]): string[] {
	return states
		.map((s) => (s.presence as { name?: string } | undefined)?.name)
		.filter((n): n is string => typeof n === "string");
}

describe("PRES-4 — two-device presence scenario", () => {
	let managerA: PresenceManager;
	let managerB: PresenceManager;

	afterEach(() => {
		managerA?.dispose();
		managerB?.dispose();
	});

	function wireManagers(): void {
		managerA = new PresenceManager({
			pipeline: stub,
			emit: async (e, u) => managerB.applyInbound(e, u),
		});
		managerB = new PresenceManager({
			pipeline: stub,
			emit: async (e, u) => managerA.applyInbound(e, u),
		});
	}

	it("Mira and Marcus see each other's presence over the relay loopback", async () => {
		wireManagers();
		managerA.setLocal(ENT, mira);
		managerB.setLocal(ENT, marcus);
		await settle();
		expect(peerNames([...managerA.remoteStates(ENT).values()])).toContain("Marcus");
		expect(peerNames([...managerB.remoteStates(ENT).values()])).toContain("Mira");
		expect(peerNames([...managerA.remoteStates(ENT).values()])).not.toContain("Mira");
	});

	it("presence on one entity does not leak to another", async () => {
		wireManagers();
		managerA.setLocal(ENT, mira);
		await settle();
		expect(managerB.remoteStates(OTHER).size).toBe(0);
	});

	it("forged app-supplied type cannot bypass the capability gate", async () => {
		const router = { publish: vi.fn(), untrack: vi.fn() } as unknown as PresenceRouter & {
			publish: ReturnType<typeof vi.fn>;
		};
		const ledger = {
			has: vi.fn((_app: string, cap: string) => cap === `entities.read:${TYPE}`),
		} as unknown as CapabilityLedger;
		const handler = makePresenceServiceHandler({
			getRouter: () => router,
			resolveEntityType: async () => "io.brainstorm/secret/v1",
			getLedger: async () => ledger,
		} as PresenceServiceOptions);
		const envelope: Envelope = {
			v: 1,
			msg: "m",
			app: APP,
			service: "presence",
			method: "publish",
			args: [{ entityId: ENT, type: TYPE, state: mira }],
			caps: [],
		};
		await expect(handler(envelope)).rejects.toMatchObject({ name: "Denied" });
		expect(router.publish).not.toHaveBeenCalled();
	});
});
