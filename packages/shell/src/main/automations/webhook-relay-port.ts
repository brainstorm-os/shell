/**
 * 11b.8 — the relay webhook ingress plane (desktop side). When the desktop is
 * unreachable directly (behind NAT — the common case), an external service
 * can't hit the loopback listener. Instead a hosted relay terminates
 * `POST https://<relay>/wh/<routeId>/<secret>` and forwards the request down a
 * connection the desktop holds open. This module is that desktop-side client.
 *
 * Separation of planes (deliberate): this does NOT ride the DEK-sealed sync
 * `RelayPort` (which is relay-BLIND — a CI fence forbids it from touching
 * content/crypto and it only routes encrypted vault frames by routing key). A
 * webhook body is plaintext external ingress, a different plane, so it gets its
 * own transport. The concrete WebSocket transport + the relay node route are
 * deployment (owner ops); this port is written against the transport interface
 * and is inert until one is supplied — exactly like `syncRelay` is dormant
 * until a relay is paired.
 *
 * Trust: the relay is UNTRUSTED for authentication. It forwards the secret from
 * the URL; the desktop re-verifies it constant-time (`webhookSecretMatches`)
 * against the registered route before firing. The relay never holds vault keys
 * and cannot mint a hit for a route/secret it doesn't already carry.
 */

import type { WebhookHit, WebhookIngressPort, WebhookTrigger } from "./automations-host";
import { webhookSecretMatches } from "./webhook-secret";

/** One request the relay forwarded to the desktop. `secret` is the value from
 *  the inbound URL — re-verified here, never trusted from the relay. */
export type WebhookRelayInbound = {
	routeId: string;
	secret: string;
	method: string;
	headers: Record<string, string>;
	bodyText: string;
};

/** The connection to the relay. A production adapter is a WebSocket to the
 *  vault's relay; a test supplies a fake. `setRoutes` tells the relay which
 *  routeIds this vault serves so it forwards only those. */
export type WebhookRelayTransport = {
	setRoutes(routeIds: readonly string[]): void;
	onInbound(cb: (msg: WebhookRelayInbound) => void): () => void;
	close(): void;
};

export type WebhookRelayPort = WebhookIngressPort & { close(): void };

/**
 * Build the relay ingress port over a supplied transport. Implements the same
 * `WebhookIngressPort` the loopback listener does, so the host consumes both
 * uniformly (via `fanInWebhookPorts`).
 */
export function createWebhookRelayPort(transport: WebhookRelayTransport): WebhookRelayPort {
	const routes = new Map<string, WebhookTrigger>();
	const listeners = new Set<(hit: WebhookHit) => void>();

	const unsubscribeTransport = transport.onInbound((msg) => {
		const route = routes.get(msg.routeId);
		// Re-verify against the registered route — the relay is not trusted to
		// have authenticated. Unknown route or bad secret ⇒ drop silently.
		if (!route || !webhookSecretMatches(msg.secret, route.secret)) return;
		const hit: WebhookHit = {
			workflowId: route.workflowId,
			routeId: route.routeId,
			method: msg.method,
			headers: msg.headers,
			bodyText: msg.bodyText,
		};
		for (const listener of listeners) listener(hit);
	});

	return {
		register(next: readonly WebhookTrigger[]): void {
			routes.clear();
			for (const route of next) routes.set(route.routeId, route);
			transport.setRoutes([...routes.keys()]);
		},
		subscribe(listener: (hit: WebhookHit) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close(): void {
			unsubscribeTransport();
			listeners.clear();
			routes.clear();
			transport.close();
		},
	};
}
