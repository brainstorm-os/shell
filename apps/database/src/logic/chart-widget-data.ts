/**
 * Data for the Database "Chart" dashboard widget (9.12.30): every Chart view
 * the vault holds (entity-backed `ListView/v1`s), and the chart model for the
 * chosen one, resolved from the widget's live vault snapshot the same way the
 * app resolves a List — `(source ∪ include) \ exclude`, then the view's
 * filter / sort / group-by — and reduced by the shared `buildChartModel`.
 *
 * Widget limits by design: a vault-derived list's per-device view overrides
 * live in the app's kv, not the vault, so only entity-backed views appear.
 */

import {
	LIST_ENTITY_TYPE,
	LIST_VIEW_ENTITY_TYPE,
	entityToList,
	entityToListView,
} from "@brainstorm-os/sdk";
import {
	type ChartLayoutOptions,
	ChartType,
	type Entity,
	type List,
	type ListView,
	ListViewKind,
} from "@brainstorm-os/sdk-types";
import { resolveEntityTitle } from "@brainstorm-os/sdk/entity-title";
import { type ChartModel, buildChartModel } from "./chart-data";
import { compileMembership } from "./compile-membership";
import { compileView } from "./compile-view";
import type { InMemoryEntities } from "./in-memory-entities";
import { type VaultSnapshotInput, buildVaultLists } from "./vault-lists";

export type ChartWidgetCatalog = {
	db: InMemoryEntities;
	lists: ReadonlyArray<List>;
	views: ReadonlyArray<ListView>;
};

export function chartWidgetCatalog(snapshot: VaultSnapshotInput): ChartWidgetCatalog {
	const built = buildVaultLists(snapshot);
	const asEntity = (e: VaultSnapshotInput["entities"][number]): Entity => e as unknown as Entity;
	const entityLists = snapshot.entities
		.filter((e) => e.type === LIST_ENTITY_TYPE && e.deletedAt == null)
		.map((e) => entityToList(asEntity(e)))
		.filter((l): l is List => l !== null);
	const views = snapshot.entities
		.filter((e) => e.type === LIST_VIEW_ENTITY_TYPE && e.deletedAt == null)
		.map((e) => entityToListView(asEntity(e)))
		.filter((v): v is ListView => v !== null && v.kind === ListViewKind.Chart);
	return { db: built.db, lists: [...built.lists, ...entityLists], views };
}

export function chartWidgetModel(
	catalog: ChartWidgetCatalog,
	view: ListView,
	labels: { empty: string; other: string; all: string },
): ChartModel | null {
	const list = catalog.lists.find((l) => l.id === view.listId);
	if (!list) return null;
	const members = compileMembership(list, catalog.db);
	const rows = catalog.db.entities.filter((e) => members.has(e.id));
	const byId = new Map(catalog.db.entities.map((e) => [e.id, e] as const));
	const compiled = compileView(view, rows, (key) => {
		const ref = byId.get(key);
		return ref ? (resolveEntityTitle(ref.properties) ?? undefined) : undefined;
	});
	const layout = view.layoutOptions as ChartLayoutOptions;
	return buildChartModel(
		compiled,
		layout.chartType ?? ChartType.Bar,
		layout.aggregation ?? "",
		layout.valueProperty ?? null,
		labels,
	);
}

export function chartWidgetViewLabel(catalog: ChartWidgetCatalog, view: ListView): string {
	const list = catalog.lists.find((l) => l.id === view.listId);
	return list ? `${list.name} · ${view.name}` : view.name;
}
