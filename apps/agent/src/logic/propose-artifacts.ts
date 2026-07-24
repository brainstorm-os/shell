/**
 * Agent-11a — the agent PROPOSES vault artifacts; it never persists them.
 *
 * The owner decision (2026-07-23) is **preview + confirm each write**. That
 * choice fixes the architecture: the model's create tools are **propose, not
 * persist**. A `propose-*` tool call is dispatched to a pure staging step (this
 * module) that returns a "queued for the user's approval" ack — it writes
 * nothing. The real `entities.create` runs only when a human approves a staged
 * artifact (Agent-11b). So the dangerous `entities.write:*` capability is only
 * ever exercised by a human gesture, and no model output — including a prompt
 * injection — can put bytes in the vault. This keeps the exact security posture
 * the team already sanctioned for Agent-10 (user-gesture-only writes, doc 75 /
 * OQ-ANS-4) while making the agent feel fully generative.
 *
 * The shared {@link runAgentLoop} needs no change: the propose/persist split
 * lives entirely in (1) this curated tool catalogue and (2) the host's
 * `dispatchTool`, which routes a propose verb here instead of to the vault.
 *
 * Pure + framework-free so the catalogue, the fail-closed field mapping, and the
 * pending-buffer reducer are all unit-tested without a runtime.
 */

import type { AgentTool, ValueType } from "@brainstorm-os/sdk-types";
import type { ProposedDatabase } from "./propose-database";

/** The artifact kinds the agent can propose (Agent-11a/b: simple entities;
 *  database rows / new databases are Agent-11d/11e). Each kind is its OWN tool
 *  because the shared loop addresses a tool by its `verb` alone — one verb per
 *  kind keeps them distinct AND gives per-kind grants in the Agent-5 UI.
 *
 *  Journal is deliberately NOT here: a journal entry is not a plain entity
 *  create — it keys a STABLE per-day id (`journalEntryIdForKey`) and its body
 *  lives in the entry's Y.Doc, not a property. Proposing one needs the day-merge
 *  + CRDT-body path, so it rides a later rung, not the property-create mapper. */
export const ProposeKind = {
	Note: "note",
	Task: "task",
	Event: "event",
	Bookmark: "bookmark",
	Contact: "contact",
	/** A row in one of the user's databases (Agent-11d). Unlike the kinds above
	 *  its fields are NOT fixed at build time — they are the target database's
	 *  own columns, carried on the artifact's `row` payload. */
	Row: "row",
	/** A whole new database — Collection + columns + seed rows (Agent-11e).
	 *  Its schema rides the `database` payload; its seed-row cells ride
	 *  `fields` under `rowCellKey(i, column)`. */
	Database: "database",
} as const;
export type ProposeKind = (typeof ProposeKind)[keyof typeof ProposeKind];

/** Field-value clamps — a staged proposal can never carry an unbounded blob to
 *  the preview card / eventual write (DoS + prompt-stuffing guard). */
export const PROPOSE_SHORT_MAX = 500;
export const PROPOSE_LONG_MAX = 8000;

/** A curated proposable kind: its stable tool verb, the CANONICAL entity type
 *  its owner app renders (resolved against each app's live query — a note must
 *  be `io.brainstorm.notes/Note/v1` to show in Notes, not the cross-app alias),
 *  the arg allowlist the model may fill, which of those is required + drives the
 *  card summary, and whether each field is long-form (looser clamp). */
export type ProposeDescriptor = {
	kind: ProposeKind;
	verb: string;
	entityType: string;
	labelKey: string;
	primaryField: string;
	fields: readonly string[];
	longFields: readonly string[];
};

/** The Note entity type Notes actually renders (Agent-10's `insert-to-note`
 *  writes this same id — real-shell verified). The proposed `body` rides the
 *  plain-text property; the Notes editor rebuilds its state from that body when
 *  no `richBody` is present (the supported legacy-body path). */
const NOTE_ENTITY_TYPE = "io.brainstorm.notes/Note/v1";

export const PROPOSE_DESCRIPTORS: readonly ProposeDescriptor[] = [
	{
		kind: ProposeKind.Note,
		verb: "propose-note",
		entityType: NOTE_ENTITY_TYPE,
		labelKey: "propose.note.label",
		primaryField: "title",
		fields: ["title", "body"],
		longFields: ["body"],
	},
	{
		kind: ProposeKind.Task,
		verb: "propose-task",
		entityType: "brainstorm/Task/v1",
		labelKey: "propose.task.label",
		primaryField: "title",
		fields: ["title", "dueDate", "status", "notes"],
		longFields: ["notes"],
	},
	{
		kind: ProposeKind.Event,
		verb: "propose-event",
		entityType: "brainstorm/Event/v1",
		labelKey: "propose.event.label",
		primaryField: "title",
		fields: ["title", "start", "end", "location", "notes"],
		longFields: ["notes"],
	},
	{
		kind: ProposeKind.Bookmark,
		verb: "propose-bookmark",
		entityType: "brainstorm/Bookmark/v1",
		labelKey: "propose.bookmark.label",
		primaryField: "url",
		fields: ["url", "title", "note"],
		longFields: ["note"],
	},
	{
		kind: ProposeKind.Contact,
		verb: "propose-contact",
		entityType: "brainstorm/Person/v1",
		labelKey: "propose.contact.label",
		primaryField: "name",
		fields: ["name", "email", "phone", "company", "notes"],
		longFields: ["notes"],
	},
];

const DESCRIPTOR_BY_VERB = new Map(PROPOSE_DESCRIPTORS.map((d) => [d.verb, d] as const));

/** The descriptor a dispatched propose verb maps to, or `null` if the verb is
 *  not a curated propose tool (the host then falls through to `open` etc.). */
export function proposeDescriptorForVerb(verb: string): ProposeDescriptor | null {
	return DESCRIPTOR_BY_VERB.get(verb) ?? null;
}

/** The curated propose tools offered to the model. NO `entityType` is declared
 *  on the tool: {@link agentToolCapabilities} would otherwise demand
 *  `entities.read:<type>`, but proposing needs no read — the model only stages a
 *  draft. So each tool requires exactly `intents.dispatch:<verb>`, which the
 *  Agent-5 grant UI already toggles per verb. */
export function proposeTools(translate: (key: string) => string): AgentTool[] {
	return PROPOSE_DESCRIPTORS.map((d) => ({ verb: d.verb, label: translate(d.labelKey) }));
}

/** The `intents.dispatch:propose-*` capability footprint the manifest must
 *  declare for any propose tool to be offered (asserted by the manifest test). */
export function proposeToolCapabilities(): string[] {
	return PROPOSE_DESCRIPTORS.map((d) => `intents.dispatch:${d.verb}`).sort();
}

/** The `entities.write:<type>` caps the manifest must hold so an APPROVED
 *  proposal can persist (deduped — Note + Journal share a type). Exercised only
 *  on a human approval, never by the model. */
export function proposeEntityWriteCapabilities(): string[] {
	return [...new Set(PROPOSE_DESCRIPTORS.map((d) => `entities.write:${d.entityType}`))].sort();
}

/** One column of a proposed row: the property key the value is written under,
 *  the humanized label the card shows, and the type the approved value is
 *  coerced to (Agent-11d). */
export type RowColumn = {
	key: string;
	label: string;
	valueType: ValueType;
};

/** The target-database payload a {@link ProposeKind.Row} artifact carries: which
 *  Collection the row lands in, whether it must be pinned into that
 *  Collection's manual members, and the columns its `fields` are keyed by (the
 *  allowlist `buildRowProposal` filtered against — Agent-11d). */
export type ProposedRow = {
	databaseId: string;
	databaseName: string;
	addToMembers: boolean;
	columns: readonly RowColumn[];
};

/** A staged draft awaiting the user's approval. `id` is host-minted when the
 *  draft is staged; `fields` are already allowlisted + clamped; `summary` is the
 *  primary field value (the card's headline). */
export type ProposedArtifact = {
	id: string;
	kind: ProposeKind;
	entityType: string;
	fields: Record<string, string>;
	summary: string;
	/** Set only for {@link ProposeKind.Row} — the target database + its columns. */
	row?: ProposedRow;
	/** Set only for {@link ProposeKind.Database} — the proposed schema + how
	 *  many seed rows the `fields` cell keys describe (Agent-11e). */
	database?: ProposedDatabase;
};

/** Why a propose call could not be staged (fed back to the model so it can
 *  correct — e.g. supply the missing required field). */
export enum ProposalRejectReason {
	UnknownKind = "unknown-kind",
	MissingPrimary = "missing-primary",
}

export type BuildProposalResult =
	| { ok: true; artifact: ProposedArtifact }
	| { ok: false; reason: ProposalRejectReason };

function clampField(descriptor: ProposeDescriptor, field: string, value: string): string {
	const max = descriptor.longFields.includes(field) ? PROPOSE_LONG_MAX : PROPOSE_SHORT_MAX;
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * Stage a model tool-call into a bounded {@link ProposedArtifact} — the pure
 * heart of the propose path. SECURITY: the fields are built from the DECLARED
 * descriptor's allowlist, not from whatever the model sent — an arg not in
 * `fields` is dropped, non-string values are dropped, every string is clamped,
 * and the required `primaryField` must be a non-empty string or the call is
 * rejected (never a silent empty write). No side effects: nothing is persisted.
 */
export function buildProposal(input: {
	verb: string;
	args: Record<string, unknown>;
	id: string;
}): BuildProposalResult {
	const descriptor = proposeDescriptorForVerb(input.verb);
	if (!descriptor) return { ok: false, reason: ProposalRejectReason.UnknownKind };

	const fields: Record<string, string> = {};
	for (const key of descriptor.fields) {
		const raw = input.args[key];
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (!trimmed) continue;
		fields[key] = clampField(descriptor, key, trimmed);
	}

	const summary = fields[descriptor.primaryField];
	if (!summary) return { ok: false, reason: ProposalRejectReason.MissingPrimary };

	return {
		ok: true,
		artifact: {
			id: input.id,
			kind: descriptor.kind,
			entityType: descriptor.entityType,
			fields,
			summary,
		},
	};
}

/** The result fed back to the model after a propose call. It states plainly
 *  that NOTHING is saved yet — the model must not claim it created the object;
 *  the user still has to approve it (Agent-11b). */
export function buildProposalAck(result: BuildProposalResult): Record<string, unknown> {
	if (!result.ok) return { staged: false, reason: result.reason };
	return {
		staged: true,
		status: "pending-approval",
		kind: result.artifact.kind,
		summary: result.artifact.summary,
		note:
			"Queued for the user's review. It is NOT saved until the user approves it — do not tell the user it is done.",
	};
}

/** System-prompt guidance appended when propose tools are offered, so the model
 *  understands the create tools only STAGE drafts for the user's approval. */
export const PROPOSE_TOOL_GUIDANCE =
	"When you use a propose-* tool you are DRAFTING an item for the user to review, not saving it. " +
	"Never say you have created, saved, or added something — say you have proposed it and ask the user to approve. " +
	"Propose only what the user actually asked for.";

/** The pending-proposal buffer the host holds for a conversation turn. */
export type ProposalState = { pending: readonly ProposedArtifact[] };

export const emptyProposalState: ProposalState = { pending: [] };

/** Reducer actions over the pending buffer. Approval's SIDE EFFECT (the
 *  `entities.create`) lives in the host (Agent-11b); the reducer only manages
 *  the list, so it stays pure. */
export enum ProposalActionKind {
	/** Stage a freshly-built artifact (host-minted id already set). */
	Add = "add",
	/** Merge edited fields into a staged artifact (the user tweaked the card). */
	Edit = "edit",
	/** Drop one staged artifact (the user discarded it). */
	Discard = "discard",
	/** Drop several (post-approval clear of the just-persisted ones). */
	Remove = "remove",
	/** Empty the buffer (new turn / conversation switch). */
	Clear = "clear",
}

export type ProposalAction =
	| { kind: ProposalActionKind.Add; artifact: ProposedArtifact }
	| { kind: ProposalActionKind.Edit; id: string; fields: Record<string, string> }
	| { kind: ProposalActionKind.Discard; id: string }
	| { kind: ProposalActionKind.Remove; ids: readonly string[] }
	| { kind: ProposalActionKind.Clear };

export function proposalReducer(state: ProposalState, action: ProposalAction): ProposalState {
	switch (action.kind) {
		case ProposalActionKind.Add: {
			if (state.pending.some((p) => p.id === action.artifact.id)) return state;
			return { pending: [...state.pending, action.artifact] };
		}
		case ProposalActionKind.Edit: {
			return {
				pending: state.pending.map((p) => {
					if (p.id !== action.id) return p;
					const fields = { ...p.fields, ...action.fields };
					const primaryField = p.row
						? (p.row.columns[0]?.key ?? "")
						: p.database
							? "name"
							: (PROPOSE_DESCRIPTORS.find((d) => d.kind === p.kind)?.primaryField ?? "");
					const summary = primaryField ? (fields[primaryField] ?? p.summary) : p.summary;
					return { ...p, fields, summary };
				}),
			};
		}
		case ProposalActionKind.Discard:
			return { pending: state.pending.filter((p) => p.id !== action.id) };
		case ProposalActionKind.Remove: {
			const drop = new Set(action.ids);
			return { pending: state.pending.filter((p) => !drop.has(p.id)) };
		}
		case ProposalActionKind.Clear:
			return emptyProposalState;
	}
}
