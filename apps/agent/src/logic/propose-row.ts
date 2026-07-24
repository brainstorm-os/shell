/**
 * Agent-11d — the agent proposes a ROW in one of the user's databases.
 *
 * Tier 2 of the propose coverage (11a/11b shipped tier 1: simple entities).
 * Where a note/task/contact has a FIXED field allowlist known at build time, a
 * database row's shape is the user's: each Collection (`List/v1`) carries its
 * own columns, so the allowlist has to be derived from the live vault at
 * offer-time and the model's free text coerced into those columns' types.
 *
 * Everything here is pure: `(vault snapshot) → schemas`, `(schemas, tool args) →
 * a staged draft`. Nothing persists — the row is written only when the human
 * approves the card (`app.tsx`), exactly like every other proposal. That keeps
 * the security posture identical: no model output reaches `entities.create`.
 *
 * SECURITY notes specific to this rung:
 *  - the accepted keys are the RESOLVED database's own columns; anything else
 *    the model sends is dropped (a model can't invent a property to write, and
 *    can't reach a prototype key — the field bag is a null-prototype map);
 *  - a database reference that doesn't resolve, or that resolves ambiguously,
 *    is REFUSED (never a best guess into the wrong database);
 *  - collection names are user free-text that lands in the model's prompt, so
 *    the context block clamps + control-strips them (same treatment as
 *    `vault-data-context.ts`).
 */

import { humanizeKey } from "@brainstorm-os/sdk";
import {
	COLLECTION_TYPE_URL,
	type ColumnSpec,
	type ListSource,
	ListSourceKind,
	ValueType,
	capabilityImplies,
	decideRowCreate,
} from "@brainstorm-os/sdk-types";
import {
	PROPOSE_SHORT_MAX,
	ProposeKind,
	type ProposedArtifact,
	type RowColumn,
} from "./propose-artifacts";

/** The tool verb the model calls to stage a row. */
export const PROPOSE_ROW_VERB = "propose-row";

/** Every row's title column — the Database's own convention for a row's name
 *  (`performRowCreate` seeds `name`), and the proposal's required field. */
export const ROW_PRIMARY_KEY = "name";

const LIST_VIEW_TYPE_URL = "brainstorm/ListView/v1";

/** Databases listed in the model's context block before the tail is collapsed. */
const MAX_DATABASES_RENDERED = 12;
/** Columns named per database in that block. */
const MAX_COLUMNS_RENDERED = 12;
/** Length cap on any user free-text (a collection name) injected into a prompt. */
const MAX_NAME_LENGTH = 60;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** Unix-ms values in a ~30-year window read as dates — mirrors the Database's
 *  `effective-def` inference so the two surfaces agree on what a column IS. */
const TIMESTAMP_MIN = 1_000_000_000_000;
const TIMESTAMP_MAX = 4_000_000_000_000;

/** One database the agent may propose a row into, derived from the vault. */
export type DatabaseSchema = {
	id: string;
	name: string;
	/** The entity type a new row instantiates (the source's type, or the
	 *  generic Object for a manual collection). */
	entityType: string;
	/** Whether the created row must be pinned into the collection's manual
	 *  members to show up (a manual collection has no source to pick it up). */
	addToMembers: boolean;
	columns: RowColumn[];
};

/** The minimal entity shape this module reads (the live vault snapshot). */
export type RowVaultEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
};

export enum RowRejectReason {
	/** No database was named, or the name matched none. */
	UnknownDatabase = "unknown-database",
	/** The name matched more than one database — refuse rather than guess. */
	AmbiguousDatabase = "ambiguous-database",
	/** The row carried no title. */
	MissingPrimary = "missing-primary",
}

export type BuildRowResult =
	| { ok: true; artifact: ProposedArtifact }
	| { ok: false; reason: RowRejectReason };

function cleanName(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	return cleaned.length > MAX_NAME_LENGTH
		? `${cleaned.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…`
		: cleaned;
}

function inferValueType(sample: unknown): ValueType | null {
	if (typeof sample === "number") {
		return Number.isFinite(sample) && sample >= TIMESTAMP_MIN && sample <= TIMESTAMP_MAX
			? ValueType.Date
			: ValueType.Number;
	}
	if (typeof sample === "boolean") return ValueType.Boolean;
	if (typeof sample === "string" && sample.trim()) return ValueType.Text;
	return null;
}

/** The columns a Collection's default view declares: visible, non-computed
 *  (a rollup / formula column has no backing property — nothing to write). */
function columnKeysFromView(view: RowVaultEntity | undefined): string[] {
	const specs = Array.isArray(view?.properties.columns)
		? (view.properties.columns as ColumnSpec[])
		: [];
	return specs
		.filter((spec) => spec && typeof spec.propertyId === "string")
		.filter((spec) => spec.visible !== false && !spec.rollup && !spec.formula)
		.map((spec) => spec.propertyId);
}

/** Existing rows of a database — the samples column types are inferred from.
 *  A typed source's rows ARE its type; a manual collection's are its pinned
 *  members. (Filter/link sources aren't evaluated here: the Database owns that
 *  engine, and a row proposed into one is created as a generic Object + pinned,
 *  so its columns still come from the view.) */
function sampleRows(
	list: RowVaultEntity,
	source: ListSource | null,
	byId: Map<string, RowVaultEntity>,
	byType: Map<string, RowVaultEntity[]>,
): RowVaultEntity[] {
	if (source && source.kind === ListSourceKind.ByType && source.types[0]) {
		return byType.get(source.types[0]) ?? [];
	}
	const members = list.properties.members as { include?: { entityId?: string }[] } | undefined;
	const rows: RowVaultEntity[] = [];
	for (const entry of members?.include ?? []) {
		const row = entry?.entityId ? byId.get(entry.entityId) : undefined;
		if (row) rows.push(row);
	}
	return rows;
}

/**
 * Derive every database the agent may propose a row into from the live vault
 * snapshot. Pure — no service calls: the app already subscribes to the snapshot
 * (it holds `entities.read:*`), so this adds no read surface.
 */
export function databaseSchemasFromEntities(entities: readonly RowVaultEntity[]): DatabaseSchema[] {
	const lists: RowVaultEntity[] = [];
	const viewsByList = new Map<string, RowVaultEntity[]>();
	const byId = new Map<string, RowVaultEntity>();
	const byType = new Map<string, RowVaultEntity[]>();
	for (const entity of entities) {
		byId.set(entity.id, entity);
		if (entity.type === COLLECTION_TYPE_URL) {
			lists.push(entity);
			continue;
		}
		if (entity.type === LIST_VIEW_TYPE_URL) {
			const listId = typeof entity.properties.listId === "string" ? entity.properties.listId : "";
			if (listId) viewsByList.set(listId, [...(viewsByList.get(listId) ?? []), entity]);
			continue;
		}
		byType.set(entity.type, [...(byType.get(entity.type) ?? []), entity]);
	}

	const schemas: DatabaseSchema[] = [];
	for (const list of lists) {
		const name = cleanName(list.properties.name);
		if (!name) continue;
		const source = (list.properties.source as ListSource | null) ?? null;
		const plan = decideRowCreate({ source });
		const views = viewsByList.get(list.id) ?? [];
		const defaultViewId =
			typeof list.properties.defaultViewId === "string" ? list.properties.defaultViewId : null;
		const view = views.find((v) => v.id === defaultViewId) ?? views[0];

		const keys = [ROW_PRIMARY_KEY, ...columnKeysFromView(view)];
		const rows = sampleRows(list, source, byId, byType);
		const columns: RowColumn[] = [];
		const seen = new Set<string>();
		for (const key of keys) {
			if (seen.has(key)) continue;
			seen.add(key);
			let valueType: ValueType | null = null;
			for (const row of rows) {
				valueType = inferValueType(row.properties[key]);
				if (valueType) break;
			}
			columns.push({ key, label: humanizeKey(key), valueType: valueType ?? ValueType.Text });
		}
		schemas.push({
			id: list.id,
			name,
			entityType: plan.type,
			addToMembers: plan.addToMembers,
			columns,
		});
	}
	return schemas;
}

export type ResolveDatabaseResult =
	| { ok: true; schema: DatabaseSchema }
	| { ok: false; reason: RowRejectReason };

/**
 * Resolve the model's database reference: an exact id first, then an exact
 * (case-insensitive) name. A reference matching several databases is REFUSED —
 * writing into the wrong one of two same-named collections is worse than asking
 * the model to be specific.
 */
export function resolveDatabase(
	schemas: readonly DatabaseSchema[],
	reference: unknown,
): ResolveDatabaseResult {
	const ref = typeof reference === "string" ? reference.trim() : "";
	if (!ref) return { ok: false, reason: RowRejectReason.UnknownDatabase };
	const byId = schemas.find((s) => s.id === ref);
	if (byId) return { ok: true, schema: byId };
	const lower = ref.toLowerCase();
	const named = schemas.filter((s) => s.name.toLowerCase() === lower);
	if (named.length > 1) return { ok: false, reason: RowRejectReason.AmbiguousDatabase };
	const first = named[0];
	if (!first) return { ok: false, reason: RowRejectReason.UnknownDatabase };
	return { ok: true, schema: first };
}

/** The model's value bag: `{ values: { … } }` when it follows the tool label,
 *  or the args themselves when it flattens them (both shapes are common). */
function valueBagOf(args: Record<string, unknown>): Record<string, unknown> {
	const nested = args.values;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		return nested as Record<string, unknown>;
	}
	return args;
}

/**
 * Stage a `propose-row` tool call into a bounded {@link ProposedArtifact}.
 * The accepted keys are the resolved database's own columns (matched by key or
 * by humanized label); every other key the model sent is dropped, non-string
 * values are dropped, and each value is clamped. A row with no title is
 * refused so an approval can never write a blank object.
 */
export function buildRowProposal(input: {
	verb: string;
	args: Record<string, unknown>;
	id: string;
	schemas: readonly DatabaseSchema[];
}): BuildRowResult {
	const resolved = resolveDatabase(input.schemas, input.args.database ?? input.args.db);
	if (!resolved.ok) return resolved;
	const schema = resolved.schema;

	const byName = new Map<string, RowColumn>();
	for (const column of schema.columns) {
		byName.set(column.key.toLowerCase(), column);
		byName.set(column.label.toLowerCase(), column);
	}

	const bag = valueBagOf(input.args);
	const fields: Record<string, string> = Object.create(null);
	for (const [rawKey, rawValue] of Object.entries(bag)) {
		if (typeof rawValue !== "string") continue;
		const column = byName.get(rawKey.trim().toLowerCase());
		if (!column) continue;
		const trimmed = rawValue.trim();
		if (!trimmed) continue;
		fields[column.key] =
			trimmed.length > PROPOSE_SHORT_MAX ? trimmed.slice(0, PROPOSE_SHORT_MAX) : trimmed;
	}

	const summary = fields[ROW_PRIMARY_KEY];
	if (!summary) return { ok: false, reason: RowRejectReason.MissingPrimary };

	return {
		ok: true,
		artifact: {
			id: input.id,
			kind: ProposeKind.Row,
			entityType: schema.entityType,
			fields: { ...fields },
			summary,
			row: {
				databaseId: schema.id,
				databaseName: schema.name,
				addToMembers: schema.addToMembers,
				columns: schema.columns,
			},
		},
	};
}

/** The ack fed back to the model after a row proposal — same contract as the
 *  other propose tools: staged, NOT saved. */
export function buildRowProposalAck(result: BuildRowResult): Record<string, unknown> {
	if (!result.ok) return { staged: false, reason: result.reason };
	return {
		staged: true,
		status: "pending-approval",
		kind: ProposeKind.Row,
		database: result.artifact.row?.databaseName ?? "",
		summary: result.artifact.summary,
		note:
			"Queued for the user's review. It is NOT saved until the user approves it — do not tell the user it is done.",
	};
}

/**
 * The context block naming the user's databases + their columns, so the model
 * can target one by name and fill the right columns. Empty when the vault has
 * no databases (the tool then always refuses, and the model is told nothing).
 */
export function buildDatabaseContextBlock(schemas: readonly DatabaseSchema[]): string {
	if (schemas.length === 0) return "";
	const lines: string[] = [
		"## Databases you can add rows to",
		`Use ${PROPOSE_ROW_VERB} with the database's exact name and one value per column.`,
	];
	for (const schema of schemas.slice(0, MAX_DATABASES_RENDERED)) {
		const columns = schema.columns.slice(0, MAX_COLUMNS_RENDERED);
		const rendered = columns.map((c) => `${c.key} (${c.valueType})`).join(", ");
		const extra = schema.columns.length - columns.length;
		lines.push(`- ${schema.name}: ${rendered}${extra > 0 ? `, and ${extra} more` : ""}`);
	}
	const more = schemas.length - MAX_DATABASES_RENDERED;
	if (more > 0) lines.push(`- and ${more} more database${more === 1 ? "" : "s"}.`);
	return lines.join("\n");
}

/** The `entities.write:<type>` cap an approved row in this database exercises. */
export function rowWriteCapabilityFor(schema: DatabaseSchema): string {
	return `entities.write:${schema.entityType}`;
}

/**
 * Fail-closed at OFFER time: keep only the databases whose row type the app can
 * actually write (and, for a manual collection, whose membership it can patch).
 * A typed database over a type the manifest doesn't grant is dropped from the
 * schemas entirely — so the model is never told about a database whose rows
 * would be denied at the moment the user approves them.
 */
export function writableDatabaseSchemas(
	schemas: readonly DatabaseSchema[],
	capabilities: readonly string[],
): DatabaseSchema[] {
	const holds = (required: string): boolean =>
		capabilities.some((held) => capabilityImplies(held, required));
	return schemas.filter(
		(schema) =>
			holds(rowWriteCapabilityFor(schema)) &&
			(!schema.addToMembers || holds(`entities.write:${COLLECTION_TYPE_URL}`)),
	);
}
