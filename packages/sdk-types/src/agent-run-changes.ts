/**
 * Agent-15 — the content diff + undo contract for an agent run.
 *
 * The trace (Agent-12, `agent-trace.ts`) says WHAT an agent did, as metadata.
 * This leaf is the other half: what each run CHANGED in the vault — objects it
 * created, property values it rewrote, objects it moved to the Bin — and the
 * one-operation revert of exactly those writes.
 *
 * The journal that backs it is written server-side at the agent write seam
 * (the entities service, on a provenance-carrying create / update / delete):
 * the run id, the principal and the entity type are all resolved there, never
 * taken from the caller. What crosses IPC is the bounded projection below —
 * previews are truncated and control-stripped by {@link summarizeChangeValue},
 * so a hostile value can neither bloat a reply nor spoof the timeline text.
 *
 * Undo never clobbers newer work: before anything is written, every touched
 * object is compared with what the run left behind, and ANY difference refuses
 * the whole undo with a named {@link AgentUndoRefusal} (and the field, when one
 * can be named). Nothing is reverted unless everything can be.
 */

import { RESERVED_PROPERTY_KEYS } from "./agent-provenance";
import { sanitizeTraceText } from "./agent-trace";
import { enumGuard } from "./enum-guard";

export enum AgentWriteKind {
	Created = "created",
	Updated = "updated",
	Trashed = "trashed",
}

export const isAgentWriteKind = enumGuard(Object.values(AgentWriteKind));

/** Why an undo was refused. Each maps to one sentence in the surfaces. */
export enum AgentUndoRefusal {
	/** No such run for this caller (or a foreign one — indistinguishable). */
	NotFound = "not-found",
	/** The run wrote nothing the journal recorded. */
	NothingToUndo = "nothing-to-undo",
	AlreadyUndone = "already-undone",
	/** A later edit (the user's, or another run's) changed what this run wrote. */
	EditedSince = "edited-since",
	/** Something the run edited or trashed was permanently deleted since. */
	Purged = "purged",
	/** Something the run edited is in the Bin now. */
	InBin = "in-bin",
	/** Something the run touched is locked (read-only). */
	Locked = "locked",
	/** The caller can no longer write a type the run touched. */
	Denied = "denied",
	/** A write was too large to journal, so the run cannot be reverted exactly. */
	NotRecorded = "not-recorded",
}

export const isAgentUndoRefusal = enumGuard(Object.values(AgentUndoRefusal));

/** Preview ceiling for a before/after value. Legibility, not archival. */
export const AGENT_CHANGE_PREVIEW_MAX = 120;

/** Field ceiling per change — a run that rewrote 400 keys of one object shows
 *  the first ones and a count, never a 400-row reply. */
export const AGENT_CHANGE_FIELDS_MAX = 24;

/** Change ceiling per run projection. */
export const AGENT_RUN_CHANGES_MAX = 200;

/** Keys a run diff never lists: the provenance keys an app may not write,
 *  plus the bookkeeping every row carries (timestamps, the empty property
 *  bag) — host-owned noise, not a change the agent chose to make. */
export const AGENT_CHANGE_HIDDEN_KEYS: readonly string[] = [
	...RESERVED_PROPERTY_KEYS,
	"createdAt",
	"updatedAt",
	"values",
];

export function isAgentChangeHiddenKey(key: string): boolean {
	return AGENT_CHANGE_HIDDEN_KEYS.includes(key);
}

export type AgentLineDelta = { added: number; removed: number };

export type AgentFieldChange = {
	key: string;
	/** Bounded preview, or null when the field was absent / empty. */
	before: string | null;
	after: string | null;
	/** Present when either side is multi-line text — a body-style summary. */
	lines?: AgentLineDelta;
};

export type AgentRunChange = {
	entityId: string;
	entityType: string;
	kind: AgentWriteKind;
	/** The object's display title at the time of the write, when it had one. */
	title: string | null;
	fields: readonly AgentFieldChange[];
	/** Fields beyond {@link AGENT_CHANGE_FIELDS_MAX}, not listed. */
	moreFields: number;
	/** The value was too large to journal (the diff cannot show it). */
	oversize: boolean;
	at: number;
};

export type AgentRunChanges = {
	runId: string;
	changes: readonly AgentRunChange[];
	/** Changes beyond {@link AGENT_RUN_CHANGES_MAX}, not listed. */
	moreChanges: number;
	/** When the run was undone, or null. */
	revertedAt: number | null;
};

export type AgentUndoResult =
	| { ok: true; reverted: number }
	| {
			ok: false;
			reason: AgentUndoRefusal;
			/** The object that blocked the undo, when there is one. */
			entityId: string | null;
			/** The field that blocked it, when one can be named. */
			field: string | null;
	  };

function clean(value: string, max: number): string {
	const stripped = sanitizeTraceText(value, Number.MAX_SAFE_INTEGER);
	return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

/** A one-line, bounded, control-stripped preview of a property value. Null for
 *  an absent / null / empty value, so "set" and "cleared" read plainly. */
export function summarizeChangeValue(
	value: unknown,
	max = AGENT_CHANGE_PREVIEW_MAX,
): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value.trim() === "" ? null : clean(value, max);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return null;
		const scalars = value.filter((v) => typeof v === "string" || typeof v === "number");
		if (scalars.length === value.length) return clean(scalars.join(", "), max);
		return `[${value.length}]`;
	}
	if (typeof value === "object" && Object.keys(value).length === 0) return null;
	try {
		return clean(JSON.stringify(value), max);
	} catch {
		return null;
	}
}

function lineBag(text: string): Map<string, number> {
	const bag = new Map<string, number>();
	if (text === "") return bag;
	for (const line of text.split("\n")) bag.set(line, (bag.get(line) ?? 0) + 1);
	return bag;
}

/** Added / removed line counts between two texts — a multiset difference, so
 *  it is linear and order-insensitive (a summary, not a patch). */
export function lineDelta(before: string, after: string): AgentLineDelta {
	const was = lineBag(before);
	const now = lineBag(after);
	let added = 0;
	let removed = 0;
	for (const [line, n] of now) added += Math.max(0, n - (was.get(line) ?? 0));
	for (const [line, n] of was) removed += Math.max(0, n - (now.get(line) ?? 0));
	return { added, removed };
}

/** One field's change row. `lines` rides along when either side is text with
 *  more than one line — the "body diff summary" a surface renders as +N / −M. */
export function describeFieldChange(
	key: string,
	before: unknown,
	after: unknown,
): AgentFieldChange {
	const row: AgentFieldChange = {
		key,
		before: summarizeChangeValue(before),
		after: summarizeChangeValue(after),
	};
	const multiline = (v: unknown): boolean => typeof v === "string" && v.includes("\n");
	if (multiline(before) || multiline(after)) {
		row.lines = lineDelta(
			typeof before === "string" ? before : "",
			typeof after === "string" ? after : "",
		);
	}
	return row;
}
