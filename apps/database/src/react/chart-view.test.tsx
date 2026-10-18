// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregationKind, AggregationUnit } from "../logic/aggregations";
import type { ChartModel } from "../logic/chart-data";
import { ChartType } from "../types/list-view";
import { ChartView, type ChartViewProps } from "./chart-view";

const MODEL: ChartModel = {
	kind: AggregationKind.CountAll,
	total: { kind: AggregationKind.CountAll, value: 5, unit: AggregationUnit.Count },
	data: [
		{ key: "todo", label: "Todo", value: 3, count: 3, color: "var(--color-graph-subject-3)" },
		{ key: "done", label: "Done", value: 2, count: 2, color: "var(--color-graph-subject-1)" },
	],
};

let root: Root | null = null;
function mount(props: Partial<ChartViewProps>): HTMLElement {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
		root?.render(
			<ChartView
				model={MODEL}
				chartType={ChartType.Bar}
				valueName={null}
				groupName="Status"
				showTable={false}
				{...props}
			/>,
		),
	);
	return host;
}

afterEach(() => {
	act(() => root?.unmount());
	document.body.replaceChildren();
});

describe("ChartView (9.12.30)", () => {
	it("draws one labelled bar per group with an accessible summary", () => {
		const host = mount({});
		const svg = host.querySelector('svg[role="img"]');
		expect(svg?.getAttribute("aria-label")).toBe("Count by Status. Todo: 3; Done: 2");
		expect(host.querySelectorAll(".dbv-chart__mark").length).toBe(2);
		expect(host.querySelector(".dbv-chart__title")?.textContent).toBe("Count by Status");
	});

	it("swaps in the data table via the toggle", () => {
		const onToggleTable = vi.fn();
		const host = mount({ onToggleTable });
		act(() =>
			host.querySelector<HTMLButtonElement>('[data-testid="dbv-chart-table-toggle"]')?.click(),
		);
		expect(onToggleTable).toHaveBeenCalledWith(true);
		const tableHost = mount({ showTable: true, onToggleTable });
		const rows = tableHost.querySelectorAll('[data-testid="dbv-chart-table"] tbody tr');
		expect([...rows].map((r) => r.textContent)).toEqual(["Todo3", "Done2"]);
	});

	it("names every pie slice in a legend, never colour alone", () => {
		const host = mount({ chartType: ChartType.Pie });
		const items = [...host.querySelectorAll(".dbv-chart__legend-item")].map((li) => li.textContent);
		expect(items).toEqual(["Todo3", "Done2"]);
		expect(host.querySelectorAll(".dbv-chart__slice").length).toBe(2);
	});

	it("renders the total as a hero number", () => {
		const host = mount({ chartType: ChartType.Number });
		expect(host.querySelector(".dbv-chart__hero-value")?.textContent).toBe("5");
	});

	it("draws a line with a marker per point", () => {
		const host = mount({ chartType: ChartType.Line });
		expect(host.querySelectorAll(".dbv-chart__dot").length).toBe(2);
		expect(host.querySelector("path")).not.toBeNull();
	});
});
