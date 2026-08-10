/**
 * The IPC broker — main-process router that accepts envelopes and dispatches
 * to the right service (worker process or in-process handler).
 *
 * Per §IPC architecture, the broker:
 *   1. Validates the envelope structure.
 *   2. Verifies `app` matches the originating renderer (preload-stamped).
 *   3. Resolves the target service to a worker (MessagePort).
 *   4. Checks the required capabilities for `<service>.<method>`.
 *   5. Forwards to the worker; proxies the reply.
 *
 * Stage 4 wires steps 2 + 4:
 *   - `verifyAppIdentity` reads the renderer-identity registry (see
 *     `renderer-identity.ts`) and compares to the envelope's claimed `app`.
 *   - `checkCapability` consults the capability ledger; any declared cap
 *     in the envelope must be a live grant for the calling app.
 *   - **Fail-closed**: if the capability check *throws* (e.g. the ledger
 *     DB is corrupt or locked), the broker returns `Unavailable` — never
 *  "approved by default". This matches §Failure-open vs fail-closed.
 *
 * Stage 4 also wires per-app **backpressure** per §Backpressure:
 *   - Each app has a fixed-depth pending queue (`maxPendingPerApp`).
 *   - When the queue is full, the oldest non-streaming request is dropped
 *     and rejected with `Unavailable`. The new request proceeds.
 *   - This caps the blast radius of a misbehaving app — it cannot DoS the
 *     broker by flooding IPC.
 *
 * Stage 4 also exposes a `onDenied` callback so the main process can wire
 * audit-log writes for denied calls without coupling the broker to the
 * vault session.
 */

import {
	type Envelope,
	type EnvelopeReply,
	makeErrorReply,
	makeOkReply,
	validateEnvelope,
} from "./envelope";

export type ServiceHandler = (envelope: Envelope) => Promise<unknown> | unknown;

export type ServiceRegistry = Map<string, ServiceHandler>;

export type AppIdentityVerifier = (claimedApp: string, source: unknown) => boolean;

export type CapabilityChecker = (
	app: string,
	service: string,
	method: string,
	declaredCaps: readonly string[],
) => boolean;

export type DenialReason =
	| "Invalid" // bad envelope shape, identity verification failed
	| "CapabilityDenied"
	| "Unavailable" // no handler, ledger error (fail-closed), backpressure-drop
	| "Error"; // handler threw

export type DenialEvent = {
	kind: DenialReason;
	app: string;
	service: string;
	method: string;
	msg: string;
	reason: string;
};

/** Post-dispatch outcome handed to the observer (Agent-12a trace hook). */
export type DispatchOutcome = {
	ok: boolean;
	/** The reply's error kind when `ok` is false (`CapabilityDenied`, a
	 *  handler's thrown `error.name`, …). Never the error message — an
	 *  observer that wants no payload bytes gets none. */
	errorKind?: string;
	durationMs: number;
};

/**
 * Fired once per dispatched envelope AFTER identity verification succeeded
 * (an unverifiable claimant must not be able to attribute activity to the
 * app id it claimed). Receives the validated envelope itself — observers are
 * main-process shell code (the agent-trace hook); nothing here crosses IPC.
 * A throwing observer is contained and never affects the reply.
 */
export type DispatchObserver = (envelope: Envelope, outcome: DispatchOutcome) => void;

export type BrokerOptions = {
	services: ServiceRegistry;
	verifyAppIdentity?: AppIdentityVerifier;
	checkCapability?: CapabilityChecker;
	/**
	 * Max in-flight requests per app id. When exceeded, the oldest non-stream
	 * request is dropped and the new one proceeds. Default 256 (per).
	 */
	maxPendingPerApp?: number;
	/** Called on every denial (Invalid, CapabilityDenied, Unavailable, Error). */
	onDenied?: (event: DenialEvent) => void;
	/** Called after every identity-verified dispatch (see `DispatchObserver`). */
	onDispatched?: DispatchObserver;
};

const DEFAULT_MAX_PENDING = 256;

const ALWAYS_TRUE: AppIdentityVerifier & CapabilityChecker = () => true;

type Pending = {
	abort: () => void;
};

export class Broker {
	private readonly services: ServiceRegistry;
	private readonly verifyAppIdentity: AppIdentityVerifier;
	private readonly checkCapability: CapabilityChecker;
	private readonly maxPendingPerApp: number;
	private readonly onDenied?: (event: DenialEvent) => void;
	private onDispatched: DispatchObserver | undefined;
	private readonly pendingByApp = new Map<string, Pending[]>();

	constructor(options: BrokerOptions) {
		this.services = options.services;
		this.verifyAppIdentity = options.verifyAppIdentity ?? ALWAYS_TRUE;
		this.checkCapability = options.checkCapability ?? ALWAYS_TRUE;
		this.maxPendingPerApp = options.maxPendingPerApp ?? DEFAULT_MAX_PENDING;
		if (options.onDenied !== undefined) this.onDenied = options.onDenied;
		if (options.onDispatched !== undefined) this.onDispatched = options.onDispatched;
	}

	/** Late-bind the dispatch observer (the broker is constructed in
	 *  `startWorkers` before the vault-dependent trace recorder exists). */
	setDispatchObserver(observer: DispatchObserver | undefined): void {
		this.onDispatched = observer;
	}

	private observe(envelope: Envelope, outcome: DispatchOutcome): void {
		if (!this.onDispatched) return;
		try {
			this.onDispatched(envelope, outcome);
		} catch {
			// An observer failure must never affect the reply (fail-soft).
		}
	}

	registerService(name: string, handler: ServiceHandler): void {
		this.services.set(name, handler);
	}

	/** Read the currently-registered handler for a service. Callers can use
	 *  this to compose middleware (e.g. wrap a worker-bridged handler with a
	 *  post-success side-effect) without coupling to how the inner handler
	 *  was built. Returns `undefined` if no handler is registered. */
	getServiceHandler(name: string): ServiceHandler | undefined {
		return this.services.get(name);
	}

	unregisterService(name: string): void {
		this.services.delete(name);
	}

	/**
	 * Dispatch a raw envelope. `source` is opaque caller-identity (a
	 * WebContents id in production; anything in tests). Always resolves;
	 * never throws — errors are encoded as `EnvelopeReplyError`.
	 */
	async dispatch(raw: unknown, source: unknown): Promise<EnvelopeReply> {
		const validation = validateEnvelope(raw);
		if (!validation.ok) {
			const reply = makeErrorReply(messageIdOrFallback(raw), {
				kind: "Invalid",
				message: validation.reason,
			});
			this.emit("Invalid", reply, "<unknown>", "<unknown>", "<unknown>");
			return reply;
		}
		const envelope = validation.envelope;

		if (!this.verifyAppIdentity(envelope.app, source)) {
			const reply = makeErrorReply(envelope.msg, {
				kind: "Invalid",
				message: "app identity verification failed",
				app: envelope.app,
			});
			this.emit("Invalid", reply, envelope.app, envelope.service, envelope.method);
			return reply;
		}

		const dispatchStart = Date.now();
		let capOk: boolean;
		try {
			capOk = this.checkCapability(envelope.app, envelope.service, envelope.method, envelope.caps);
		} catch (error) {
			// Fail-closed per : ledger errors become Unavailable, not approved.
			const reply = makeErrorReply(envelope.msg, {
				kind: "Unavailable",
				message: `capability ledger unavailable: ${(error as Error).message}`,
				service: envelope.service,
				method: envelope.method,
			});
			this.emit("Unavailable", reply, envelope.app, envelope.service, envelope.method);
			this.observe(envelope, { ok: false, errorKind: "Unavailable", durationMs: 0 });
			return reply;
		}
		if (!capOk) {
			const reply = makeErrorReply(envelope.msg, {
				kind: "CapabilityDenied",
				message: `${envelope.app} lacks capability for ${envelope.service}.${envelope.method}`,
				service: envelope.service,
				method: envelope.method,
			});
			this.emit("CapabilityDenied", reply, envelope.app, envelope.service, envelope.method);
			this.observe(envelope, { ok: false, errorKind: "CapabilityDenied", durationMs: 0 });
			return reply;
		}

		const handler = this.services.get(envelope.service);
		if (!handler) {
			const reply = makeErrorReply(envelope.msg, {
				kind: "Unavailable",
				message: `service not registered: ${envelope.service}`,
				service: envelope.service,
			});
			this.emit("Unavailable", reply, envelope.app, envelope.service, envelope.method);
			return reply;
		}

		// Per-app backpressure: enroll this request in the app's pending queue
		// and shed the oldest if we're at capacity.
		let aborted = false;
		const slot: Pending = {
			abort: () => {
				aborted = true;
			},
		};
		this.enroll(envelope.app, slot);

		try {
			const value = await handler(envelope);
			if (aborted) {
				const reply = makeErrorReply(envelope.msg, {
					kind: "Unavailable",
					message: "request dropped due to per-app backpressure",
					service: envelope.service,
					method: envelope.method,
				});
				this.emit("Unavailable", reply, envelope.app, envelope.service, envelope.method);
				return reply;
			}
			this.observe(envelope, { ok: true, durationMs: Date.now() - dispatchStart });
			return makeOkReply(envelope.msg, value);
		} catch (error) {
			const payload = errorPayload(error);
			const reply = makeErrorReply(envelope.msg, payload);
			this.emit(payload.kind, reply, envelope.app, envelope.service, envelope.method);
			this.observe(envelope, {
				ok: false,
				errorKind: payload.kind,
				durationMs: Date.now() - dispatchStart,
			});
			return reply;
		} finally {
			this.retire(envelope.app, slot);
		}
	}

	private enroll(app: string, slot: Pending): void {
		let queue = this.pendingByApp.get(app);
		if (!queue) {
			queue = [];
			this.pendingByApp.set(app, queue);
		}
		queue.push(slot);
		while (queue.length > this.maxPendingPerApp) {
			const oldest = queue.shift();
			if (oldest) oldest.abort();
		}
	}

	private retire(app: string, slot: Pending): void {
		const queue = this.pendingByApp.get(app);
		if (!queue) return;
		const i = queue.indexOf(slot);
		if (i >= 0) queue.splice(i, 1);
		if (queue.length === 0) this.pendingByApp.delete(app);
	}

	private emit(
		kind: string,
		reply: EnvelopeReply,
		app: string,
		service: string,
		method: string,
	): void {
		if (!this.onDenied) return;
		if (reply.ok) return;
		this.onDenied({
			kind: kind as DenialReason,
			app,
			service,
			method,
			msg: reply.msg,
			reason: reply.error.message,
		});
	}
}

function messageIdOrFallback(raw: unknown): string {
	if (raw && typeof raw === "object") {
		const m = (raw as { msg?: unknown }).msg;
		if (typeof m === "string" && m.length > 0 && m.length <= 128) return m;
	}
	return "unknown";
}

function errorPayload(error: unknown): { kind: string; message: string } {
	if (error instanceof Error) {
		return { kind: error.name || "Error", message: error.message };
	}
	return { kind: "Error", message: String(error) };
}
