/**
 * The `proposes-write` result contract (Tool-8b, doc 78).
 *
 * A tool never writes the caller's data — it receives values and returns
 * values. A tool declaring `effect: "proposes-write"` therefore returns a
 * PROPOSAL: a set of before → after changes the CALLER renders, a human
 * approves, and the caller applies **in its own transaction** (one
 * `doc.transact`, so undo reverts the whole proposal as one step).
 *
 * Everything in a proposal is PROVIDER-AUTHORED, UNTRUSTED DATA. This parser
 * is the screen: it copies only the known fields into a fresh object (never
 * forwards the provider's object by reference), sanitizes every single-line
 * string, and REJECTS — rather than truncating or stripping — a body that is
 * over cap or carries control/bidi-override characters. A human is about to
 * approve these exact bytes, and rendering something other than what will be
 * applied is worse than refusing. A malformed proposal parses to `null`; the
 * caller reports that as a `ProviderError` refusal chip, never as a
 * half-rendered card.
 */

import { hasUnsafeBodyChars, sanitizeInlineText } from "../sanitize-text";

/** Mirrors `APP_TOOL_INPUTS_MAX` — a proposal is a reviewable set of changes,
 *  not a bulk import. */
export const TOOL_PROPOSAL_CHANGES_MAX = 16;
/** Per-side body cap. Over-cap REJECTS the proposal (no silent truncation of
 *  something a human approves). */
export const TOOL_PROPOSAL_TEXT_MAX = 20_000;
export const TOOL_PROPOSAL_KEY_MAX = 64;
export const TOOL_PROPOSAL_LABEL_MAX = 128;
export const TOOL_PROPOSAL_SUMMARY_MAX = 500;

/** One proposed change. `key` is the caller's correlation handle — which of
 *  its own values/fields the change targets (typically the argument name the
 *  caller sent). The caller decides what a key maps to; a key it does not
 *  recognise is a change it must not apply. */
export type AppToolProposalChange = {
	key: string;
	/** Provider's suggested wording for the field. Sanitized, and never
	 *  authoritative: the tray labels every row with the humanized `key` it will
	 *  actually apply to, and shows this only as secondary text. */
	label?: string;
	/** The value as the provider saw it. Rendered struck-through so the user
	 *  can spot a provider proposing against stale data. */
	before?: string;
	after: string;
};

export type AppToolProposal = {
	/** One-line provider summary of the proposal. Sanitized, capped. */
	summary?: string;
	changes: readonly AppToolProposalChange[];
};

/** Keys that name a prototype slot rather than a field. A caller applying a
 *  proposal writes `key` into an object of its own; `__proto__` reaching that
 *  write is never something a human meant to approve. */
const POISON_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function parseBody(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (value.length > TOOL_PROPOSAL_TEXT_MAX) return null;
	// The same rule as the length cap, for the same reason: a body carrying a
	// bidi override or a C1 control RENDERS as something other than the bytes
	// the caller would write, so the whole proposal is refused rather than
	// stripped — a human is about to approve these exact bytes.
	if (hasUnsafeBodyChars(value)) return null;
	return value;
}

function parseChange(value: unknown): AppToolProposalChange | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const key = sanitizeInlineText(raw.key, TOOL_PROPOSAL_KEY_MAX);
	if (key.length === 0) return null;
	if (POISON_KEYS.has(key)) return null;
	const after = parseBody(raw.after);
	if (after === null) return null;
	const change: AppToolProposalChange = { key, after };
	if (raw.before !== undefined) {
		const before = parseBody(raw.before);
		if (before === null) return null;
		change.before = before;
	}
	if (raw.label !== undefined) {
		const label = sanitizeInlineText(raw.label, TOOL_PROPOSAL_LABEL_MAX);
		if (label.length === 0) return null;
		change.label = label;
	}
	return change;
}

/**
 * Parse a `proposes-write` tool result into a renderable proposal, or `null`
 * when it is not one. Only the known fields survive — a fresh object crosses
 * into the UI, never the provider's.
 */
export function parseToolProposal(value: unknown): AppToolProposal | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	// Materialize the list ONCE: a getter or an overridden `Symbol.iterator`
	// makes the length check and the loop below disagree, so a payload passing
	// the ≤16 cap could then yield unbounded entries. The agent is an in-process
	// caller, so this is reachable — same fix as `app-tool-args`' `snapshot`.
	const rawChanges: unknown = raw.changes;
	const entries = Array.isArray(rawChanges) ? Array.prototype.slice.call(rawChanges) : null;
	if (entries === null) return null;
	if (entries.length === 0 || entries.length > TOOL_PROPOSAL_CHANGES_MAX) return null;
	const changes: AppToolProposalChange[] = [];
	for (const entry of entries) {
		const change = parseChange(entry);
		// One malformed change poisons the whole proposal: applying "the valid
		// subset" of something a provider got wrong is a decision a human never
		// made.
		if (change === null) return null;
		changes.push(change);
	}
	const proposal: AppToolProposal = { changes };
	if (raw.summary !== undefined) {
		const summary = sanitizeInlineText(raw.summary, TOOL_PROPOSAL_SUMMARY_MAX);
		if (summary.length === 0) return null;
		proposal.summary = summary;
	}
	return proposal;
}
