/**
 * Broker service handler for `intents`. Bridges envelopes coming through the
 * IPC broker to the per-session IntentsBus.
 *
 * Methods:
 *   - `dispatch(envelope: IntentEnvelope)` → IntentDispatchResult
 *   - `suggest(envelope: IntentEnvelope)`  → SuggestedHandler[]
 */

import type { ContributedActionTarget, ContributedVerb } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { IntentEnvelope, IntentsBus } from "./intents-bus";

export type IntentsServiceOptions = {
	getBus: () => Promise<IntentsBus | null>;
};

export function makeIntentsServiceHandler(options: IntentsServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		const bus = await options.getBus();
		if (!bus) {
			const err = new Error("intents bus is not available (no active vault session)");
			err.name = "Unavailable";
			throw err;
		}

		// The action-surface suggest is a distinct argument shape ({ target,
		// verbs }), so validate + route it before the (verb, payload) envelope
		// methods below.
		if (envelope.method === "suggestActions") {
			const [arg] = envelope.args as [unknown];
			const input = validateSuggestActions(arg);
			return await bus.suggestActions(input, { app: envelope.app });
		}

		const [arg] = envelope.args as [unknown];
		const intent = validateIntent(arg);

		switch (envelope.method) {
			case "dispatch":
				return await bus.dispatch(intent, { app: envelope.app });
			case "suggest":
				return await bus.suggest(intent);
			default: {
				const err = new Error(`unknown intents method: ${envelope.method}`);
				err.name = "Invalid";
				throw err;
			}
		}
	};
}

/** Validate the `suggestActions({ target, verbs })` argument. Tolerant of
 *  extra payload keys but pins the two it reads. Fail-closed: a malformed
 *  argument is an `Invalid` error, never a silent empty result. */
function validateSuggestActions(value: unknown): {
	target: ContributedActionTarget;
	verbs: ContributedVerb[];
} {
	if (!value || typeof value !== "object") {
		const err = new Error("suggestActions input must be an object");
		err.name = "Invalid";
		throw err;
	}
	const v = value as Record<string, unknown>;
	if (!v.target || typeof v.target !== "object") {
		const err = new Error("suggestActions.target must be an object");
		err.name = "Invalid";
		throw err;
	}
	if (!Array.isArray(v.verbs)) {
		const err = new Error("suggestActions.verbs must be an array");
		err.name = "Invalid";
		throw err;
	}
	const t = v.target as Record<string, unknown>;
	const target: ContributedActionTarget = {};
	if (typeof t.entityId === "string") target.entityId = t.entityId;
	if (typeof t.entityType === "string") target.entityType = t.entityType;
	if (typeof t.mime === "string") target.mime = t.mime;
	if (typeof t.format === "string") target.format = t.format;
	const verbs = v.verbs.filter(
		(x): x is ContributedVerb => typeof x === "string",
	) as ContributedVerb[];
	return { target, verbs };
}

function validateIntent(value: unknown): IntentEnvelope {
	if (!value || typeof value !== "object") {
		const err = new Error("intent envelope must be an object");
		err.name = "Invalid";
		throw err;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.verb !== "string" || v.verb.length === 0) {
		const err = new Error("intent.verb must be a non-empty string");
		err.name = "Invalid";
		throw err;
	}
	if (!v.payload || typeof v.payload !== "object" || Array.isArray(v.payload)) {
		const err = new Error("intent.payload must be an object");
		err.name = "Invalid";
		throw err;
	}
	return { verb: v.verb, payload: v.payload as Record<string, unknown> };
}
