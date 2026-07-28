/**
 * Connector-6 — the deployment-level connector webhook plane, end to end over
 * a REAL loopback listener: registry-store routes register only for connector
 * apps holding `network.ingress` (fail-closed), an authenticated inbound POST
 * dispatches `connectors.sync(mappingId)` (payload discarded), and a revoke
 * takes effect live via `rehydrate()` (the URL goes dead).
 */

import type { CapabilityGrant, CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { describe, expect, it, vi } from "vitest";
import { EntityChangeEmitter } from "../entities/entity-change-emitter";
import { sha256Hex } from "../storage/registry-repo/connector-webhooks-repo";
import type { ConnectorWebhookRegistration } from "./automations-host";
import type { PersistedFire, SchedulerStore } from "./scheduler-service";
import { buildAutomationsDeployment } from "./wiring";

const CONNECTOR_APP = "io.x.github";
const SECRET = "conn-secret-0123456789abcdefghijklmn";

function ledgerWith(perApp: Record<string, string[]>): CapabilityLedger {
	return {
		listActive: (appId: string): CapabilityGrant[] =>
			(perApp[appId] ?? []).map(
				(capability, i) =>
					({
						id: `g${i}`,
						appId,
						capability,
						scope: null,
						grantedAt: 0,
						grantedVia: "install",
					}) as CapabilityGrant,
			),
		has: (appId: string, capability: string) => (perApp[appId] ?? []).includes(capability),
	} as unknown as CapabilityLedger;
}

function memorySchedulerStore(): SchedulerStore {
	const fires = new Map<string, PersistedFire>();
	return {
		loadAll: () => [...fires.values()],
		save: (f) => void fires.set(f.triggerId, f),
		remove: (id) => void fires.delete(id),
	};
}

function deployment(input: {
	endpoints: () => readonly ConnectorWebhookRegistration[];
	grants: Record<string, string[]>;
	runSync?: (mappingId: string) => Promise<unknown>;
}) {
	const runSync = vi.fn(input.runSync ?? (async () => ({})));
	const dep = buildAutomationsDeployment({
		callEntities: async (method) => (method === "query" ? [] : null),
		getServiceHandler: () => undefined,
		getLedger: async () => ledgerWith(input.grants),
		schedulerStore: memorySchedulerStore(),
		entityChanges: new EntityChangeEmitter(),
		notify: () => {},
		deviceId: "device-A",
		connectorSync: { runSync },
		listConnectorWebhooks: async () => input.endpoints(),
		intervals: { set: () => 0 as unknown as ReturnType<typeof setInterval>, clear: () => {} },
	});
	return { dep, runSync };
}

/** The listener binds asynchronously after start()/rehydrate() — wait for the
 *  loopback base to surface before hitting it. */
async function boundBaseUrl(dep: ReturnType<typeof buildAutomationsDeployment>): Promise<string> {
	let base: string | null = null;
	await vi.waitFor(async () => {
		base = (await dep.webhookInfo()).loopbackBaseUrl;
		expect(base).not.toBeNull();
	});
	return base as unknown as string;
}

const endpoint: ConnectorWebhookRegistration = {
	mappingId: "map-1",
	routeId: "cw_route1",
	secretSha256: sha256Hex(SECRET),
	connectorAppId: CONNECTOR_APP,
};

describe("connector webhook plane (Connector-6)", () => {
	it("binds the shared listener for a granted connector endpoint (no automations grant) and dispatches sync on an authenticated POST", async () => {
		const { dep, runSync } = deployment({
			endpoints: () => [endpoint],
			// ONLY the connector app holds network.ingress — the automations app
			// does not; the listener must still come up for the connector plane.
			grants: { [CONNECTOR_APP]: ["network.ingress"] },
		});
		await dep.start();
		try {
			const base = await boundBaseUrl(dep);

			const ok = await fetch(`${base}/wh/cw_route1/${SECRET}`, {
				method: "POST",
				body: "doorbell",
			});
			expect(ok.status).toBe(202);
			await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));
			expect(runSync).toHaveBeenCalledWith("map-1");

			// Wrong secret: oracle-free 404, no dispatch.
			const bad = await fetch(`${base}/wh/cw_route1/wrong`, { method: "POST" });
			expect(bad.status).toBe(404);
			expect(runSync).toHaveBeenCalledTimes(1);
		} finally {
			dep.stop();
		}
	});

	it("fail-closed: without the connector app's network.ingress grant no route registers and no listener binds", async () => {
		const { dep, runSync } = deployment({
			endpoints: () => [endpoint],
			grants: {}, // nobody holds network.ingress
		});
		await dep.start();
		try {
			const info = await dep.webhookInfo();
			expect(info.loopbackBaseUrl).toBeNull();
			expect(runSync).not.toHaveBeenCalled();
		} finally {
			dep.stop();
		}
	});

	it("revoke: rehydrate() after the store drops the endpoint kills the URL live", async () => {
		let rows: readonly ConnectorWebhookRegistration[] = [endpoint];
		const { dep, runSync } = deployment({
			endpoints: () => rows,
			grants: { [CONNECTOR_APP]: ["network.ingress"] },
		});
		await dep.start();
		try {
			const base = await boundBaseUrl(dep);
			expect((await fetch(`${base}/wh/cw_route1/${SECRET}`, { method: "POST" })).status).toBe(202);
			await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));

			rows = []; // the service revoked the endpoint
			await dep.rehydrate();
			expect((await fetch(`${base}/wh/cw_route1/${SECRET}`, { method: "POST" })).status).toBe(404);
			expect(runSync).toHaveBeenCalledTimes(1);
		} finally {
			dep.stop();
		}
	});

	it("a mint mid-session binds the listener on rehydrate (first endpoint ever)", async () => {
		let rows: readonly ConnectorWebhookRegistration[] = [];
		const { dep, runSync } = deployment({
			endpoints: () => rows,
			grants: { [CONNECTOR_APP]: ["network.ingress"] },
		});
		await dep.start();
		try {
			expect((await dep.webhookInfo()).loopbackBaseUrl).toBeNull();

			rows = [endpoint]; // the service minted the first endpoint
			await dep.rehydrate();
			const base = await boundBaseUrl(dep);
			expect((await fetch(`${base}/wh/cw_route1/${SECRET}`, { method: "POST" })).status).toBe(202);
			await vi.waitFor(() => expect(runSync).toHaveBeenCalledWith("map-1"));
		} finally {
			dep.stop();
		}
	});
});
