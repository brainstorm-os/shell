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
 * Two-way relations (9.12.25): `properties.write` is a default grant, but a
 * pair makes EVERY app's writes fan out onto far ends. So changing a def's
 * `inverseOf` (declaring, re-targeting or clearing it) requires
 * `entities.write` for every target type of each side touched — the def, its
 * new partner and its old one (`allowedTypes`; a side with none needs
 * `entities.write:*`). A pair is then something the declarer could have
 * written by hand anyway. Re-shaping a def that is ALREADY half of a pair
 * (its `allowedTypes`, `valueType` or `count`), creating the def a partner
 * already names, or removing half of a pair passes the same gate over the old
 * and new shape — a partner not in the catalog counts as any type — or an app
 * could narrow `allowedTypes` onto a type it holds, then declare the pair. The entities service also refuses far
 * ends outside the declared types, so the catalog bounds the far writes.
 * Reserved keys are never pair members. The gate closes over the whole pair
 * component — every def reachable through `inverseOf` in either direction —
 * because a third def naming one half of a pair steers writes onto the
 * other half's types too. Catalog mutations are serialised per store, so a
 * gate check and the write it guards are atomic against other callers: two
 * interleaved calls could otherwise each pass against a catalog missing the
 * other's def.
 *
 * Capability gating happens in the broker via the envelope's `caps`
 * field; the SDK proxy declares `properties.read` for reads and
 * `properties.write` for writes (see `propertiesProxy` in
 * `packages/sdk/src/runtime.ts`). Both caps are default-minimum grants
 * applied at app-install time so the catalog is reachable without a
 * prompt.
 */

import { validatePropertyDef } from "@brainstorm-os/sdk";
import {
	type Dictionary,
	type PropertyDef,
	RESERVED_PROPERTY_KEYS,
} from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { PropertiesStore } from "./properties-store";

export type PropertiesServiceOptions = {
	/** Resolve the active vault's `PropertiesStore`. Returns null when no
	 *  vault session is open — the handler maps that to `Unavailable`. */
	getStore: () => Promise<PropertiesStore | null>;
	/** 9.12.25 — when a def newly declares (or re-targets) `inverseOf`, make
	 *  the existing one-sided references two-sided, acting as the calling app.
	 *  Runs BEFORE the def is saved: a refusal (`Denied` — a far end the app
	 *  can't write, or a locked one) leaves both the catalog and the data
	 *  untouched. */
	backfillInverse?: (app: string, def: PropertyDef) => Promise<number>;
	/** Live ledger check: may `app` write entities of `type` (`"*"` = every
	 *  type)? Absent → no app may change a def's `inverseOf` (fail closed). */
	canWriteType?: (app: string, type: string) => Promise<boolean>;
};

const ANY_TYPE = "*";

export enum PropertiesMethod {
	List = "list",
	GetProperty = "getProperty",
	SetProperty = "setProperty",
	RemoveProperty = "removeProperty",
	GetDictionary = "getDictionary",
	SetDictionary = "setDictionary",
	RemoveDictionary = "removeDictionary",
}

/** Methods that read the catalog to decide what they write. */
const CATALOG_MUTATORS: ReadonlySet<string> = new Set([
	PropertiesMethod.SetProperty,
	PropertiesMethod.RemoveProperty,
]);

/** Keys of every def currently paired WITH `key` from the other side. */
function declaredPartnersOf(key: string, catalog: Readonly<Record<string, PropertyDef>>): string[] {
	return Object.values(catalog)
		.filter((d) => d.key !== key && d.inverseOf === key)
		.map((d) => d.key);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A change to a paired def's shape: what it links, or how it stores refs. */
function reshapesPair(def: PropertyDef, prior: PropertyDef | undefined): boolean {
	if (!prior) return false;
	return (
		def.valueType !== prior.valueType ||
		!sameJson(def.allowedTypes, prior.allowedTypes) ||
		!sameJson(def.count, prior.count)
	);
}

/** Every type a change to the pairing of `key` can steer writes onto: the
 *  def as it is now and as it will be, plus the whole pair component — every
 *  def linked to it through `inverseOf` in either direction, transitively.
 *  A partner not in the catalog yet has no type limits by definition — it
 *  counts as any type, or it could be created later, unrestricted, past the
 *  gate. The walk is bounded by a visited set, so a cycle terminates. */
function pairTargetTypes(
	key: string,
	shapes: ReadonlyArray<PropertyDef | undefined>,
	catalog: Readonly<Record<string, PropertyDef>>,
): Set<string> {
	const types = new Set<string>();
	const visited = new Set<string>([key]);
	const pending: string[] = [];
	const visit = (partnerKey: string | undefined) => {
		if (!partnerKey || visited.has(partnerKey)) return;
		visited.add(partnerKey);
		pending.push(partnerKey);
	};
	const collect = (side: PropertyDef | undefined) => {
		if (!side) return;
		const allowed = side.allowedTypes ?? [];
		if (allowed.length === 0) types.add(ANY_TYPE);
		for (const t of allowed) types.add(t);
		visit(side.inverseOf);
	};
	for (const shape of shapes) collect(shape);
	for (const partnerKey of declaredPartnersOf(key, catalog)) visit(partnerKey);
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const partner = catalog[next];
		if (!partner) {
			types.add(ANY_TYPE);
			continue;
		}
		collect(partner);
		for (const partnerKey of declaredPartnersOf(next, catalog)) visit(partnerKey);
	}
	return types;
}

/** Half of a pair right now: it declares a partner, or a partner declares it. */
function isPaired(key: string, catalog: Readonly<Record<string, PropertyDef>>): boolean {
	return catalog[key]?.inverseOf !== undefined || declaredPartnersOf(key, catalog).length > 0;
}

export function makePropertiesServiceHandler(options: PropertiesServiceOptions): ServiceHandler {
	const assertPairGate = async (app: string, types: ReadonlySet<string>, verb: string) => {
		const canWrite = options.canWriteType;
		for (const type of types) {
			if (!canWrite || !(await canWrite(app, type))) {
				throw makeError(
					"Denied",
					`properties.${verb}: changing a two-way relation needs entities.write for the types it links`,
				);
			}
		}
	};

	// One chain per store: a mutator's catalog read, gate and write run as a
	// unit against every other mutator. Reads never queue.
	const locks = new WeakMap<PropertiesStore, Promise<unknown>>();
	const serialised = <T>(store: PropertiesStore, run: () => Promise<T>): Promise<T> => {
		const prior = locks.get(store) ?? Promise.resolve();
		const next = prior.then(run, run);
		locks.set(
			store,
			next.catch(() => undefined),
		);
		return next;
	};

	const dispatch = async (store: PropertiesStore, envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case PropertiesMethod.List:
				return store.snapshot();

			case PropertiesMethod.GetProperty: {
				const { key } = requireKey(envelope);
				const snap = store.snapshot();
				return snap.properties[key] ?? null;
			}

			case PropertiesMethod.SetProperty: {
				const def = requireDef(envelope);
				// A reserved key is host-owned state, never a catalog property.
				if (
					RESERVED_PROPERTY_KEYS.includes(def.key) ||
					(def.inverseOf !== undefined && RESERVED_PROPERTY_KEYS.includes(def.inverseOf))
				) {
					throw makeError("Invalid", "properties.setProperty: that property key is reserved");
				}
				const catalog = store.snapshot().properties;
				const prior = catalog[def.key];
				const pairChange = def.inverseOf !== prior?.inverseOf;
				// Creating a def some existing def already names as its partner
				// completes that pair, so it is gated like declaring it.
				const reshape = isPaired(def.key, catalog) && (!prior || reshapesPair(def, prior));
				if (pairChange || reshape) {
					await assertPairGate(
						envelope.app,
						pairTargetTypes(def.key, [def, prior], catalog),
						"setProperty",
					);
				}
				if (def.inverseOf && def.inverseOf !== prior?.inverseOf && options.backfillInverse) {
					const validation = validatePropertyDef(def);
					if (!validation.ok) throw makeError("Invalid", validation.errors.join("; "));
					await options.backfillInverse(envelope.app, def);
				}
				try {
					store.setProperty(def);
				} catch (error) {
					throw makeError("Invalid", (error as Error).message);
				}
				return undefined;
			}

			case PropertiesMethod.RemoveProperty: {
				const { key } = requireKey(envelope);
				const catalog = store.snapshot().properties;
				// Removing half of a pair frees its key to be re-added wider.
				if (isPaired(key, catalog)) {
					await assertPairGate(
						envelope.app,
						pairTargetTypes(key, [catalog[key]], catalog),
						"removeProperty",
					);
				}
				store.removeProperty(key);
				return undefined;
			}

			case PropertiesMethod.GetDictionary: {
				const { id } = requireId(envelope);
				const snap = store.snapshot();
				return snap.dictionaries[id] ?? null;
			}

			case PropertiesMethod.SetDictionary: {
				const dict = requireDict(envelope);
				try {
					store.setDictionary(dict);
				} catch (error) {
					throw makeError("Invalid", (error as Error).message);
				}
				return undefined;
			}

			case PropertiesMethod.RemoveDictionary: {
				const { id } = requireId(envelope);
				store.removeDictionary(id);
				return undefined;
			}

			default:
				throw makeError("Invalid", `unknown properties method: ${envelope.method}`);
		}
	};

	return async (envelope: Envelope): Promise<unknown> => {
		const store = await options.getStore();
		if (!store) {
			throw makeError("Unavailable", "properties store is not available (no active vault session)");
		}
		if (CATALOG_MUTATORS.has(envelope.method)) {
			return serialised(store, () => dispatch(store, envelope));
		}
		return dispatch(store, envelope);
	};
}

function makeError(kind: "Unavailable" | "Invalid" | "Denied", message: string): Error {
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
