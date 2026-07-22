/**
 * 11b.8 — compose several `WebhookIngressPort`s (the loopback listener + the
 * relay client) behind ONE port the `AutomationsHost` consumes. `register`
 * fans out to every plane; `subscribe` fans in every plane's hits. Either
 * plane can be absent (loopback-only, or relay-only under a headless host).
 */

import type { WebhookHit, WebhookIngressPort, WebhookTrigger } from "./automations-host";

export function fanInWebhookPorts(ports: readonly WebhookIngressPort[]): WebhookIngressPort {
	return {
		register(routes: readonly WebhookTrigger[]): void {
			for (const port of ports) port.register(routes);
		},
		subscribe(listener: (hit: WebhookHit) => void): () => void {
			const unsubs = ports.map((port) => port.subscribe(listener));
			return () => {
				for (const unsub of unsubs) unsub();
			};
		},
	};
}
