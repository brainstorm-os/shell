/**
 * Connector-6 — ADVERSARIAL probes against the connector webhook-in plane.
 *
 * These are the attacks the pentest gate ran, kept as regression tests:
 *   - route-table collision between a workflow trigger and a connector
 *     endpoint (cross-`WebhookTargetKind` confusion),
 *   - URL parsing (traversal, encoded separators, extra segments, query),
 *   - the 404/405 differentiation surface,
 *   - the body cap on a connector (doorbell) route,
 *   - per-mapping coalescing under a hit storm — trailing liveness and
 *     cross-mapping non-starvation,
 *   - `network.ingress` revocation liveness (a revoked app's endpoint must
 *     stop dispatching, not linger until the next entity write).
 */

import type { CapabilityGrant, CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityChangeEmitter } from "../entities/entity-change-emitter";
import { sha256Hex } from "../storage/registry-repo/connector-webhooks-repo";
import {
	AutomationsHost,
	type ConnectorWebhookRegistration,
	type ScheduleRegistration,
	type WebhookHit,
	type WebhookIngressPort,
	WebhookTargetKind,
	type WebhookTrigger,
} from "./automations-host";
import type { PersistedFire, SchedulerStore } from "./scheduler-service";
import { type WebhookLoopbackListener, createWebhookLoopbackListener } from "./webhook-listener";
import { buildAutomationsDeployment } from "./wiring";

const CONNECTOR_APP = "io.x.github";
const SECRET = "conn-secret-0123456789abcdefghijklmn";
const WF_SECRET = "workflow-plaintext-secret";

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

function fakeIngress() {
	const listeners = new Set<(hit: WebhookHit) => void>();
	const port: WebhookIngressPort = {
		register: () => {},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		port,
		push: (hit: WebhookHit) => {
			for (const l of listeners) l(hit);
		},
	};
}

function makeHost(
	ingress: WebhookIngressPort,
	connectorSync: { runSync: (mappingId: string) => Promise<unknown> },
): AutomationsHost {
	return new AutomationsHost({
		scheduler: { tick: vi.fn(async () => []) } as never,
		reminderRunner: { fire: vi.fn() } as never,
		loadWorkflow: vi.fn(),
		makeInterpreterPorts: vi.fn(),
		persistRun: vi.fn(),
		appCapabilities: [],
		clock: () => 0,
		webhookIngress: ingress,
		intervals: { set: () => 0 as never, clear: () => {} },
		connectorSync,
		onError: () => {},
	});
}

const registration = (
	webhooks: WebhookTrigger[],
	connectorWebhooks: ConnectorWebhookRegistration[],
): ScheduleRegistration => ({
	workflows: [],
	reminders: [],
	entityEvents: [],
	webhooks,
	connectorWebhooks,
});

const connectorHit = (mappingId: string, routeId: string): WebhookHit => ({
	targetKind: WebhookTargetKind.ConnectorSync,
	targetId: mappingId,
	routeId,
	method: "POST",
	headers: {},
	bodyText: "",
});

const endpoint: ConnectorWebhookRegistration = {
	mappingId: "map-1",
	routeId: "cw_route1",
	secretSha256: sha256Hex(SECRET),
	connectorAppId: CONNECTOR_APP,
};

// ─── Ingress plane: parsing + differentiation + body cap ────────────────────

describe("Connector-6 attack — loopback URL parsing and response differentiation", () => {
	let listener: WebhookLoopbackListener | null = null;
	afterEach(async () => {
		await listener?.close();
		listener = null;
	});

	async function start(): Promise<{ port: number; hits: WebhookHit[] }> {
		listener = createWebhookLoopbackListener();
		const port = await listener.whenReady();
		const hits: WebhookHit[] = [];
		listener.subscribe((h) => hits.push(h));
		listener.register([
			{
				routeId: endpoint.routeId,
				targetKind: WebhookTargetKind.ConnectorSync,
				targetId: endpoint.mappingId,
				secretSha256: endpoint.secretSha256,
			},
		]);
		return { port, hits };
	}

	it("refuses every traversal / injection shape of the route + secret segments", async () => {
		const { port, hits } = await start();
		const base = `http://127.0.0.1:${port}`;
		const paths = [
			// extra path segments past the secret
			`/wh/${endpoint.routeId}/${SECRET}/extra`,
			// traversal in either segment
			"/wh/../../etc/passwd",
			`/wh/..%2f..%2fetc/${SECRET}`,
			`/wh/${endpoint.routeId}/..%2f${SECRET}`,
			// an encoded separator must NOT be decoded into a match
			`/wh/${endpoint.routeId}%2f${SECRET}`,
			// percent-encoded secret bytes must not decode into the real secret
			`/wh/${endpoint.routeId}/%63onn-secret-0123456789abcdefghijklmn`,
			// empty segments
			`/wh//${SECRET}`,
			`/wh/${endpoint.routeId}/`,
			// a different prefix
			`/WH/${endpoint.routeId}/${SECRET}`,
		];
		for (const path of paths) {
			const res = await fetch(`${base}${path}`, { method: "POST" });
			expect({ path, status: res.status }).toEqual({ path, status: 404 });
		}
		expect(hits).toHaveLength(0);
	});

	it("accepts a trailing slash and ignores the query string (path-only routing)", async () => {
		const { port, hits } = await start();
		const base = `http://127.0.0.1:${port}`;
		expect(
			(await fetch(`${base}/wh/${endpoint.routeId}/${SECRET}/?x=1`, { method: "POST" })).status,
		).toBe(202);
		await vi.waitFor(() => expect(hits).toHaveLength(1));
		expect(hits[0]?.targetKind).toBe(WebhookTargetKind.ConnectorSync);
	});

	it("405 is reachable ONLY with the correct secret — an unauthenticated non-POST is a plain 404", async () => {
		const { port, hits } = await start();
		const base = `http://127.0.0.1:${port}`;
		for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
			// unknown route
			expect((await fetch(`${base}/wh/nope/${SECRET}`, { method })).status).toBe(404);
			// known route, wrong secret
			expect((await fetch(`${base}/wh/${endpoint.routeId}/wrong`, { method })).status).toBe(404);
			// known route + secret: the method check is the only thing that shows
			expect((await fetch(`${base}/wh/${endpoint.routeId}/${SECRET}`, { method })).status).toBe(405);
		}
		expect(hits).toHaveLength(0);
	});

	it("unknown route and wrong secret are byte-identical responses (no oracle in headers/body)", async () => {
		const { port } = await start();
		const base = `http://127.0.0.1:${port}`;
		const shape = async (path: string) => {
			const res = await fetch(`${base}${path}`, { method: "POST" });
			const headers = [...res.headers.entries()]
				.filter(([k]) => k !== "date")
				.sort()
				.map(([k, v]) => `${k}: ${v}`);
			return { status: res.status, headers, body: await res.text() };
		};
		expect(await shape(`/wh/cw_doesnotexist/${SECRET}`)).toEqual(
			await shape(`/wh/${endpoint.routeId}/definitely-not-the-secret`),
		);
	});

	it("an over-cap body on a doorbell route is 413 and dispatches nothing", async () => {
		const { port, hits } = await start();
		const res = await fetch(`http://127.0.0.1:${port}/wh/${endpoint.routeId}/${SECRET}`, {
			method: "POST",
			body: "x".repeat(256 * 1024 + 1),
		});
		expect(res.status).toBe(413);
		await new Promise((r) => setTimeout(r, 20));
		expect(hits).toHaveLength(0);
	});
});

// ─── Cross-target confusion ────────────────────────────────────────────────

describe("Connector-6 attack — WebhookTargetKind confusion", () => {
	let listener: WebhookLoopbackListener | null = null;
	afterEach(async () => {
		await listener?.close();
		listener = null;
	});

	it("a workflow Trigger entity claiming a connector's routeId cannot hijack or shadow the endpoint", async () => {
		// A malicious `Trigger/v1` entity is app-authored: it can name ANY
		// routeId and its own plaintext secret. The connector endpoint must win
		// the route table, and the attacker's secret must not authenticate.
		const host = makeHost({ port: { register: () => {}, subscribe: () => () => {} } }.port, {
			runSync: async () => null,
		});
		const captured: unknown[] = [];
		host.setWebhookIngress({
			register: (routes) => captured.push([...routes]),
			subscribe: () => () => {},
		});
		await host.hydrate(
			registration(
				[{ workflowId: "wf-evil", routeId: endpoint.routeId, secret: WF_SECRET }],
				[endpoint],
			),
			0,
		);
		const table = captured.at(-1) as Array<{ routeId: string; targetKind: WebhookTargetKind }>;
		const forRoute = table.filter((r) => r.routeId === endpoint.routeId);
		// Both entries are handed over, but the ingress planes key by routeId
		// and the connector entry is registered LAST — it wins.
		listener = createWebhookLoopbackListener();
		const port = await listener.whenReady();
		const hits: WebhookHit[] = [];
		listener.subscribe((h) => hits.push(h));
		listener.register(table as never);

		// The attacker's own plaintext secret must not open the connector route.
		expect(
			(
				await fetch(`http://127.0.0.1:${port}/wh/${endpoint.routeId}/${WF_SECRET}`, {
					method: "POST",
				})
			).status,
		).toBe(404);
		// The connector secret still works and still routes to ConnectorSync.
		expect(
			(
				await fetch(`http://127.0.0.1:${port}/wh/${endpoint.routeId}/${SECRET}`, {
					method: "POST",
				})
			).status,
		).toBe(202);
		await vi.waitFor(() => expect(hits).toHaveLength(1));
		expect(hits[0]?.targetKind).toBe(WebhookTargetKind.ConnectorSync);
		expect(hits[0]?.targetId).toBe(endpoint.mappingId);
		expect(forRoute.at(-1)?.targetKind).toBe(WebhookTargetKind.ConnectorSync);
	});

	it("a ConnectorSync hit whose targetId names a WORKFLOW never runs a workflow", async () => {
		const ingress = fakeIngress();
		const runSync = vi.fn(async () => null);
		const host = makeHost(ingress.port, { runSync });
		const runWorkflow = vi.fn(async () => null);
		(host as unknown as { runWorkflow: unknown }).runWorkflow = runWorkflow;
		await host.hydrate(
			registration([{ workflowId: "wf1", routeId: "r1", secret: WF_SECRET }], [endpoint]),
			0,
		);
		host.start();
		// Forge a hit that claims ConnectorSync but names the workflow id/route.
		ingress.push(connectorHit("wf1", "r1"));
		await new Promise((r) => setTimeout(r, 20));
		expect(runWorkflow).not.toHaveBeenCalled();
		expect(runSync).not.toHaveBeenCalled();
		host.stop();
	});

	it("a Workflow-kind hit naming a connector mapping/route never dispatches a sync", async () => {
		const ingress = fakeIngress();
		const runSync = vi.fn(async () => null);
		const host = makeHost(ingress.port, { runSync });
		const runWorkflow = vi.fn(async () => null);
		(host as unknown as { runWorkflow: unknown }).runWorkflow = runWorkflow;
		await host.hydrate(registration([], [endpoint]), 0);
		host.start();
		ingress.push({
			targetKind: WebhookTargetKind.Workflow,
			targetId: endpoint.mappingId,
			routeId: endpoint.routeId,
			method: "POST",
			headers: {},
			bodyText: "",
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(runWorkflow).not.toHaveBeenCalled();
		expect(runSync).not.toHaveBeenCalled();
		host.stop();
	});
});

// ─── Coalescer: trailing liveness + cross-mapping non-starvation ────────────

describe("Connector-6 attack — coalescer under a hit storm", () => {
	it("a 500-hit flood on one mapping collapses to 2 runs and never starves a sibling mapping", async () => {
		const ingress = fakeIngress();
		const started: string[] = [];
		// A holder, not a `let` — TS narrows a `let` assigned only inside a
		// callback to `null` and the later call fails to typecheck.
		const gate: { release: (() => void) | null } = { release: null };
		const runSync = vi.fn(async (mappingId: string) => {
			started.push(mappingId);
			if (mappingId === "map-1" && started.filter((m) => m === "map-1").length === 1) {
				await new Promise<void>((resolve) => {
					gate.release = resolve;
				});
			}
			return null;
		});
		const host = makeHost(ingress.port, { runSync });
		const second: ConnectorWebhookRegistration = {
			mappingId: "map-2",
			routeId: "cw_route2",
			secretSha256: sha256Hex("other"),
			connectorAppId: CONNECTOR_APP,
		};
		await host.hydrate(registration([], [endpoint, second]), 0);
		host.start();

		for (let i = 0; i < 500; i += 1) ingress.push(connectorHit("map-1", "cw_route1"));
		await vi.waitFor(() => expect(started.filter((m) => m === "map-1")).toHaveLength(1));

		// A sibling mapping is NOT blocked by map-1's in-flight sync.
		ingress.push(connectorHit("map-2", "cw_route2"));
		await vi.waitFor(() => expect(started).toContain("map-2"));

		gate.release?.();
		// Exactly one trailing run for map-1 — the flood does not amplify.
		await vi.waitFor(() => expect(started.filter((m) => m === "map-1")).toHaveLength(2));
		await new Promise((r) => setTimeout(r, 20));
		expect(started.filter((m) => m === "map-1")).toHaveLength(2);

		// No per-mapping state is retained after the loop drains.
		const states = (host as unknown as { connectorSyncStates: Map<string, unknown> })
			.connectorSyncStates;
		await vi.waitFor(() => expect(states.size).toBe(0));
		host.stop();
	});
});

// ─── Grant revocation liveness ─────────────────────────────────────────────

describe("Connector-6 attack — network.ingress revocation liveness", () => {
	it("a live endpoint stops dispatching the moment the connector app loses network.ingress", async () => {
		let grants: Record<string, string[]> = { [CONNECTOR_APP]: ["network.ingress"] };
		const runSync = vi.fn(async () => ({}));
		const dep = buildAutomationsDeployment({
			callEntities: async (method) => (method === "query" ? [] : null),
			getServiceHandler: () => undefined,
			getLedger: async () => ledgerWith(grants),
			schedulerStore: memorySchedulerStore(),
			entityChanges: new EntityChangeEmitter(),
			notify: () => {},
			deviceId: "device-A",
			connectorSync: { runSync },
			listConnectorWebhooks: async () => [endpoint],
			intervals: { set: () => 0 as unknown as ReturnType<typeof setInterval>, clear: () => {} },
		});
		await dep.start();
		try {
			let base: string | null = null;
			await vi.waitFor(async () => {
				base = (await dep.webhookInfo()).loopbackBaseUrl;
				expect(base).not.toBeNull();
			});
			const url = `${base as unknown as string}/wh/${endpoint.routeId}/${SECRET}`;
			expect((await fetch(url, { method: "POST" })).status).toBe(202);
			await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));

			// The user revokes `network.ingress` from the connector app in
			// Settings. Nothing rewrites an automation entity, so nothing
			// re-derives the schedule on its own — the endpoint must still stop
			// pulling from the provider on the very next hit (the host's per-fire
			// live re-check), even though the socket has not been re-hydrated.
			grants = {};
			expect((await fetch(url, { method: "POST" })).status).toBe(202);
			await new Promise((r) => setTimeout(r, 30));
			expect(runSync).toHaveBeenCalledTimes(1);

			// And once the revoke re-derives the route table (what
			// `ledger:revoke`'s `onGrantsChanged` hook now does), the URL is dead.
			await dep.rehydrate();
			expect((await fetch(url, { method: "POST" })).status).toBe(404);
			await new Promise((r) => setTimeout(r, 30));
			expect(runSync).toHaveBeenCalledTimes(1);
		} finally {
			dep.stop();
		}
	});

	it("a revoke landing MID-STORM stops the coalescer loop instead of riding out the queue", async () => {
		const ingress = fakeIngress();
		let allowed = true;
		const runSync = vi.fn(async () => null);
		const host = makeHost(ingress.port, { runSync });
		(host as unknown as { ports: { connectorWebhookAllowed: unknown } }).ports = {
			...(host as unknown as { ports: object }).ports,
			connectorWebhookAllowed: async () => allowed,
		};
		await host.hydrate(registration([], [endpoint]), 0);
		host.start();

		ingress.push(connectorHit("map-1", "cw_route1"));
		await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));
		// Queue a trailing run, then revoke before it starts.
		allowed = false;
		ingress.push(connectorHit("map-1", "cw_route1"));
		await new Promise((r) => setTimeout(r, 30));
		expect(runSync).toHaveBeenCalledTimes(1);
		host.stop();
	});

	it("a throwing grant check denies (fail-closed), never approves", async () => {
		const ingress = fakeIngress();
		const runSync = vi.fn(async () => null);
		const host = makeHost(ingress.port, { runSync });
		(host as unknown as { ports: { connectorWebhookAllowed: unknown } }).ports = {
			...(host as unknown as { ports: object }).ports,
			connectorWebhookAllowed: async () => {
				throw new Error("ledger unavailable");
			},
		};
		await host.hydrate(registration([], [endpoint]), 0);
		host.start();
		ingress.push(connectorHit("map-1", "cw_route1"));
		await new Promise((r) => setTimeout(r, 30));
		expect(runSync).not.toHaveBeenCalled();
		host.stop();
	});
});
