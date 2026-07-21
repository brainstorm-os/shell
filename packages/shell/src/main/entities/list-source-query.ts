/**
 * `ListSource` query resolution (9.12.3) — the entities-service twin of the
 * Database app's in-memory `evaluateSource`.
 *
 * Strategy: SQL fast paths for the *indexable* source kinds (`byType` rides
 * `idx_entities_type`, `byLink` rides `idx_links_source`/`idx_links_dest`),
 * and the SHARED `@brainstorm-os/sdk/predicate-eval` evaluator for the
 * filter-shaped kinds (`byFilter`, `byVocabulary`) over a lazily-materialized
 * row set — the exact code the renderer runs, so the two paths cannot drift
 * (parity by construction for the evaluator kinds; parity property tests for
 * the SQL kinds). `composite` resolves children recursively and combines
 * with the SAME set algebra the evaluator uses (`intersectAll`/`unionAll`).
 *
 * Lives in the shell because the entities service owns query execution —
 * apps never see SQL; they call `vaultEntities.querySource({source})` and
 * receive the resolved id set. Member overrides
 * (`effective = (source ∪ include) \ exclude`) stay client-side: they are
 * pure id-set arithmetic the app already owns via `effectiveMembers`.
 *
 * Fail-closed validation: a malformed / oversized source is rejected with a
 * structured error before anything executes — mirroring the GraphPattern
 * compiler's cost-cap posture (a pathological composite can't pin the main
 * process).
 */

import {
	CompositeOp,
	LinkDirection,
	type ListSource,
	ListSourceKind,
} from "@brainstorm-os/sdk-types";
import type { InMemoryVault } from "@brainstorm-os/sdk/in-memory-entities";
import {
	byLinkAnchors,
	evaluateSource,
	intersectAll,
	unionAll,
} from "@brainstorm-os/sdk/predicate-eval";

/* ── Cost caps (structural — checked before execution) ──────────────────── */

export const LIST_SOURCE_MAX_DEPTH = 4;
export const LIST_SOURCE_MAX_CHILDREN = 16;
export const LIST_SOURCE_MAX_TYPES = 64;
export const LIST_SOURCE_MAX_ANCHORS = 256;
export const LIST_SOURCE_MAX_VALUES = 256;

/* ── Result shape (mirrors the GraphPattern envelope posture) ───────────── */

export enum ListSourceErrorKind {
	Invalid = "source-invalid",
	TooExpensive = "source-too-expensive",
}

export type ListSourceQueryError = { kind: ListSourceErrorKind; message: string };

export type ListSourceQueryResult =
	| { ok: true; ids: string[] }
	| { ok: false; error: ListSourceQueryError };

/* ── Backend — what the resolver needs from the repo / service ──────────── */

export type ListSourceBackend = {
	/** `byType` fast path. Absent on test stubs → evaluator fallback. */
	idsByTypes?(types: readonly string[]): readonly string[];
	/** `byLink` fast path. Absent on test stubs → evaluator fallback. */
	idsByLink?(
		anchors: readonly string[],
		linkType: string,
		direction: LinkDirection,
	): readonly string[];
	/** Materialized live rows for the evaluator-backed kinds. Implementations
	 *  should memoize — the resolver may call it once per evaluator-backed
	 *  node in a composite. */
	vault(): InMemoryVault;
};

/* ── Validation ─────────────────────────────────────────────────────────── */

function invalid(message: string): ListSourceQueryError {
	return { kind: ListSourceErrorKind.Invalid, message };
}

function tooExpensive(message: string): ListSourceQueryError {
	return { kind: ListSourceErrorKind.TooExpensive, message };
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Structural validation + cost caps. Returns `null` when the value is a
 *  well-formed `ListSource` (or `null` — a sourceless List resolves to ∅). */
export function validateListSource(value: unknown, depth = 0): ListSourceQueryError | null {
	if (value === null) return null;
	if (typeof value !== "object") return invalid("source must be an object or null");
	if (depth > LIST_SOURCE_MAX_DEPTH) {
		return tooExpensive(`composite nesting exceeds ${LIST_SOURCE_MAX_DEPTH}`);
	}
	const source = value as Record<string, unknown>;
	switch (source.kind) {
		case ListSourceKind.ByType: {
			if (!isStringArray(source.types)) return invalid("byType.types must be a string array");
			if (source.types.length > LIST_SOURCE_MAX_TYPES) {
				return tooExpensive(`byType.types exceeds ${LIST_SOURCE_MAX_TYPES}`);
			}
			return null;
		}
		case ListSourceKind.ByFilter: {
			if (source.where === null || typeof source.where !== "object") {
				return invalid("byFilter.where must be a predicate object");
			}
			return null;
		}
		case ListSourceKind.ByLink: {
			if (typeof source.linkType !== "string") return invalid("byLink.linkType must be a string");
			if (source.direction !== LinkDirection.In && source.direction !== LinkDirection.Out) {
				return invalid("byLink.direction must be 'in' or 'out'");
			}
			if (source.anchorEntityId !== undefined && typeof source.anchorEntityId !== "string") {
				return invalid("byLink.anchorEntityId must be a string");
			}
			if (source.anchorEntityIds !== undefined && !isStringArray(source.anchorEntityIds)) {
				return invalid("byLink.anchorEntityIds must be a string array");
			}
			const anchors = (source.anchorEntityIds?.length ?? 0) + (source.anchorEntityId ? 1 : 0);
			if (anchors > LIST_SOURCE_MAX_ANCHORS) {
				return tooExpensive(`byLink anchors exceed ${LIST_SOURCE_MAX_ANCHORS}`);
			}
			return null;
		}
		case ListSourceKind.ByVocabulary: {
			if (typeof source.vocabularyId !== "string") {
				return invalid("byVocabulary.vocabularyId must be a string");
			}
			if (source.values !== undefined && !isStringArray(source.values)) {
				return invalid("byVocabulary.values must be a string array");
			}
			if ((source.values?.length ?? 0) > LIST_SOURCE_MAX_VALUES) {
				return tooExpensive(`byVocabulary.values exceed ${LIST_SOURCE_MAX_VALUES}`);
			}
			return null;
		}
		case ListSourceKind.Composite: {
			if (source.op !== CompositeOp.And && source.op !== CompositeOp.Or) {
				return invalid("composite.op must be 'and' or 'or'");
			}
			if (!Array.isArray(source.sources)) return invalid("composite.sources must be an array");
			if (source.sources.length > LIST_SOURCE_MAX_CHILDREN) {
				return tooExpensive(`composite.sources exceeds ${LIST_SOURCE_MAX_CHILDREN}`);
			}
			for (const child of source.sources) {
				const err = validateListSource(child, depth + 1);
				if (err) return err;
			}
			return null;
		}
		default:
			return invalid(`unknown source kind: ${String(source.kind)}`);
	}
}

/* ── Resolution ─────────────────────────────────────────────────────────── */

/** Resolve a (validated-or-raw) `ListSource` to its live member id set.
 *  Validates first; the structured error mirrors `queryPattern`'s posture. */
export function queryListSource(raw: unknown, backend: ListSourceBackend): ListSourceQueryResult {
	const err = validateListSource(raw);
	if (err) return { ok: false, error: err };
	const ids = resolve(raw as ListSource | null, backend);
	return { ok: true, ids: [...ids].sort() };
}

function resolve(source: ListSource | null, backend: ListSourceBackend): Set<string> {
	if (source === null) return new Set();
	switch (source.kind) {
		case ListSourceKind.ByType: {
			if (backend.idsByTypes) return new Set(backend.idsByTypes(source.types));
			return evaluateSource(source, backend.vault());
		}
		case ListSourceKind.ByLink: {
			if (backend.idsByLink) {
				const anchors = byLinkAnchors(source);
				if (anchors.size === 0) return new Set();
				return new Set(backend.idsByLink([...anchors], source.linkType, source.direction));
			}
			return evaluateSource(source, backend.vault());
		}
		case ListSourceKind.ByFilter:
		case ListSourceKind.ByVocabulary:
			// The SHARED evaluator — the same code the renderer runs.
			return evaluateSource(source, backend.vault());
		case ListSourceKind.Composite: {
			if (source.sources.length === 0) return new Set();
			const children = source.sources.map((child) => resolve(child, backend));
			return source.op === CompositeOp.And ? intersectAll(children) : unionAll(children);
		}
	}
}
