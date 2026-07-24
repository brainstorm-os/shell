/**
 * Agent-11e — the approval half of a proposed NEW database: turn the staged
 * schema + seed rows into the entities the Database app renders.
 *
 * Write order is deliberate — **rows → view → Collection**:
 *  - the rows are plain generic Objects, so a partial failure leaves objects,
 *    not a broken collection;
 *  - the Collection is created LAST and lands complete (its `views`,
 *    `defaultViewId` and `members` already filled in), so there is no
 *    second "fix up the membership" write and no window where the user sees
 *    an empty database that is about to fill.
 *
 * Ids for the Collection + its view are minted here (the entities service
 * honours a caller-supplied id) because the two reference each other; the row
 * ids come back from the service. Everything is created through the SDK codecs
 * (`listToEntityProperties` / `listViewToEntityProperties`) so the shapes match
 * what the Database app reads back — no hand-rolled property bags.
 *
 * SECURITY: runs ONLY from the human approve gesture in `app.tsx`, like every
 * other proposal. The properties written are the proposal's own columns; each
 * cell is coerced to its column's type, and an uncoercible cell is omitted.
 */

import {
	LIST_ENTITY_TYPE,
	LIST_VIEW_ENTITY_TYPE,
	listToEntityProperties,
	listViewToEntityProperties,
} from "@brainstorm-os/sdk";
import {
	GENERIC_OBJECT_TYPE,
	type List,
	type ListView,
	ListViewKind,
	coerceScalarValue,
} from "@brainstorm-os/sdk-types";
import type { ProposedArtifact } from "./propose-artifacts";
import { rowCellKey } from "./propose-database";
import type { ProposalEntitiesService } from "./propose-persist";

/** Grid column widths the Database app itself seeds a new list with. */
const TITLE_COLUMN_WIDTH = 280;
const COLUMN_WIDTH = 160;
const DEFAULT_PAGE_SIZE = 50;

export type PersistedDatabase = { listId: string; viewId: string; rowIds: string[] };

/** Mint an id for an entity this approval creates. Prefixed like the Database
 *  app's own (`list_…` / `view_…`) so the ids read the same in the vault. */
function mintId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Create a proposed database: its seed rows, its Grid view, then the
 * Collection itself. Returns the ids so the caller can surface / open them.
 */
export async function persistProposedDatabase(
	entities: ProposalEntitiesService,
	artifact: ProposedArtifact,
	context: { conversationId: string | null; now: number },
): Promise<PersistedDatabase | null> {
	const schema = artifact.database;
	if (!schema) return null;
	const provenance = context.conversationId ? { conversationId: context.conversationId } : undefined;

	const rowIds: string[] = [];
	for (let index = 0; index < schema.rowCount; index++) {
		const properties: Record<string, unknown> = {
			createdAt: context.now,
			updatedAt: context.now,
		};
		for (const column of schema.columns) {
			const value = coerceScalarValue(
				artifact.fields[rowCellKey(index, column.key)],
				column.valueType,
			);
			if (value !== undefined) properties[column.key] = value;
		}
		const created = await entities.create(GENERIC_OBJECT_TYPE, properties, undefined, provenance);
		if (created?.id) rowIds.push(created.id);
	}

	const listId = mintId("list");
	const viewId = mintId("view");

	const view: ListView = {
		id: viewId,
		listId,
		name: "Grid",
		icon: null,
		kind: ListViewKind.Grid,
		filters: null,
		sorts: [],
		groupBy: null,
		coverProperty: null,
		cardSubtitleProperty: null,
		columns: schema.columns.map((column, i) => ({
			propertyId: column.key,
			width: i === 0 ? TITLE_COLUMN_WIDTH : COLUMN_WIDTH,
			visible: true,
		})),
		defaultTypeUrl: null,
		defaultTemplate: null,
		pageSize: DEFAULT_PAGE_SIZE,
		layoutOptions: { rowHeight: "comfortable", showRowNumbers: false, pinFirstColumn: true },
	};
	await entities.create(LIST_VIEW_ENTITY_TYPE, listViewToEntityProperties(view), viewId, provenance);

	// A manual collection: no source to evaluate, membership IS the row set.
	const list: List = {
		id: listId,
		name: artifact.summary,
		icon: null,
		description: "",
		source: null,
		members: {
			include: rowIds.map((entityId) => ({
				entityId,
				addedAt: context.now,
				by: "app:io.brainstorm.agent" as const,
			})),
			exclude: [],
		},
		views: [viewId],
		defaultViewId: viewId,
		defaultTemplate: null,
		createdAt: context.now,
		updatedAt: context.now,
	};
	await entities.create(LIST_ENTITY_TYPE, listToEntityProperties(list), listId, provenance);

	return { listId, viewId, rowIds };
}
