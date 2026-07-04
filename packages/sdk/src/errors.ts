/**
 * Structured errors thrown by the SDK when an envelope reply comes back as
 * `EnvelopeReplyError`. Per §Errors:
 *
 *   - `CapabilityDenied { capability }` — try `capabilities.request`.
 *   - `NotFound { kind, id }`           — entity, file, etc.
 *   - `Conflict { reason }`             — rare; non-CRDT operations.
 *   - `Unavailable { service, reason }` — service offline.
 *   - `Invalid { reason }`              — malformed input.
 *
 * The broker uses these `kind` strings on the wire; this module reconstructs
 * the matching class on receipt so app code can `instanceof CapabilityDenied`
 * cleanly.
 */

export type ErrorDetail = Record<string, unknown>;

abstract class BrainstormSdkError extends Error {
	readonly detail: ErrorDetail;
	constructor(name: string, message: string, detail: ErrorDetail = {}) {
		super(message);
		this.name = name;
		this.detail = detail;
	}
}

export class CapabilityDenied extends BrainstormSdkError {
	readonly capability?: string;
	constructor(message: string, detail: ErrorDetail = {}) {
		super("CapabilityDenied", message, detail);
		if (typeof detail.capability === "string") this.capability = detail.capability;
	}
}

export class NotFound extends BrainstormSdkError {
	readonly kind?: string;
	readonly id?: string;
	constructor(message: string, detail: ErrorDetail = {}) {
		super("NotFound", message, detail);
		if (typeof detail.kind === "string") this.kind = detail.kind;
		if (typeof detail.id === "string") this.id = detail.id;
	}
}

export class Conflict extends BrainstormSdkError {
	readonly reason?: string;
	constructor(message: string, detail: ErrorDetail = {}) {
		super("Conflict", message, detail);
		if (typeof detail.reason === "string") this.reason = detail.reason;
	}
}

export class Unavailable extends BrainstormSdkError {
	readonly service?: string;
	constructor(message: string, detail: ErrorDetail = {}) {
		super("Unavailable", message, detail);
		if (typeof detail.service === "string") this.service = detail.service;
	}
}

export class Invalid extends BrainstormSdkError {
	readonly reason?: string;
	constructor(message: string, detail: ErrorDetail = {}) {
		super("Invalid", message, detail);
		if (typeof detail.reason === "string") this.reason = detail.reason;
	}
}

/** 14.8 — the calling app's rolling 30-day AI budget is exhausted (Settings →
 *  AI). Distinct from `Unavailable` so apps can surface "AI budget exhausted"
 *  instead of a generic failure; the budget resets as usage rolls out of the
 *  window or when the user raises/clears it. */
export class AiBudgetExhausted extends BrainstormSdkError {
	constructor(message: string, detail: ErrorDetail = {}) {
		super("AiBudgetExhausted", message, detail);
	}
}

/**
 * Reconstruct the right error subclass from a wire reply's `error` payload.
 * Unknown `kind` values fall through to a generic Error so callers always
 * get something throwable.
 */
export function makeSdkError(kind: string, message: string, detail: ErrorDetail = {}): Error {
	switch (kind) {
		case "CapabilityDenied":
			return new CapabilityDenied(message, detail);
		case "NotFound":
			return new NotFound(message, detail);
		case "Conflict":
			return new Conflict(message, detail);
		case "Unavailable":
			return new Unavailable(message, detail);
		case "Invalid":
			return new Invalid(message, detail);
		case "AiBudgetExhausted":
			return new AiBudgetExhausted(message, detail);
		default: {
			const err = new Error(message);
			err.name = kind || "Error";
			return err;
		}
	}
}
