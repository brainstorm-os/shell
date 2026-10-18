import { describe, expect, it } from "vitest";
import {
	CalendarRange,
	CalendarWeekStart,
	ChartType,
	CompositeOp,
	EmptyPlacement,
	IconKind,
	type LayoutOptions,
	LinkDirection,
	type List,
	type ListSource,
	ListSourceKind,
	type ListView,
	ListViewKind,
	SortDirection,
	TimelineDensity,
	TimelineMode,
} from "./index";
import * as list from "./list";

describe("list/source/view enums (wire format — values ARE the on-disk strings)", () => {
	it("ListSourceKind maps to its persisted discriminator strings", () => {
		expect(ListSourceKind.ByType).toBe("byType");
		expect(ListSourceKind.ByFilter).toBe("byFilter");
		expect(ListSourceKind.ByLink).toBe("byLink");
		expect(ListSourceKind.ByVocabulary).toBe("byVocabulary");
		expect(ListSourceKind.Composite).toBe("composite");
	});

	it("ListViewKind maps to the seven canonical kinds", () => {
		expect(Object.values(ListViewKind)).toEqual([
			"grid",
			"list",
			"gallery",
			"board",
			"calendar",
			"timeline",
			"chart",
		]);
	});

	it("SortDirection / EmptyPlacement / LinkDirection / CompositeOp map to wire strings", () => {
		expect(SortDirection.Asc).toBe("asc");
		expect(SortDirection.Manual).toBe("manual");
		expect(EmptyPlacement.End).toBe("end");
		expect(LinkDirection.In).toBe("in");
		expect(CompositeOp.Or).toBe("or");
	});

	it("CalendarRange / CalendarWeekStart / TimelineDensity / TimelineMode map to wire strings", () => {
		expect(CalendarRange.Month).toBe("month");
		expect(CalendarWeekStart.Monday).toBe("mon");
		expect(TimelineDensity.Comfortable).toBe("comfortable");
		expect(TimelineMode.Span).toBe("span");
	});

	it("the barrel re-export is the same enum object as the leaf module", () => {
		expect(ListViewKind).toBe(list.ListViewKind);
		expect(ListSourceKind).toBe(list.ListSourceKind);
		expect(SortDirection).toBe(list.SortDirection);
	});
});

describe("canonical List / ListSource / ListView shapes", () => {
	it("composes a byType List with a Board ListView (the SH-8 seed shape)", () => {
		const source: ListSource = {
			kind: ListSourceKind.ByType,
			types: ["brainstorm/Task/v1"],
		};
		const view: ListView = {
			id: "v1",
			listId: "l1",
			name: "By stage",
			icon: { kind: IconKind.Emoji, value: "📚" },
			kind: ListViewKind.Board,
			filters: null,
			sorts: [
				{ propertyId: "name", direction: SortDirection.Asc, emptyPlacement: EmptyPlacement.End },
			],
			groupBy: { propertyId: "projectId" },
			coverProperty: null,
			cardSubtitleProperty: "statusKey",
			columns: [{ propertyId: "name", visible: true }],
			defaultTypeUrl: null,
			defaultTemplate: null,
			pageSize: 100,
			layoutOptions: { columnWidth: 320, collapseEmptyColumns: false, cardPreview: "rich" },
		};
		const l: List = {
			id: "l1",
			name: "Plan",
			icon: null,
			description: "",
			source,
			members: { include: [], exclude: [] },
			views: [view.id],
			defaultViewId: view.id,
			defaultTemplate: null,
			createdAt: 0,
			updatedAt: 0,
		};
		expect(l.source?.kind).toBe("byType");
		expect(view.filters).toBeNull();
		expect(view.kind).toBe("board");
	});

	it("every ListViewKind has a constructible LayoutOptions member", () => {
		const layouts: Record<ListViewKind, LayoutOptions> = {
			[ListViewKind.Chart]: { chartType: ChartType.Bar, aggregation: "countAll", valueProperty: null },
			[ListViewKind.Grid]: {
				rowHeight: "comfortable",
				showRowNumbers: false,
				pinFirstColumn: true,
			},
			[ListViewKind.List]: { density: "comfortable", showIcon: true },
			[ListViewKind.Gallery]: {
				thumbnailSize: "medium",
				cardAspectRatio: "portrait",
				showFilename: false,
			},
			[ListViewKind.Board]: {
				columnWidth: 320,
				collapseEmptyColumns: false,
				cardPreview: "rich",
			},
			[ListViewKind.Calendar]: {
				range: CalendarRange.Month,
				startWeekOn: CalendarWeekStart.Monday,
				primaryDateProperty: "completedAt",
				colorBy: "statusKey",
			},
			[ListViewKind.Timeline]: {
				primaryDateProperty: "completedAt",
				endDateProperty: null,
				swimlaneBy: "projectId",
				pxPerDay: 16,
				showNow: true,
				showWeekends: true,
				dependencyLinkTypes: [],
				showDependencies: false,
				density: TimelineDensity.Comfortable,
				colorBy: "statusKey",
				labelProperty: "name",
			},
		};
		expect(Object.keys(layouts)).toHaveLength(7);
	});

	it("supports the composite + by-link + by-vocabulary source variants", () => {
		const composite: ListSource = {
			kind: ListSourceKind.Composite,
			op: CompositeOp.And,
			sources: [
				{ kind: ListSourceKind.ByType, types: ["brainstorm/Task/v1"] },
				{
					kind: ListSourceKind.ByLink,
					linkType: "blocks",
					direction: LinkDirection.Out,
					anchorEntityId: "ent_1",
				},
				{ kind: ListSourceKind.ByVocabulary, vocabularyId: "dict-status" },
			],
		};
		expect(composite.kind).toBe("composite");
		if (composite.kind === ListSourceKind.Composite) {
			expect(composite.sources).toHaveLength(3);
		}
	});
});
