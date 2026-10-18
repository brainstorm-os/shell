import {
	LIST_ENTITY_TYPE,
	LIST_VIEW_ENTITY_TYPE,
	listToEntityProperties,
	listViewToEntityProperties,
} from "@brainstorm-os/sdk";
import { describe, expect, it } from "vitest";
import { ChartType, type ListView, ListViewKind } from "../types/list-view";
import { chartWidgetCatalog, chartWidgetModel, chartWidgetViewLabel } from "./chart-widget-data";

const VIEW: ListView = {
	id: "view_chart",
	listId: "list_1",
	name: "By status",
	icon: null,
	kind: ListViewKind.Chart,
	filters: null,
	sorts: [],
	groupBy: { propertyId: "status" },
	coverProperty: null,
	cardSubtitleProperty: null,
	columns: [],
	defaultTypeUrl: null,
	defaultTemplate: null,
	pageSize: 50,
	layoutOptions: { chartType: ChartType.Bar, aggregation: "countAll", valueProperty: null },
};

function ent(id: string, type: string, properties: Record<string, unknown>) {
	return { id, type, properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

const SNAPSHOT = {
	entities: [
		ent("list_1", LIST_ENTITY_TYPE, {
			...listToEntityProperties({
				id: "list_1",
				name: "Deals",
				icon: null,
				description: "",
				source: null,
				members: {
					include: [
						{ entityId: "a", addedAt: 0, by: "user" as const },
						{ entityId: "b", addedAt: 0, by: "user" as const },
					],
					exclude: [],
				},
				views: ["view_chart"],
				defaultViewId: "view_chart",
				defaultTemplate: null,
				createdAt: 0,
				updatedAt: 0,
			}),
		}),
		ent("view_chart", LIST_VIEW_ENTITY_TYPE, { ...listViewToEntityProperties(VIEW) }),
		ent("a", "io.test/Deal/v1", { status: "won" }),
		ent("b", "io.test/Deal/v1", { status: "lost" }),
		ent("c", "io.test/Deal/v1", { status: "won" }),
	],
	links: [],
};

describe("chart widget data (9.12.30)", () => {
	it("lists entity-backed chart views and charts the list's members only", () => {
		const catalog = chartWidgetCatalog(SNAPSHOT);
		expect(catalog.views.map((v) => v.id)).toEqual(["view_chart"]);
		expect(chartWidgetViewLabel(catalog, catalog.views[0] as ListView)).toBe("Deals · By status");
		const model = chartWidgetModel(catalog, catalog.views[0] as ListView, {
			empty: "-",
			other: "Other",
			all: "All",
		});
		expect(model?.total.value).toBe(2);
		expect(model?.data.map((d) => [d.key, d.value])).toEqual([
			["won", 1],
			["lost", 1],
		]);
	});
});
