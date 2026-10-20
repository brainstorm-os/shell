/**
 * Property diff + restore patch for a checkpoint (10.16) — PURE.
 *
 * Shell-owned keys never travel through a restore: provenance is create-time
 * and immutable, derived authorship is recomputed, and the read-only lock is a
 * control over the object rather than part of its content (restoring a version
 * must not silently lock or unlock it).
 */

import {
	type VersionPropertyChange,
	VersionPropertyChangeKind,
	stripDerivedAuthorship,
	stripReservedProperties,
} from "@brainstorm-os/sdk-types";
import { LOCKED_PROPERTY_KEY } from "@brainstorm-os/sdk/entity-lock";

function content(properties: Record<string, unknown>): Record<string, unknown> {
	const { [LOCKED_PROPERTY_KEY]: _lock, ...rest } = stripDerivedAuthorship(
		stripReservedProperties(properties),
	);
	return rest;
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** What restoring `then` over `now` would change, key-sorted. */
export function diffVersionProperties(
	then: Record<string, unknown>,
	now: Record<string, unknown>,
): VersionPropertyChange[] {
	const a = content(then);
	const b = content(now);
	const changes: VersionPropertyChange[] = [];
	for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
		const inThen = key in a;
		const inNow = key in b;
		if (inThen && inNow) {
			if (!same(a[key], b[key])) {
				changes.push({
					key,
					kind: VersionPropertyChangeKind.Changed,
					versionValue: a[key],
					currentValue: b[key],
				});
			}
		} else if (inThen) {
			changes.push({
				key,
				kind: VersionPropertyChangeKind.Removed,
				versionValue: a[key],
				currentValue: null,
			});
		} else if (b[key] !== null) {
			changes.push({
				key,
				kind: VersionPropertyChangeKind.Added,
				versionValue: null,
				currentValue: b[key],
			});
		}
	}
	return changes;
}

/** The minimal `entities.update` patch that brings `now` back to `then`. A key
 *  added since is cleared to `null` (the property map has no delete). */
export function restorePatch(
	then: Record<string, unknown>,
	now: Record<string, unknown>,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const change of diffVersionProperties(then, now)) {
		patch[change.key] = change.kind === VersionPropertyChangeKind.Added ? null : change.versionValue;
	}
	return patch;
}
