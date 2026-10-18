/**
 * Agent-15 — turn one run's journaled writes into (a) the diff a surface shows
 * and (b) an undo plan, refusing the undo whole when anything the run wrote
 * has changed since.
 *
 * Pure over the journal + a current-state reader so every refusal is unit-
 * tested without a vault. The entities service owns the apply half (it is the
 * only place a write can go through the Y.Doc and live-sync), and calls
 * {@link planRunUndo} first: nothing is written unless the WHOLE run can be
 * reverted.
 *
 * Folding: a run may write one object several times (create, then pin it into
 * a collection; or two updates). Per object the journal folds oldest→newest
 * into "what the run left behind" — the expected current state — and "what was
 * there before the run first touched each key". The undo then compares the
 * live object with the expected state:
 *   - an object the run CREATED is trashed (to the Bin, recoverable), but only
 *     if it is exactly as the run left it: any field changed or added, or any
 *     later write at all (`updatedAt` past the run's last write) refuses — a
 *     trash would discard the user's work on it;
 *   - an object the run EDITED gets each touched key's prior value back, and
 *     only those keys; a key changed since refuses, naming the field. Keys the
 *     run never touched are never written, so the user's other edits survive;
 *   - an object the run TRASHED is restored from the Bin; one purged since
 *     refuses (`Purged`).
 * A locked object refuses (`Locked`) — undo is a write path like any other.
 */

import {
	AGENT_CHANGE_FIELDS_MAX,
	AGENT_RUN_CHANGES_MAX,
	type AgentRunChange,
	type AgentRunChanges,
	AgentUndoRefusal,
	type AgentUndoResult,
	AgentWriteKind,
	RESERVED_PROPERTY_KEYS,
	describeFieldChange,
} from "@brainstorm-os/sdk-types";
import { isLockedProperties } from "@brainstorm-os/sdk/entity-lock";
import { resolveEntityTitle } from "@brainstorm-os/sdk/entity-title";
import type { AgentWriteRecord } from "../../storage/entities-repo";

/** The live state of one object as the planner needs it. */
export type UndoTargetState = {
	properties: Record<string, unknown>;
	updatedAt: number;
	/** Null when live; set when the object is in the Bin. */
	deletedAt: number | null;
};

export enum UndoOpKind {
	Trash = "trash",
	Restore = "restore",
	Patch = "patch",
}

export type UndoOp =
	| { kind: UndoOpKind.Trash; entityId: string; entityType: string }
	| { kind: UndoOpKind.Restore; entityId: string; entityType: string }
	| {
			kind: UndoOpKind.Patch;
			entityId: string;
			entityType: string;
			patch: Record<string, unknown>;
	  };

type Refusal = Extract<AgentUndoResult, { ok: false }>;

export type UndoPlan = { ok: true; ops: UndoOp[] } | Refusal;

type Folded = {
	entityId: string;
	entityType: string;
	created: boolean;
	trashedInRun: boolean;
	expected: Record<string, unknown>;
	/** The value each key had before the run first touched it (absent → null). */
	prior: Record<string, unknown>;
	lastTs: number;
	oversize: boolean;
};

function refuse(reason: AgentUndoRefusal, entityId: string | null, field: string | null): Refusal {
	return { ok: false, reason, entityId, field };
}

/** Canonical JSON (sorted keys) so `{a,b}` and `{b,a}` compare equal. */
function canonical(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const entries = Object.keys(value as Record<string, unknown>)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
	return `{${entries.join(",")}}`;
}

function sameValue(a: unknown, b: unknown): boolean {
	return canonical(a ?? null) === canonical(b ?? null);
}

function isReserved(key: string): boolean {
	return RESERVED_PROPERTY_KEYS.includes(key);
}

function foldRun(entries: readonly AgentWriteRecord[]): Folded[] {
	const byEntity = new Map<string, Folded>();
	for (const entry of entries) {
		let f = byEntity.get(entry.entityId);
		if (!f) {
			f = {
				entityId: entry.entityId,
				entityType: entry.entityType,
				created: false,
				trashedInRun: false,
				expected: {},
				prior: {},
				lastTs: entry.ts,
				oversize: false,
			};
			byEntity.set(entry.entityId, f);
		}
		f.lastTs = Math.max(f.lastTs, entry.ts);
		if (entry.oversize) f.oversize = true;
		switch (entry.kind) {
			case AgentWriteKind.Created:
				f.created = true;
				f.trashedInRun = false;
				f.expected = { ...(entry.after ?? {}) };
				break;
			case AgentWriteKind.Updated: {
				const after = entry.after ?? {};
				for (const key of Object.keys(after)) {
					if (!f.created && !(key in f.prior)) {
						const before = entry.before;
						f.prior[key] = before && key in before.present ? before.present[key] : null;
					}
					f.expected[key] = after[key];
				}
				break;
			}
			case AgentWriteKind.Trashed:
				f.trashedInRun = true;
				break;
		}
	}
	return [...byEntity.values()];
}

/** The diff a surface renders for one run. Bounded by the AGENT_* ceilings. */
export function buildRunChanges(
	runId: string,
	entries: readonly AgentWriteRecord[],
): AgentRunChanges {
	const changes: AgentRunChange[] = [];
	let revertedAt: number | null = null;
	for (const entry of entries) {
		if (entry.revertedAt !== null) revertedAt = Math.max(revertedAt ?? 0, entry.revertedAt);
		if (changes.length >= AGENT_RUN_CHANGES_MAX) continue;
		const after = entry.after ?? {};
		const keys = Object.keys(after).filter((k) => !isReserved(k));
		const listed = keys.slice(0, AGENT_CHANGE_FIELDS_MAX);
		const before = entry.before;
		changes.push({
			entityId: entry.entityId,
			entityType: entry.entityType,
			kind: entry.kind,
			title: resolveEntityTitle(entry.kind === AgentWriteKind.Created ? after : null),
			fields:
				entry.kind === AgentWriteKind.Trashed
					? []
					: listed.map((key) =>
							describeFieldChange(
								key,
								before && key in before.present ? before.present[key] : null,
								after[key],
							),
						),
			moreFields: Math.max(0, keys.length - listed.length),
			oversize: entry.oversize,
			at: entry.ts,
		});
	}
	return {
		runId,
		changes,
		moreChanges: Math.max(0, entries.length - changes.length),
		revertedAt,
	};
}

/**
 * Decide whether the run can be undone and, if so, exactly which writes undo
 * it. `readState` returns the object's current state (live or in the Bin), or
 * null when it no longer exists at all. `canWrite` re-checks the caller's
 * authority per type at undo time — a grant revoked since the run refuses.
 */
export function planRunUndo(
	entries: readonly AgentWriteRecord[],
	readState: (entityId: string) => UndoTargetState | null,
	canWrite: (entityType: string) => boolean,
): UndoPlan {
	if (entries.length === 0) return refuse(AgentUndoRefusal.NothingToUndo, null, null);
	if (entries.some((e) => e.revertedAt !== null)) {
		return refuse(AgentUndoRefusal.AlreadyUndone, null, null);
	}
	const ops: UndoOp[] = [];
	for (const f of foldRun(entries)) {
		if (f.oversize) return refuse(AgentUndoRefusal.NotRecorded, f.entityId, null);
		if (!canWrite(f.entityType)) return refuse(AgentUndoRefusal.Denied, f.entityId, null);
		const state = readState(f.entityId);
		const base = { entityId: f.entityId, entityType: f.entityType };

		if (f.created) {
			// Gone already (purged, or the user binned it): nothing left to undo.
			if (!state || state.deletedAt !== null) continue;
			if (isLockedProperties(state.properties)) {
				return refuse(AgentUndoRefusal.Locked, f.entityId, null);
			}
			const changed = firstDifference(f.expected, state.properties, true);
			if (changed !== null) return refuse(AgentUndoRefusal.EditedSince, f.entityId, changed);
			if (state.updatedAt > f.lastTs) {
				return refuse(AgentUndoRefusal.EditedSince, f.entityId, null);
			}
			ops.push({ kind: UndoOpKind.Trash, ...base });
			continue;
		}

		if (!state) return refuse(AgentUndoRefusal.Purged, f.entityId, null);
		if (f.trashedInRun) {
			if (state.deletedAt === null) return refuse(AgentUndoRefusal.EditedSince, f.entityId, null);
		} else if (state.deletedAt !== null) {
			return refuse(AgentUndoRefusal.InBin, f.entityId, null);
		}
		if (isLockedProperties(state.properties)) {
			return refuse(AgentUndoRefusal.Locked, f.entityId, null);
		}
		const changed = firstDifference(f.expected, state.properties, false);
		if (changed !== null) return refuse(AgentUndoRefusal.EditedSince, f.entityId, changed);
		if (f.trashedInRun) ops.push({ kind: UndoOpKind.Restore, ...base });
		if (Object.keys(f.prior).length > 0) {
			ops.push({ kind: UndoOpKind.Patch, ...base, patch: { ...f.prior } });
		}
	}
	if (ops.length === 0) return refuse(AgentUndoRefusal.NothingToUndo, null, null);
	return { ok: true, ops };
}

/** The first key whose live value differs from what the run left. With
 *  `strict`, a key present live but not written by the run counts too (a
 *  field the user added to an agent-created object). Reserved keys are the
 *  service's own and never count. */
function firstDifference(
	expected: Record<string, unknown>,
	live: Record<string, unknown>,
	strict: boolean,
): string | null {
	for (const key of Object.keys(expected)) {
		if (isReserved(key)) continue;
		if (!sameValue(expected[key], live[key])) return key;
	}
	if (strict) {
		for (const key of Object.keys(live)) {
			if (isReserved(key) || key in expected) continue;
			if (live[key] !== null && live[key] !== undefined) return key;
		}
	}
	return null;
}
