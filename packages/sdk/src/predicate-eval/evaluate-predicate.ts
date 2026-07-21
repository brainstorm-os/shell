/**
 * Pure evaluator for `PropertyPredicate` against a single entity. Mirrors
 * the semantics the entities service compiles to SQL, per
 *  §Predicate semantics.
 *
 * Promoted from `apps/database/src/logic/evaluate-predicate.ts` (9.12.3):
 * the shell's `ListSource` query path runs THIS evaluator for the
 * filter-shaped source kinds, so the app's view filtering and the
 * entities-service membership resolution cannot drift — parity by
 * construction, not by test alone.
 *
 * Surviving keystone: same `PropertyPredicate` shape flows through both the
 * service path and this evaluator. The renderer only ever consumes the
 * evaluator (or a stream of matches from the service); tests can pin the
 * truth-table for both without divergence.
 */

import { isPropertyRef } from "@brainstorm-os/sdk-types";
import type { PropertyPredicate, ScalarValue } from "@brainstorm-os/sdk-types";
import { type EntityRow, readPropertyPath } from "../in-memory-entities";
import { isInRelativeRange, isRelativeDateRange } from "./relative-date";

/**
 * Evaluate a `PropertyPredicate` against a single entity.
 *
 * `now` (Unix ms) is injected so the live-rolling `$relativeDate` operator
 * resolves against a single consistent clock for the whole pass — and so tests
 * can pin a fixed reference. It defaults to the current time, which is what
 * makes a "Last 7 days" view filter re-roll every time it recompiles.
 */
export function evaluatePredicate(
	entity: EntityRow,
	pred: PropertyPredicate,
	now: number = Date.now(),
): boolean {
	if ("$and" in pred) return pred.$and.every((p) => evaluatePredicate(entity, p, now));
	if ("$or" in pred) return pred.$or.some((p) => evaluatePredicate(entity, p, now));
	if ("$not" in pred) return !evaluatePredicate(entity, pred.$not, now);

	if ("$eq" in pred)
		return everyEntry(pred.$eq, (path, want) =>
			scalarEq(readScalar(entity, path), eqOperand(entity, want, now)),
		);
	if ("$neq" in pred)
		return everyEntry(
			pred.$neq,
			(path, want) => !scalarEq(readScalar(entity, path), eqOperand(entity, want, now)),
		);
	if ("$contains" in pred)
		return everyEntry(pred.$contains, (path, want) =>
			collectionContains(readPropertyPath(entity, path), want),
		);
	if ("$notContains" in pred)
		return everyEntry(
			pred.$notContains,
			(path, want) => !collectionContains(readPropertyPath(entity, path), want),
		);
	if ("$gt" in pred)
		return everyEntry(pred.$gt, (path, rhs) => signMatches(entity, path, rhs, now, (s) => s > 0));
	if ("$lt" in pred)
		return everyEntry(pred.$lt, (path, rhs) => signMatches(entity, path, rhs, now, (s) => s < 0));
	if ("$gte" in pred)
		return everyEntry(pred.$gte, (path, rhs) => signMatches(entity, path, rhs, now, (s) => s >= 0));
	if ("$lte" in pred)
		return everyEntry(pred.$lte, (path, rhs) => signMatches(entity, path, rhs, now, (s) => s <= 0));
	if ("$in" in pred)
		return everyEntry(pred.$in, (path, list) => {
			const v = readScalar(entity, path);
			return list.some((candidate) => scalarEq(v, candidate));
		});
	if ("$notIn" in pred)
		return everyEntry(pred.$notIn, (path, list) => {
			const v = readScalar(entity, path);
			return !list.some((candidate) => scalarEq(v, candidate));
		});
	if ("$allIn" in pred)
		return everyEntry(pred.$allIn, (path, list) => {
			const collected = collectAll(readPropertyPath(entity, path));
			return list.every((want) => collected.some((have) => scalarEq(have, want)));
		});
	if ("$exists" in pred)
		return everyEntry(pred.$exists, (path) => {
			const v = readPropertyPath(entity, path);
			return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
		});
	if ("$empty" in pred)
		return everyEntry(pred.$empty, (path) => {
			const v = readPropertyPath(entity, path);
			return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === "";
		});
	if ("$like" in pred)
		return everyEntry(pred.$like, (path, pattern) => likeMatch(readScalar(entity, path), pattern));
	if ("$notLike" in pred)
		return everyEntry(
			pred.$notLike,
			(path, pattern) => !likeMatch(readScalar(entity, path), pattern),
		);
	if ("$relativeDate" in pred)
		return everyEntry(pred.$relativeDate, (path, token) => {
			// Unknown token → match nothing (a malformed / future-version filter
			// shouldn't silently match every row).
			if (!isRelativeDateRange(token)) return false;
			return isInRelativeRange(readScalar(entity, path), token, now);
		});

	return false;
}

function everyEntry<V>(map: Record<string, V>, pred: (path: string, value: V) => boolean): boolean {
	for (const [path, value] of Object.entries(map)) {
		if (!pred(path, value)) return false;
	}
	return true;
}

function readScalar(entity: EntityRow, path: string): unknown {
	const v = readPropertyPath(entity, path);
	if (Array.isArray(v)) return v.length === 0 ? undefined : v[0];
	return v;
}

function scalarEq(a: unknown, b: unknown): boolean {
	if (a === null || a === undefined) return b === null;
	if (typeof a === "number" && typeof b === "number") return a === b;
	if (typeof a === "string" && typeof b === "string") return a === b;
	if (typeof a === "boolean" && typeof b === "boolean") return a === b;
	return false;
}

function collectionContains(collection: unknown, want: ScalarValue): boolean {
	if (typeof collection === "string" && typeof want === "string") {
		return collection.toLowerCase().includes(want.toLowerCase());
	}
	if (Array.isArray(collection)) {
		return collection.some((c) => scalarEq(c, want));
	}
	return false;
}

function collectAll(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value;
	return [value];
}

function compare(a: unknown, b: number | string): number {
	if (a === null || a === undefined) return Number.NEGATIVE_INFINITY;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
	if (typeof a === "string" && typeof b === "number") return Number(a) - b;
	if (typeof a === "number" && typeof b === "string") return a - Number(b);
	return 0;
}

/** Resolve an `$eq`/`$neq` right-hand side (9.12.21): a `PropertyRef` reads
 *  another property — or the clock (`$now`) — on the same entity; a literal
 *  passes through unchanged. */
function eqOperand(entity: EntityRow, operand: unknown, now: number): unknown {
	if (isPropertyRef(operand)) {
		return "$now" in operand ? now : readScalar(entity, operand.$prop);
	}
	return operand;
}

/** Coerce a value to an orderable scalar: a property-ui `DateValue` `{at}`
 *  unwraps to its ms timestamp, numbers/strings pass through, anything else is
 *  incomparable (`null`) so a comparison against it never matches. */
function asComparable(value: unknown): number | string | null {
	if (typeof value === "object" && value !== null && "at" in value) {
		const at = (value as { at: unknown }).at;
		return typeof at === "number" && Number.isFinite(at) ? at : null;
	}
	if (typeof value === "number" || typeof value === "string") return value;
	return null;
}

/** Resolve a comparison right-hand side to an orderable value — a literal,
 *  another property (`$prop`), or the clock (`$now`). `null` ⇒ incomparable. */
function comparand(entity: EntityRow, rhs: unknown, now: number): number | string | null {
	if (isPropertyRef(rhs)) {
		return "$now" in rhs ? now : asComparable(readScalar(entity, rhs.$prop));
	}
	return asComparable(rhs);
}

/** True when both operands are comparable and their ordering satisfies `ok`. A
 *  missing/incomparable side never matches — mirroring SQL's NULL ordering
 *  (`x < NULL` is never true), so the evaluator and the SQL compiler agree. */
function signMatches(
	entity: EntityRow,
	path: string,
	rhs: unknown,
	now: number,
	ok: (sign: number) => boolean,
): boolean {
	const left = asComparable(readScalar(entity, path));
	const right = comparand(entity, rhs, now);
	if (left === null || right === null) return false;
	return ok(compare(left, right));
}

/** SQL-style `LIKE` with `%` wildcard, case-insensitive. `_` (single-char)
 *  is NOT supported — the spec uses `%` only. Escaping is intentional:
 *  literal `%` characters in the pattern aren't escapable in the predicate
 *  shape today; if a user needs `%` matching, the property value can be
 *  pre-sanitised. The same constraint will exist on the SQL side. */
function likeMatch(value: unknown, pattern: string): boolean {
	if (typeof value !== "string") return false;
	const escaped = pattern.replace(/[.+^${}()|[\]\\?*]/g, "\\$&").replace(/%/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}
