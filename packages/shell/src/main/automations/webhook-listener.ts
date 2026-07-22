/**
 * 11b.8 — the loopback webhook ingress plane. A long-lived `127.0.0.1`-only
 * HTTP listener (the durable sibling of Connector-2's single-shot
 * `startLoopbackRedirect`) that path-routes `POST /wh/<routeId>/<secret>` to a
 * registered webhook trigger and hands each authenticated request to the
 * `AutomationsHost` as a `WebhookHit`.
 *
 * OQ-163 → (a): ONE listener, per-workflow path + rotating secret.
 *
 * Hardening:
 *   - Binds `127.0.0.1` only (never `0.0.0.0`) — reachable only from this
 *     machine; external reach is via the relay plane, never this socket.
 *   - Unauthenticated requests (unknown route OR wrong secret) all get an
 *     identical `404` — no route-existence or secret oracle. The secret is
 *     compared constant-time (`webhookSecretMatches`).
 *   - Body capped at `WEBHOOK_MAX_BODY_BYTES`; over-cap → `413` and the
 *     connection is destroyed (no unbounded buffering).
 *   - Only `POST` is accepted (post-auth `405`), matching webhook conventions.
 *   - The emitted `WebhookHit` never carries the secret.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { WebhookHit, WebhookIngressPort, WebhookTrigger } from "./automations-host";
import { webhookSecretMatches } from "./webhook-secret";

/** Inbound body cap — mirrors the block-frame 256 KiB posture. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

const LOOPBACK_HOST = "127.0.0.1";
/** `/wh/<routeId>/<secret>` — both segments are non-empty, non-slash. */
const PATH_RE = /^\/wh\/([^/]+)\/([^/]+)\/?$/;

export type WebhookLoopbackListener = WebhookIngressPort & {
	/** The bound loopback port once listening, else `null`. */
	port(): number | null;
	/** Resolves with the bound port (or rejects if the bind fails). */
	whenReady(): Promise<number>;
	/** Tear the listener down (idempotent). */
	close(): Promise<void>;
};

export type WebhookLoopbackOptions = {
	/** A previously-bound port to reuse so the endpoint URL stays stable across
	 *  restarts; falls back to an OS-assigned port if it's taken. */
	preferredPort?: number;
};

function flattenHeaders(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (typeof value === "string") out[key] = value;
		else if (Array.isArray(value)) out[key] = value.join(", ");
	}
	return out;
}

/** Read the body with a hard cap; resolves `null` if the cap is exceeded. */
function readCappedBody(req: IncomingMessage): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let capped = false;
		req.on("data", (chunk: Buffer) => {
			if (capped) return;
			size += chunk.length;
			if (size > WEBHOOK_MAX_BODY_BYTES) {
				capped = true;
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", () => {
			if (!capped) resolve(null);
		});
	});
}

/**
 * Start the loopback webhook listener. Resolves once bound so the caller can
 * read `port()`; a bind failure rejects `whenReady()` but never throws
 * synchronously (the host stays usable without ingress).
 */
export function createWebhookLoopbackListener(
	options: WebhookLoopbackOptions = {},
): WebhookLoopbackListener {
	const routes = new Map<string, WebhookTrigger>();
	const listeners = new Set<(hit: WebhookHit) => void>();
	let boundPort: number | null = null;

	const emit = (hit: WebhookHit): void => {
		for (const listener of listeners) listener(hit);
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const parsed = PATH_RE.exec(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
		const route = parsed ? routes.get(parsed[1] as string) : undefined;
		// Auth first — an unknown route and a wrong secret are indistinguishable.
		if (!parsed || !route || !webhookSecretMatches(parsed[2] as string, route.secret)) {
			res.statusCode = 404;
			res.end();
			return;
		}
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("allow", "POST");
			res.end();
			return;
		}
		const body = await readCappedBody(req);
		if (body === null) {
			res.statusCode = 413;
			res.end();
			req.destroy();
			return;
		}
		res.statusCode = 202;
		res.end();
		emit({
			workflowId: route.workflowId,
			routeId: route.routeId,
			method: "POST",
			headers: flattenHeaders(req),
			bodyText: body,
		});
	};

	const server: Server = createServer((req, res) => {
		void handle(req, res).catch(() => {
			if (!res.headersSent) {
				res.statusCode = 500;
				res.end();
			}
		});
	});

	const ready = new Promise<number>((resolve, reject) => {
		let falledBack = false;
		const onListening = (): void => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("webhook listener: failed to bind loopback port"));
				return;
			}
			boundPort = address.port;
			resolve(address.port);
		};
		server.on("error", (err: NodeJS.ErrnoException) => {
			// Preferred port taken → fall back to an OS-assigned one (once).
			if (err.code === "EADDRINUSE" && options.preferredPort && !falledBack) {
				falledBack = true;
				server.listen(0, LOOPBACK_HOST, onListening);
				return;
			}
			reject(err);
		});
		server.listen(options.preferredPort ?? 0, LOOPBACK_HOST, onListening);
	});
	// Don't crash the process on a late bind rejection nobody awaited.
	ready.catch(() => {});

	return {
		register(next: readonly WebhookTrigger[]): void {
			routes.clear();
			for (const route of next) routes.set(route.routeId, route);
		},
		subscribe(listener: (hit: WebhookHit) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		port: () => boundPort,
		whenReady: () => ready,
		close: () =>
			new Promise<void>((resolve) => {
				listeners.clear();
				routes.clear();
				server.close(() => resolve());
			}),
	};
}
