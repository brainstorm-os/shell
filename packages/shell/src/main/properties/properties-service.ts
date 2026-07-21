/**
 * Broker service handler for `properties` (VP-3).
 *
 * Bridges envelopes coming through the IPC broker to the vault-level
 * `PropertiesStore`. Methods:
 *
 *   - list()                                → PropertiesSnapshot
 *   - getProperty({ key })                  → PropertyDef | null
 *   - setProperty({ def })                  → void
 *   - removeProperty({ key })               → void
 *   - getDictionary({ id })                 → Dictionary | null
 *   - setDictionary({ dict })               → void
 *   - removeDictionary({ id })              → void
 *
 * Authoritative validation lives in `PropertiesStore.setProperty` /
 * `setDictionary` — this handler is responsible for shape-checking the
 * IPC envelope before passing through, and translating store-throws
 * into structured `Invalid` errors. If no vault session is active the
 * handler throws `Unavailable` (same pattern as `intents-service`).
 *
 * Capability gating happens in the broker via the envelope's `caps`
 * field; the SDK proxy declares `properties.read` for reads and
 * `properties.write` for writes (see `propertiesProxy` in
 * `packages/sdk/src/runtime.ts`). Both caps are default-minimum grants
 * applied at app-install time so the catalog is reachable without a
 * prompt.
 */

import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { PropertiesStore } from "./properties-store";

export type PropertiesServiceOptions = {
	/** Resolve the active vault's `PropertiesStore`. Returns null when no
	 *  vault session is open — the handler maps that to `Unavailable`. */
	getStore: () => Promise<PropertiesStore | null>;
};

export function makePropertiesServiceHandler(options: PropertiesServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		const store = await options.getStore();
		if (!store) {
			throw makeError("Unavailable", "properties store is not available (no active vault session)");
		}

		switch (envelope.method) {
			case "list":
				return store.snapshot();

			case "getProperty": {
				const { key } = requireKey(envelope);
				const snap = store.snapshot();
				return snap.properties[key] ?? null;
			}

			case "setProperty": {
				const def = requireDef(envelope);
				try {
					store.setProperty(def);
				} catch (error) {
					throw makeError("Invalid", (error as Error).message);
				}
				return undefined;
			}

			case "removeProperty": {
				const { key } = requireKey(envelope);
				store.removeProperty(key);
				return undefined;
			}

			case "getDictionary": {
				const { id } = requireId(envelope);
				const snap = store.snapshot();
				return snap.dictionaries[id] ?? null;
			}

			case "setDictionary": {
				const dict = requireDict(envelope);
				try {
					store.setDictionary(dict);
				} catch (error) {
					throw makeError("Invalid", (error as Error).message);
				}
				return undefined;
			}

			case "removeDictionary": {
				const { id } = requireId(envelope);
				store.removeDictionary(id);
				return undefined;
			}

			default:
				throw makeError("Invalid", `unknown properties method: ${envelope.method}`);
		}
	};
}

function makeError(kind: "Unavailable" | "Invalid", message: string): Error {
	const err = new Error(message);
	err.name = kind;
	return err;
}

function firstArg(envelope: Envelope): Record<string, unknown> {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", "properties handler: argument must be an object");
	}
	return arg as Record<string, unknown>;
}

function requireKey(envelope: Envelope): { key: string } {
	const a = firstArg(envelope);
	if (typeof a.key !== "string" || a.key.length === 0) {
		throw makeError("Invalid", "properties handler: { key } must be a non-empty string");
	}
	return { key: a.key };
}

function requireId(envelope: Envelope): { id: string } {
	const a = firstArg(envelope);
	if (typeof a.id !== "string" || a.id.length === 0) {
		throw makeError("Invalid", "properties handler: { id } must be a non-empty string");
	}
	return { id: a.id };
}

function requireDef(envelope: Envelope): PropertyDef {
	const a = firstArg(envelope);
	if (!a.def || typeof a.def !== "object") {
		throw makeError("Invalid", "properties handler: { def } must be a PropertyDef object");
	}
	return a.def as PropertyDef;
}

function requireDict(envelope: Envelope): Dictionary {
	const a = firstArg(envelope);
	if (!a.dict || typeof a.dict !== "object") {
		throw makeError("Invalid", "properties handler: { dict } must be a Dictionary object");
	}
	return a.dict as Dictionary;
}
