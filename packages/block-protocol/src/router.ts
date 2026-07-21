/**
 * BP message router — Stage 9.3.3.1.
 *
 * The shell-side router receives a raw BP message payload (forwarded
 * through the broker `bp.dispatch` service by a host-app's bridge,
 * which itself received it via the 9.5.2 `<BpBlockMount>` transport
 * `onMessage` callback) and dispatches by `module` + `messageName`
 * to a per-module handler.
 *
 * .1 ships the dispatch shell, the BP-envelope validation, and the
 * fail-closed `NOT_IMPLEMENTED` default. Every module handler is a
 * stub — Graph wiring is .2; Hook is .3. The router is exhaustive in
 * the sense that any input either resolves to a properly-shaped BP
 * response envelope or returns `null` (the latter only when the input
 * isn't a dispatchable request — e.g. it's a *Response from a misbehaving
 * block, or it's structurally malformed; per BP spec the embedder may
 * silently drop a malformed request).
 *
 * Response shape (per `@blockprotocol/core` `Message`):
 *   - `requestId` is the request's `requestId` (the block correlates
 *     by it; the response messageName alone is not unique).
 *   - `messageName` is the request name with `Response` suffixed.
 *   - `module` echoes the request module.
 *   - `source` is `"embedder"`.
 *   - `timestamp` is the host's clock.
 *   - `data` / `errors` populated by the handler.
 *
 * Capability enforcement does NOT live here — the per-module handlers
 * map each message onto an existing host service (`entities`, `files`),
 * which is the per-type capability authority. The router is structural
 * routing only; it has no ambient grant.
 *
 * Defense-in-depth: any throw from a handler is converted to an
 * `INTERNAL_ERROR` response (with no payload bleed — the message field
 * is a generic string, not the thrown error's message, since a handler
 * exception may leak vault-internal information). The router itself
 * never throws.
 */

import { type BpEnvelope, BpErrorCode, BpModule, BpSource } from "./envelope";

/** Context every module handler receives — the dispatching app id (from
 *  the broker envelope, preload-stamped) + the embedding entity id (from
 *  `<BpBlockMount>`, channel-id-isolated). 9.3.3.2/.3 handlers consult
 *  the ledger via the existing services; this struct is the call-frame. */
export interface BpRouterContext {
	readonly app: string;
	readonly entityId: string;
}

/** A module handler returns the `data` / `errors` half of the response
 *  envelope; the router synthesises the surrounding `Message`. Returning
 *  `null` signals "do not respond" (used when the payload is structurally
 *  malformed even by module standards). */
export type BpModuleResponse = {
	data?: unknown;
	errors?: ReadonlyArray<{ code: string; message: string }>;
} | null;

export type BpModuleHandler = (
	request: BpEnvelope,
	context: BpRouterContext,
) => Promise<BpModuleResponse> | BpModuleResponse;

export interface BpRouterOptions {
	/** Stage 9.3.3.2 wires this to the entities + files services. */
	readonly graph?: BpModuleHandler;
	/** Stage 9.3.3.3 wires this to the host-painted overlay. */
	readonly hook?: BpModuleHandler;
	/** Injection for deterministic tests. */
	readonly now?: () => number;
}

export type BpRouter = (
	context: BpRouterContext,
	rawPayload: unknown,
) => Promise<BpEnvelope | null>;

const NOT_IMPLEMENTED_RESPONSE: BpModuleResponse = {
	errors: [
		{
			code: BpErrorCode.NotImplemented,
			message: "Module handler not wired (Stage 9.3.3.1 stub)",
		},
	],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Structural validation of an inbound BP message. Returns the typed
 *  contents or `null` for any malformed input. Defense-in-depth: every
 *  field we route on is checked here, so handlers can trust their args. */
function parseRequest(raw: unknown): BpEnvelope | null {
	if (!isRecord(raw)) return null;
	const messageName = raw.messageName;
	if (typeof messageName !== "string" || messageName === "") return null;
	// A request must have a `requestId` per the BP protocol — we'll
	// reflect it on the response so the block can correlate.
	if (typeof raw.requestId !== "string" || raw.requestId === "") return null;
	// Reject responses-routed-as-requests (a misbehaving or hostile
	// block could try to push a *Response envelope to confuse a future
	// stateful router). v1 router is stateless so this is belt-and-braces.
	if (raw.source !== undefined && raw.source !== BpSource.Block) return null;
	// `module` is optional in the protocol envelope (only the messageName
	// is load-bearing), but every BP module declares its name; we use it
	// for routing. If absent, refuse to dispatch.
	if (typeof raw.module !== "string" || raw.module === "") return null;
	const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
	return {
		requestId: raw.requestId,
		messageName,
		module: raw.module,
		source: BpSource.Block,
		timestamp,
		// Module handlers need the request body. Reflect it through as
		// `unknown`; each handler does its own structural validation.
		...(raw.data !== undefined ? { data: raw.data } : {}),
	};
}

function knownModule(name: string): BpModule | null {
	if (name === BpModule.Graph) return BpModule.Graph;
	if (name === BpModule.Hook) return BpModule.Hook;
	return null;
}

export function makeBpRouter(options: BpRouterOptions = {}): BpRouter {
	const clock = options.now ?? (() => Date.now());

	return async (context, rawPayload) => {
		const request = parseRequest(rawPayload);
		if (!request) return null;

		const module = knownModule(request.module);

		let result: BpModuleResponse;
		if (module === null) {
			result = {
				errors: [
					{
						code: BpErrorCode.NotImplemented,
						message: `Unknown BP module: ${request.module}`,
					},
				],
			};
		} else {
			const handler = module === BpModule.Graph ? options.graph : options.hook;
			if (!handler) {
				result = NOT_IMPLEMENTED_RESPONSE;
			} else {
				try {
					result = await handler(request, context);
				} catch {
					result = {
						errors: [
							{
								code: BpErrorCode.InternalError,
								message: "Internal handler error",
							},
						],
					};
				}
			}
		}
		if (result === null) return null;

		const response: BpEnvelope = {
			requestId: request.requestId,
			messageName: `${request.messageName}Response`,
			module: request.module,
			source: BpSource.Embedder,
			timestamp: new Date(clock()).toISOString(),
			...(result.data !== undefined ? { data: result.data } : {}),
			...(result.errors && result.errors.length > 0 ? { errors: result.errors } : {}),
		};
		return response;
	};
}
