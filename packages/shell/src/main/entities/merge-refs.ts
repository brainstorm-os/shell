/**
 * `merge-refs` — pure keystone of the F-158 duplicate merge: rewrite the
 * entity-id references inside a property bag from a set of loser ids to the
 * surviving id, without knowing (or caring) which property is a ref.
 *
 * Entity ids are opaque, globally-unique strings (`ent_<ULID>`-shaped), so a
 * property VALUE that string-equals a loser id IS a reference to it — the
 * same assumption the read-side link derivation makes
 * ([[derive-property-ref-links]] `readEntityRefIds`). The walk covers every
 * storage shape a ref can take per that reader: a bare scalar id, an array of
 * ids, and `{ value, label? }` / `{ id }` / `{ entityId }` envelopes (arrays
 * of envelopes included). Property KEYS are never rewritten, and non-string
 * leaves are untouched, so a name that merely contains an id-like substring
 * can't be corrupted — only exact string equality rewrites.
 *
 * Two merge-specific invariants:
 *  - a rewrite that would make an entity reference ITSELF (the survivor's own
 *    `links` listing a loser) drops the ref instead — a self-edge encodes
 *    nothing and would paint a degenerate edge in the Graph;
 *  - an array that already contains the survivor drops the rewritten
 *    duplicate, so a multi-ref never ends up listing the survivor twice.
 *
 * Pure + deterministic: no I/O, no clock. Returns only the top-level keys
 * whose value changed (the minimal patch for the Y.Doc-first write path), or
 * null when nothing references a loser.
 */

/** Envelope keys an entity-ref object value may carry its id under —
 *  mirrors the read side (`derive-property-ref-links` + the property-ui
 *  cells' emit shapes). */
const REF_ENVELOPE_KEYS = ["value", "id", "entityId"] as const;

type RewriteContext = {
	loserIds: ReadonlySet<string>;
	survivorId: string;
	/** The entity being rewritten — a ref resolving to it is dropped. */
	selfId: string;
};

type Rewritten = { value: unknown; changed: boolean; drop: boolean };

const keep = (value: unknown): Rewritten => ({ value, changed: false, drop: false });

/** Rewrite one scalar id: loser → survivor, self-target → drop. */
function rewriteId(id: string, ctx: RewriteContext): Rewritten {
	if (!ctx.loserIds.has(id)) return keep(id);
	if (ctx.survivorId === ctx.selfId) return { value: null, changed: true, drop: true };
	return { value: ctx.survivorId, changed: true, drop: false };
}

function rewriteEnvelope(obj: Record<string, unknown>, ctx: RewriteContext): Rewritten {
	for (const key of REF_ENVELOPE_KEYS) {
		const inner = obj[key];
		if (typeof inner !== "string" || inner === "") continue;
		const res = rewriteId(inner, ctx);
		if (!res.changed) return keep(obj);
		if (res.drop) return { value: null, changed: true, drop: true };
		return { value: { ...obj, [key]: res.value }, changed: true, drop: false };
	}
	return keep(obj);
}

/** The id an (already-rewritten) array item resolves to, for de-duping. */
function resolvedId(item: unknown): string | null {
	if (typeof item === "string") return item !== "" ? item : null;
	if (item && typeof item === "object" && !Array.isArray(item)) {
		for (const key of REF_ENVELOPE_KEYS) {
			const inner = (item as Record<string, unknown>)[key];
			if (typeof inner === "string" && inner !== "") return inner;
		}
	}
	return null;
}

function rewriteValue(value: unknown, ctx: RewriteContext): Rewritten {
	if (typeof value === "string") {
		if (value === "") return keep(value);
		const res = rewriteId(value, ctx);
		// A dropped scalar ref clears to null (the "unset" shape a scalar
		// entity-ref property reads as empty).
		return res.drop ? { value: null, changed: true, drop: false } : res;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const out: unknown[] = [];
		const seenIds = new Set<string>();
		// Pre-seed with ids already present so a rewritten loser that lands on
		// an id the array already carries is dropped as a duplicate.
		for (const item of value) {
			const id = resolvedId(item);
			if (id && !ctx.loserIds.has(id)) seenIds.add(id);
		}
		for (const item of value) {
			const res =
				item && typeof item === "object" && !Array.isArray(item)
					? rewriteEnvelope(item as Record<string, unknown>, ctx)
					: typeof item === "string" && item !== ""
						? rewriteId(item, ctx)
						: keep(item);
			if (!res.changed) {
				out.push(item);
				continue;
			}
			changed = true;
			if (res.drop) continue;
			const id = resolvedId(res.value);
			if (id && id === ctx.survivorId && seenIds.has(id)) continue; // already listed
			if (id) seenIds.add(id);
			out.push(res.value);
		}
		return changed ? { value: out, changed: true, drop: false } : keep(value);
	}
	if (value && typeof value === "object") {
		const res = rewriteEnvelope(value as Record<string, unknown>, ctx);
		// A dropped envelope ref clears the whole value.
		return res.drop ? { value: null, changed: true, drop: false } : res;
	}
	return keep(value);
}

/**
 * Rewrite every property value in `properties` that references a loser id.
 * Returns the minimal top-level patch (only changed keys), or null when no
 * property referenced a loser.
 */
export function rewriteEntityRefs(
	properties: Record<string, unknown>,
	loserIds: ReadonlySet<string>,
	survivorId: string,
	selfId: string,
): Record<string, unknown> | null {
	const ctx: RewriteContext = { loserIds, survivorId, selfId };
	let patch: Record<string, unknown> | null = null;
	for (const [key, value] of Object.entries(properties)) {
		const res = rewriteValue(value, ctx);
		if (!res.changed) continue;
		if (!patch) patch = {};
		patch[key] = res.value;
	}
	return patch;
}
