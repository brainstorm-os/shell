import { describe, expect, it, vi } from "vitest";
import type { WebhookHit, WebhookTrigger } from "./automations-host";
import {
	type WebhookRelayInbound,
	type WebhookRelayTransport,
	createWebhookRelayPort,
} from "./webhook-relay-port";

function fakeTransport() {
	let onInbound: ((msg: WebhookRelayInbound) => void) | null = null;
	const setRoutes = vi.fn<(routeIds: readonly string[]) => void>();
	const close = vi.fn();
	const transport: WebhookRelayTransport = {
		setRoutes,
		onInbound: (cb) => {
			onInbound = cb;
			return () => {
				onInbound = null;
			};
		},
		close,
	};
	return {
		transport,
		setRoutes,
		close,
		deliver: (msg: WebhookRelayInbound) => onInbound?.(msg),
		isWired: () => onInbound !== null,
	};
}

const route: WebhookTrigger = { workflowId: "wf1", routeId: "r1", secret: "s1" };

describe("webhook relay port (11b.8)", () => {
	it("tells the transport which routeIds to forward on register", () => {
		const t = fakeTransport();
		const port = createWebhookRelayPort(t.transport);
		port.register([route, { workflowId: "wf2", routeId: "r2", secret: "s2" }]);
		expect(t.setRoutes).toHaveBeenCalledWith(["r1", "r2"]);
	});

	it("re-verifies the secret (relay untrusted) and emits a hit on a match", () => {
		const t = fakeTransport();
		const port = createWebhookRelayPort(t.transport);
		const hits: WebhookHit[] = [];
		port.subscribe((h) => hits.push(h));
		port.register([route]);

		t.deliver({ routeId: "r1", secret: "s1", method: "POST", headers: { a: "b" }, bodyText: "x" });
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ workflowId: "wf1", routeId: "r1", bodyText: "x" });
		expect((hits[0] as unknown as { secret?: string }).secret).toBeUndefined();
	});

	it("drops an inbound whose secret does not match the registered route", () => {
		const t = fakeTransport();
		const port = createWebhookRelayPort(t.transport);
		const hits: WebhookHit[] = [];
		port.subscribe((h) => hits.push(h));
		port.register([route]);

		t.deliver({ routeId: "r1", secret: "WRONG", method: "POST", headers: {}, bodyText: "" });
		t.deliver({ routeId: "unknown", secret: "s1", method: "POST", headers: {}, bodyText: "" });
		expect(hits).toHaveLength(0);
	});

	it("close tears down the transport subscription", () => {
		const t = fakeTransport();
		const port = createWebhookRelayPort(t.transport);
		expect(t.isWired()).toBe(true);
		port.close();
		expect(t.isWired()).toBe(false);
		expect(t.close).toHaveBeenCalled();
	});
});
