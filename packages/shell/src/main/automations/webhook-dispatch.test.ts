import { describe, expect, it, vi } from "vitest";
import {
	AutomationsHost,
	type ScheduleRegistration,
	type WebhookHit,
	type WebhookIngressPort,
	type WebhookTrigger,
} from "./automations-host";

/** A controllable in-memory ingress plane: capture registered routes + push
 *  hits on demand. */
function fakeIngress() {
	let routes: readonly WebhookTrigger[] = [];
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

function emptyRegistration(webhooks: WebhookTrigger[]): ScheduleRegistration {
	return { workflows: [], reminders: [], entityEvents: [], webhooks };
}

function makeHost(ingress: WebhookIngressPort, runWorkflow: ReturnType<typeof vi.fn>) {
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
	});
	// Route runWorkflow through the spy.
	(host as unknown as { runWorkflow: unknown }).runWorkflow = runWorkflow;
	return host;
}

const route: WebhookTrigger = { workflowId: "wf1", routeId: "r1", secret: "s1" };

describe("AutomationsHost webhook dispatch (11b.8)", () => {
	it("registers routes on hydrate and runs the bound workflow on a hit", async () => {
		const ingress = fakeIngress();
		const runWorkflow = vi.fn(async () => null);
		const host = makeHost(ingress.port, runWorkflow);

		await host.hydrate(emptyRegistration([route]), 0);
		expect(ingress.routes()).toEqual([route]);
		host.start();

		ingress.push({
			workflowId: "wf1",
			routeId: "r1",
			method: "POST",
			headers: { "x-a": "b" },
			bodyText: "hi",
		});
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

		ingress.push({ workflowId: "wfX", routeId: "gone", method: "POST", headers: {}, bodyText: "" });
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

		ingress.push({ workflowId: "wf1", routeId: "r1", method: "POST", headers: {}, bodyText: "" });
		await new Promise((r) => setTimeout(r, 0));
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});
