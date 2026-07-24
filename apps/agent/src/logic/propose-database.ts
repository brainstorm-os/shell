/**
 * Agent-11e — the agent proposes a NEW database (Collection + its columns +
 * seed rows), as ONE reviewable two-part proposal: the schema it inferred, and
 * the rows it would seed it with.
 *
 * Coverage tier 3, and the only propose kind whose approval creates more than
 * one entity: a `List/v1`, its default `ListView/v1` (the Grid the Database app
 * renders), and one generic `Object/v1` per seed row pinned into the list's
 * members. The multi-entity write still happens ONLY on the human approve
 * gesture (`propose-database-persist.ts`) — this module is pure staging.
 *
 * SECURITY: the model supplies free text; nothing here is trusted as an
 * identifier. Column names become slugged keys (never a caller-chosen property
 * path), a cell whose column wasn't declared is dropped, structured values are
 * dropped, every string is clamped, and both the column and row counts are
 * capped so one tool call can't stage an unbounded table. The database name is
 * control-stripped + clamped (it lands in the model's own context block next
 * turn) and uniquified against the vault's existing collections so an approval
 * can never quietly shadow a collection the user already has.
 */

import { humanizeKey, uniqueName } from "@brainstorm-os/sdk";
import { ValueType } from "@brainstorm-os/sdk-types";
import {
	PROPOSE_SHORT_MAX,
	ProposeKind,
	type ProposedArtifact,
	type RowColumn,
} from "./propose-artifacts";
import { ROW_PRIMARY_KEY } from "./propose-row";

/** The tool verb the model calls to stage a new database. */
export const PROPOSE_DATABASE_VERB = "propose-database";

/** Caps — a staged proposal must stay reviewable in the tray AND bounded as a
 *  write (approval creates one entity per row). */
export const DATABASE_MAX_COLUMNS = 12;
export const DATABASE_MAX_ROWS = 10;
/** Length cap on the database name (user-visible + re-enters the prompt). */
const DATABASE_NAME_MAX = 60;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** The type words models actually emit → the value types the Database renders.
 *  Anything unrecognised is Text (the safe, always-renderable default). */
const TYPE_WORDS: Readonly<Record<string, ValueType>> = {
	text: ValueType.Text,
	string: ValueType.Text,
	str: ValueType.Text,
	select: ValueType.Text,
	url: ValueType.Text,
	email: ValueType.Text,
	number: ValueType.Number,
	numeric: ValueType.Number,
	int: ValueType.Number,
	integer: ValueType.Number,
	float: ValueType.Number,
	decimal: ValueType.Number,
	currency: ValueType.Number,
	money: ValueType.Number,
	percent: ValueType.Number,
	boolean: ValueType.Boolean,
	bool: ValueType.Boolean,
	checkbox: ValueType.Boolean,
	date: ValueType.Date,
	datetime: ValueType.Date,
	timestamp: ValueType.Date,
	time: ValueType.Date,
};

export enum DatabaseRejectReason {
	/** The proposal carried no usable database name. */
	MissingName = "missing-name",
}

/** The staged schema + row count a {@link ProposeKind.Database} artifact
 *  carries. The row CELLS live in the artifact's `fields` under
 *  {@link rowCellKey} so the existing edit reducer + card inputs work
 *  unchanged; `rowCount` says how many rows those keys describe. */
export type ProposedDatabase = {
	columns: readonly RowColumn[];
	rowCount: number;
};

export type BuildDatabaseResult =
	| { ok: true; artifact: ProposedArtifact }
	| { ok: false; reason: DatabaseRejectReason };

/** The `fields` key one seed-row cell is staged under (`r0.amount`). Exported
 *  because the card, the reducer and the persist step all address cells by it. */
export function rowCellKey(index: number, columnKey: string): string {
	return `r${index}.${columnKey}`;
}

function cleanText(raw: unknown, max: number): string {
	if (typeof raw !== "string") return "";
	const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

/** Slug a model-supplied column name into a property key: `Deal size` →
 *  `dealSize`. Never a caller-chosen path — the key is derived, so a column
 *  can't be named to collide with an entity's own metadata spelling. */
function columnKeyFor(name: string): string {
	const words = name
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) return "";
	const [first = "", ...rest] = words;
	return (
		first.toLowerCase() +
		rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("")
	);
}

function valueTypeFor(raw: unknown): ValueType {
	if (typeof raw !== "string") return ValueType.Text;
	return TYPE_WORDS[raw.trim().toLowerCase()] ?? ValueType.Text;
}

/** Normalise the model's `columns` arg — `[{name, type}]` or `["Name", …]` —
 *  into real columns, title column first, deduped and capped. */
function columnsFrom(raw: unknown): RowColumn[] {
	const columns: RowColumn[] = [
		{ key: ROW_PRIMARY_KEY, label: humanizeKey(ROW_PRIMARY_KEY), valueType: ValueType.Text },
	];
	const seen = new Set([ROW_PRIMARY_KEY]);
	if (!Array.isArray(raw)) return columns;
	for (const entry of raw) {
		const name = cleanText(
			typeof entry === "string" ? entry : (entry as { name?: unknown })?.name,
			PROPOSE_SHORT_MAX,
		);
		const key = columnKeyFor(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		columns.push({
			key,
			label: name,
			valueType: valueTypeFor(
				typeof entry === "string" ? undefined : (entry as { type?: unknown })?.type,
			),
		});
		if (columns.length >= DATABASE_MAX_COLUMNS) break;
	}
	return columns;
}

/** A model cell is a string, or a scalar we can render as one. Objects /
 *  arrays are dropped — a row cell is a single value, never a structure. */
function cellText(raw: unknown): string {
	if (typeof raw === "string") return raw.trim().slice(0, PROPOSE_SHORT_MAX);
	if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
	if (typeof raw === "boolean") return String(raw);
	return "";
}

/**
 * Stage a `propose-database` tool call into a bounded {@link ProposedArtifact}.
 * `existing` is the vault's current collections — the staged name is uniquified
 * against them, so approving never produces two collections with one name.
 */
export function buildDatabaseProposal(input: {
	verb: string;
	args: Record<string, unknown>;
	id: string;
	existing: ReadonlyArray<{ name: string }>;
}): BuildDatabaseResult {
	const requested = cleanText(input.args.name ?? input.args.database, DATABASE_NAME_MAX);
	if (!requested) return { ok: false, reason: DatabaseRejectReason.MissingName };
	const name = uniqueName(requested, input.existing);

	const columns = columnsFrom(input.args.columns);
	const byName = new Map<string, RowColumn>();
	for (const column of columns) {
		byName.set(column.key.toLowerCase(), column);
		byName.set(column.label.toLowerCase(), column);
	}

	const fields: Record<string, string> = Object.create(null);
	fields[ROW_PRIMARY_KEY] = name;

	const rawRows = Array.isArray(input.args.rows) ? input.args.rows : [];
	let rowCount = 0;
	for (const rawRow of rawRows.slice(0, DATABASE_MAX_ROWS)) {
		if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) continue;
		const index = rowCount;
		for (const [rawKey, rawValue] of Object.entries(rawRow as Record<string, unknown>)) {
			const column = byName.get(rawKey.trim().toLowerCase());
			if (!column) continue;
			const text = cellText(rawValue);
			if (!text) continue;
			fields[rowCellKey(index, column.key)] = text;
		}
		rowCount += 1;
	}

	return {
		ok: true,
		artifact: {
			id: input.id,
			kind: ProposeKind.Database,
			// The Collection type itself — the row entities the approval also
			// creates are generic Objects (see the persist step).
			entityType: "brainstorm/List/v1",
			fields: { ...fields },
			summary: name,
			database: { columns, rowCount },
		},
	};
}

/** The ack fed back to the model — staged, NOT saved, same as every propose
 *  tool. Names what was kept so the model can see its caps were applied. */
export function buildDatabaseProposalAck(result: BuildDatabaseResult): Record<string, unknown> {
	if (!result.ok) return { staged: false, reason: result.reason };
	return {
		staged: true,
		status: "pending-approval",
		kind: ProposeKind.Database,
		name: result.artifact.summary,
		columns: result.artifact.database?.columns.map((column) => column.key) ?? [],
		rows: result.artifact.database?.rowCount ?? 0,
		note:
			"Queued for the user's review. It is NOT saved until the user approves it — do not tell the user it is done.",
	};
}
