import { describe, expect, it, vi } from "vitest";
import {
	AutomationsHost,
	type ScheduleRegistration,
	type WebhookHit,
	type WebhookIngressPort,
	type WebhookRoute,
	WebhookTargetKind,
	type WebhookTrigger,
} from "./automations-host";

/** A controllable in-memory ingress plane: capture registered routes + push
 *  hits on demand. */
function fakeIngress() {
	let routes: readonly WebhookRoute[] = [];
	const listeners = new Set<(hit: WebhookHit) => void>();
	const port: WebhookIngressPort = {
		register: (next) => {
			routes = next;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		port,
		routes: () => routes,
		push: (hit: WebhookHit) => {
			for (const l of listeners) l(hit);
		},
	};
}

function emptyRegistration(
	webhooks: WebhookTrigger[],
	connectorWebhooks: ScheduleRegistration["connectorWebhooks"] = [],
): ScheduleRegistration {
	return { workflows: [], reminders: [], entityEvents: [], webhooks, connectorWebhooks };
}

function makeHost(
	ingress: WebhookIngressPort,
	runWorkflow: ReturnType<typeof vi.fn>,
	connectorSync?: { runSync: (mappingId: string) => Promise<unknown> },
) {
	const host = new AutomationsHost({
		scheduler: { tick: vi.fn(async () => []) } as never,
		reminderRunner: { fire: vi.fn() } as never,
		loadWorkflow: vi.fn(),
		makeInterpreterPorts: vi.fn(),
		persistRun: vi.fn(),
		appCapabilities: [],
		clock: () => 0,
		webhookIngress: ingress,
		intervals: { set: () => 0 as never, clear: () => {} },
		...(connectorSync ? { connectorSync } : {}),
	});
	// Route runWorkflow through the spy.
	(host as unknown as { runWorkflow: unknown }).runWorkflow = runWorkflow;
	return host;
}

const route: WebhookTrigger = { workflowId: "wf1", routeId: "r1", secret: "s1" };
const workflowHit = (over: Partial<WebhookHit> = {}): WebhookHit => ({
	targetKind: WebhookTargetKind.Workflow,
	targetId: "wf1",
	routeId: "r1",
	method: "POST",
	headers: {},
	bodyText: "",
	...over,
});
const connectorHit = (over: Partial<WebhookHit> = {}): WebhookHit => ({
	targetKind: WebhookTargetKind.ConnectorSync,
	targetId: "map1",
	routeId: "cw1",
	method: "POST",
	headers: {},
	bodyText: "hostile-payload",
	...over,
});

describe("AutomationsHost webhook dispatch (11b.8)", () => {
	it("registers routes on hydrate and runs the bound workflow on a hit", async () => {
		const ingress = fakeIngress();
		const runWorkflow = vi.fn(async () => null);
		const host = makeHost(ingress.port, runWorkflow);

		await host.hydrate(emptyRegistration([route]), 0);
		expect(ingress.routes()).toEqual([
			{ routeId: "r1", targetKind: WebhookTargetKind.Workflow, targetId: "wf1", secret: "s1" },
		]);
		host.start();

		ingress.push(workflowHit({ headers: { "x-a": "b" }, bodyText: "hi" }));
		await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalledTimes(1));
		expect(runWorkflow).toHaveBeenCalledWith("wf1", "webhook:r1", {
			routeId: "r1",
			method: "POST",
			headers: { "x-a": "b" },
			body: "hi",
		});
		host.stop();
	});

	it("drops a hit for a route no longer registered (rehydrate race)", async () => {
		const ingress = fakeIngress();
		const runWorkflow = vi.fn(async () => null);
		const host = makeHost(ingress.port, runWorkflow);
		await host.hydrate(emptyRegistration([route]), 0);
		host.start();

		ingress.push(workflowHit({ targetId: "wfX", routeId: "gone" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(runWorkflow).not.toHaveBeenCalled();
		host.stop();
	});

	it("stop() unsubscribes so a later hit does not fire", async () => {
		const ingress = fakeIngress();
		const runWorkflow = vi.fn(async () => null);
		const host = makeHost(ingress.port, runWorkflow);
		await host.hydrate(emptyRegistration([route]), 0);
		host.start();
		host.stop();

		ingress.push(workflowHit());
		await new Promise((r) => setTimeout(r, 0));
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("AutomationsHost connector webhook dispatch (Connector-6)", () => {
	const connectorRegistration = [
		{ mappingId: "map1", routeId: "cw1", secretSha256: "ab".repeat(32), connectorAppId: "io.x.gh" },
	];

	it("registers connector routes (hash custody) alongside workflow routes and syncs on a hit", async () => {
		const ingress = fakeIngress();
		const runWorkflow = vi.fn(async () => null);
		const runSync = vi.fn(async () => ({}));
		const host = makeHost(ingress.port, runWorkflow, { runSync });

		await host.hydrate(emptyRegistration([route], connectorRegistration), 0);
		expect(ingress.routes()).toEqual([
			{ routeId: "r1", targetKind: WebhookTargetKind.Workflow, targetId: "wf1", secret: "s1" },
			{
				routeId: "cw1",
				targetKind: WebhookTargetKind.ConnectorSync,
				targetId: "map1",
				secretSha256: "ab".repeat(32),
			},
		]);
		host.start();

		ingress.push(connectorHit());
		await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));
		// Doorbell semantics: only the mapping id crosses — the payload never
		// reaches the sync engine — and a connector hit never runs a workflow.
		expect(runSync.mock.calls[0]).toEqual(["map1"]);
		expect(runWorkflow).not.toHaveBeenCalled();
		host.stop();
	});

	it("coalesces a hit storm: one in-flight sync + one trailing run", async () => {
		const ingress = fakeIngress();
		let release: (() => void) | null = null;
		const runSync = vi.fn(
			() =>
				new Promise((resolve) => {
					release = () => resolve({});
				}),
		);
		const host = makeHost(
			ingress.port,
			vi.fn(async () => null),
			{ runSync },
		);
		await host.hydrate(emptyRegistration([], connectorRegistration), 0);
		host.start();

		ingress.push(connectorHit());
		await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(1));
		// Storm while the first sync is in flight.
		ingress.push(connectorHit());
		ingress.push(connectorHit());
		ingress.push(connectorHit());
		expect(runSync).toHaveBeenCalledTimes(1);
		release?.();
		// Exactly ONE trailing run for the whole storm.
		await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(2));
		release?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(runSync).toHaveBeenCalledTimes(2);
		host.stop();
	});

	it("drops a connector hit whose route is no longer registered (revoke race)", async () => {
		const ingress = fakeIngress();
		const runSync = vi.fn(async () => ({}));
		const host = makeHost(
			ingress.port,
			vi.fn(async () => null),
			{ runSync },
		);
		await host.hydrate(emptyRegistration([], connectorRegistration), 0);
		// Revoke: re-hydrate without the endpoint.
		await host.hydrate(emptyRegistration([], []), 0);
		host.start();

		ingress.push(connectorHit());
		await new Promise((r) => setTimeout(r, 0));
		expect(runSync).not.toHaveBeenCalled();
		host.stop();
	});

	it("a sync failure drops the queued flag (next hit re-arms, no retry storm)", async () => {
		const ingress = fakeIngress();
		const onError = vi.fn();
		const runSync = vi.fn(async () => {
			throw new Error("provider down");
		});
		const host = new AutomationsHost({
			scheduler: { tick: vi.fn(async () => []) } as never,
			reminderRunner: { fire: vi.fn() } as never,
			loadWorkflow: vi.fn(),
			makeInterpreterPorts: vi.fn(),
			persistRun: vi.fn(),
			appCapabilities: [],
			clock: () => 0,
			webhookIngress: ingress.port,
			intervals: { set: () => 0 as never, clear: () => {} },
			connectorSync: { runSync },
			onError,
		});
		await host.hydrate(emptyRegistration([], connectorRegistration), 0);
		host.start();

		ingress.push(connectorHit());
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
		expect(runSync).toHaveBeenCalledTimes(1);
		// A later hit dispatches again — the failed state was not left stuck.
		ingress.push(connectorHit());
		await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(2));
		host.stop();
	});
});
