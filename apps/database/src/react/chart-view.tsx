/**
 * Chart view (9.12.30) — the group-by × aggregation engine drawn as a bar,
 * line or pie chart, or a single headline number. Pure SVG + React; the data
 * shape comes from `logic/chart-data` so the dashboard widget renders the
 * same model.
 *
 * Accessibility: the plot is one `role="img"` with a summary label, every
 * mark carries a `<title>`, and a Table toggle swaps in the full data table
 * (the non-visual and colour-independent path). Pie identity is never colour
 * alone — the legend names each slice with its value.
 */

import type { PropertyDef } from "@brainstorm-os/sdk-types";
import { type ReactElement, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { type AggregationResult, aggregationLabel, formatAggregation } from "../logic/aggregations";
import {
	CHART_SERIES_COLOR,
	type ChartDatum,
	type ChartModel,
	niceScale,
	pieArcs,
} from "../logic/chart-data";
import { ChartType } from "../types/list-view";

export type ChartViewProps = {
	model: ChartModel;
	chartType: ChartType;
	/** Display name of the measured property (null for a row count). */
	valueName: string | null;
	/** The group-by property's name (null when ungrouped). */
	groupName: string | null;
	/** The measured property's def — values format in its units. */
	valueDef?: PropertyDef | null;
	showTable: boolean;
	/** Omitted → no Table toggle (the widget's compact face). */
	onToggleTable?: (showTable: boolean) => void;
	compact?: boolean;
};

const FALLBACK_WIDTH = 560;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(FALLBACK_WIDTH);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) => {
			const next = Math.round(entry?.contentRect.width ?? 0);
			if (next > 0) setWidth(next);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}

export function ChartView(props: ChartViewProps): ReactElement {
	const { model, chartType, valueName, groupName, valueDef, showTable, onToggleTable } = props;
	const measure = valueName
		? `${aggregationLabel(model.kind)} · ${valueName}`
		: aggregationLabel(model.kind);
	const title = groupName
		? t("brainstorm.database.chart.titleBy", { measure, group: groupName })
		: measure;
	const format = useCallback(
		(value: number | null): string =>
			formatAggregation({ ...model.total, value } as AggregationResult, valueDef ?? undefined),
		[model.total, valueDef],
	);
	const summary = useMemo(
		() =>
			chartType === ChartType.Number
				? `${title}: ${format(model.total.value)}`
				: `${title}. ${model.data.map((d) => `${d.label}: ${format(d.value)}`).join("; ")}`,
		[chartType, title, model, format],
	);

	const empty = model.data.every((d) => d.count === 0);

	return (
		<div
			className="dbv-chart"
			data-chart-type={chartType}
			data-compact={props.compact ? "true" : undefined}
		>
			<div className="dbv-chart__head">
				<h3 className="dbv-chart__title">{title}</h3>
				{onToggleTable && chartType !== ChartType.Number ? (
					<button
						type="button"
						className="bs-btn bs-btn--secondary bs-btn--sm dbv-chart__toggle"
						aria-pressed={showTable}
						data-testid="dbv-chart-table-toggle"
						onClick={() => onToggleTable(!showTable)}
					>
						{showTable
							? t("brainstorm.database.chart.showChart")
							: t("brainstorm.database.chart.showTable")}
					</button>
				) : null}
			</div>
			{empty && chartType !== ChartType.Number ? (
				<p className="dbv-chart__empty">{t("brainstorm.database.chart.empty")}</p>
			) : showTable && chartType !== ChartType.Number ? (
				<ChartTable data={model.data} groupName={groupName} measure={measure} format={format} />
			) : chartType === ChartType.Number ? (
				<HeroNumber value={format(model.total.value)} label={title} />
			) : chartType === ChartType.Pie ? (
				<PieChart data={model.data} summary={summary} format={format} />
			) : chartType === ChartType.Line ? (
				<LineChart data={model.data} summary={summary} format={format} />
			) : (
				<BarChart data={model.data} summary={summary} format={format} />
			)}
		</div>
	);
}

type Format = (value: number | null) => string;

function ChartTable({
	data,
	groupName,
	measure,
	format,
}: {
	data: ReadonlyArray<ChartDatum>;
	groupName: string | null;
	measure: string;
	format: Format;
}): ReactElement {
	return (
		<table className="dbv-chart__table" data-testid="dbv-chart-table">
			<thead>
				<tr>
					<th scope="col">{groupName ?? t("brainstorm.database.chart.group")}</th>
					<th scope="col" className="dbv-chart__num">
						{measure}
					</th>
				</tr>
			</thead>
			<tbody>
				{data.map((d) => (
					<tr key={d.key}>
						<th scope="row">{d.label}</th>
						<td className="dbv-chart__num">{format(d.value)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function HeroNumber({ value, label }: { value: string; label: string }): ReactElement {
	return (
		<div className="dbv-chart__hero" role="img" aria-label={`${label}: ${value}`}>
			<span className="dbv-chart__hero-value">{value}</span>
		</div>
	);
}

/** Hover readout shared by every plotted form — a tooltip pinned over the
 *  plot at the hovered mark. */
function useHover(): {
	hover: { index: number; x: number; y: number } | null;
	enter: (index: number, x: number, y: number) => void;
	leave: () => void;
} {
	const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
	const enter = useCallback((index: number, x: number, y: number) => setHover({ index, x, y }), []);
	const leave = useCallback(() => setHover(null), []);
	return { hover, enter, leave };
}

function Tooltip({
	datum,
	x,
	y,
	format,
}: { datum: ChartDatum | undefined; x: number; y: number; format: Format }): ReactElement | null {
	if (!datum) return null;
	return (
		<div className="dbv-chart__tooltip" role="presentation" style={{ left: x, top: y }}>
			<span className="dbv-chart__tooltip-label">{datum.label}</span>
			<span className="dbv-chart__tooltip-value">{format(datum.value)}</span>
		</div>
	);
}

const BAR_ROW = 28;
const BAR_GAP = 2;
const LABEL_W = 0.3;

function BarChart({
	data,
	summary,
	format,
}: { data: ReadonlyArray<ChartDatum>; summary: string; format: Format }): ReactElement {
	const [ref, width] = useWidth();
	const { hover, enter, leave } = useHover();
	const max = Math.max(0, ...data.map((d) => d.value ?? 0));
	const scale = niceScale(max);
	const labelW = Math.round(width * LABEL_W);
	const valueW = 72;
	const plotW = Math.max(40, width - labelW - valueW);
	const height = data.length * BAR_ROW;
	return (
		<div className="dbv-chart__plot" ref={ref} onPointerLeave={leave}>
			<svg width={width} height={height} role="img" aria-label={summary} className="dbv-chart__svg">
				{data.map((d, i) => {
					const y = i * BAR_ROW;
					const w = d.value && d.value > 0 ? Math.max(2, (d.value / scale.max) * plotW) : 0;
					return (
						<g key={d.key} className="dbv-chart__mark" onPointerEnter={() => enter(i, labelW + w, y)}>
							<title>{`${d.label}: ${format(d.value)}`}</title>
							<rect x={0} y={y} width={width} height={BAR_ROW} fill="transparent" />
							<text
								x={labelW - 8}
								y={y + BAR_ROW / 2}
								className="dbv-chart__label"
								textAnchor="end"
								dominantBaseline="middle"
							>
								{truncate(d.label, 22)}
							</text>
							<rect
								x={labelW}
								y={y + BAR_GAP + 4}
								width={w}
								height={BAR_ROW - BAR_GAP * 2 - 8}
								rx={4}
								fill={CHART_SERIES_COLOR}
							/>
							<text
								x={labelW + w + 6}
								y={y + BAR_ROW / 2}
								className="dbv-chart__value"
								dominantBaseline="middle"
							>
								{format(d.value)}
							</text>
						</g>
					);
				})}
			</svg>
			{hover ? <Tooltip datum={data[hover.index]} x={hover.x} y={hover.y} format={format} /> : null}
		</div>
	);
}

const LINE_H = 220;
const PAD = { top: 12, right: 16, bottom: 28, left: 48 };

function LineChart({
	data,
	summary,
	format,
}: { data: ReadonlyArray<ChartDatum>; summary: string; format: Format }): ReactElement {
	const [ref, width] = useWidth();
	const { hover, enter, leave } = useHover();
	const max = Math.max(0, ...data.map((d) => d.value ?? 0));
	const scale = niceScale(max);
	const plotW = Math.max(40, width - PAD.left - PAD.right);
	const plotH = LINE_H - PAD.top - PAD.bottom;
	const x = (i: number): number =>
		PAD.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
	const y = (v: number | null): number => PAD.top + plotH - ((v ?? 0) / scale.max) * plotH;
	const ticks: number[] = [];
	for (let v = 0; v <= scale.max + 1e-9; v += scale.step) ticks.push(v);
	const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`).join(" ");
	const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 72))));
	return (
		<div className="dbv-chart__plot" ref={ref} onPointerLeave={leave}>
			<svg width={width} height={LINE_H} role="img" aria-label={summary} className="dbv-chart__svg">
				{ticks.map((v) => (
					<g key={v}>
						<line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} className="dbv-chart__grid" />
						<text
							x={PAD.left - 6}
							y={y(v)}
							className="dbv-chart__axis"
							textAnchor="end"
							dominantBaseline="middle"
						>
							{format(v)}
						</text>
					</g>
				))}
				<path d={path} fill="none" stroke={CHART_SERIES_COLOR} strokeWidth={2} strokeLinejoin="round" />
				{hover ? (
					<line
						x1={x(hover.index)}
						x2={x(hover.index)}
						y1={PAD.top}
						y2={PAD.top + plotH}
						className="dbv-chart__crosshair"
					/>
				) : null}
				{data.map((d, i) => (
					<g key={d.key} className="dbv-chart__mark" onPointerEnter={() => enter(i, x(i), y(d.value))}>
						<title>{`${d.label}: ${format(d.value)}`}</title>
						<rect
							x={x(i) - plotW / Math.max(1, data.length) / 2}
							y={PAD.top}
							width={plotW / Math.max(1, data.length)}
							height={plotH}
							fill="transparent"
						/>
						<circle
							cx={x(i)}
							cy={y(d.value)}
							r={4}
							fill={CHART_SERIES_COLOR}
							className="dbv-chart__dot"
						/>
						{i % labelEvery === 0 ? (
							<text x={x(i)} y={LINE_H - 8} className="dbv-chart__axis" textAnchor="middle">
								{truncate(d.label, 12)}
							</text>
						) : null}
					</g>
				))}
			</svg>
			{hover ? <Tooltip datum={data[hover.index]} x={hover.x} y={hover.y} format={format} /> : null}
		</div>
	);
}

const PIE_SIZE = 200;

function PieChart({
	data,
	summary,
	format,
}: { data: ReadonlyArray<ChartDatum>; summary: string; format: Format }): ReactElement {
	const { hover, enter, leave } = useHover();
	const arcs = pieArcs(data.map((d) => d.value));
	const r = PIE_SIZE / 2 - 2;
	const inner = r * 0.58;
	const c = PIE_SIZE / 2;
	return (
		<div className="dbv-chart__pie" onPointerLeave={leave}>
			<div className="dbv-chart__plot">
				<svg
					width={PIE_SIZE}
					height={PIE_SIZE}
					role="img"
					aria-label={summary}
					className="dbv-chart__svg"
				>
					{data.map((d, i) => {
						const arc = arcs[i];
						if (!arc || arc.end - arc.start <= 0) return null;
						const mid = (arc.start + arc.end) / 2;
						return (
							<path
								key={d.key}
								d={donutPath(c, c, r, inner, arc.start, arc.end)}
								fill={d.color ?? CHART_SERIES_COLOR}
								className="dbv-chart__slice"
								onPointerEnter={() => enter(i, c + Math.sin(mid) * r, c - Math.cos(mid) * r)}
							>
								<title>{`${d.label}: ${format(d.value)}`}</title>
							</path>
						);
					})}
				</svg>
				{hover ? <Tooltip datum={data[hover.index]} x={hover.x} y={hover.y} format={format} /> : null}
			</div>
			<ul className="dbv-chart__legend">
				{data.map((d) => (
					<li key={d.key} className="dbv-chart__legend-item">
						<span
							className="dbv-chart__swatch"
							aria-hidden="true"
							style={{ background: d.color ?? CHART_SERIES_COLOR }}
						/>
						<span className="dbv-chart__legend-label">{d.label}</span>
						<span className="dbv-chart__legend-value">{format(d.value)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function donutPath(
	cx: number,
	cy: number,
	r: number,
	inner: number,
	start: number,
	end: number,
): string {
	const sweep = Math.min(end - start, Math.PI * 2 - 1e-4);
	const e = start + sweep;
	const large = sweep > Math.PI ? 1 : 0;
	const pt = (radius: number, angle: number): string =>
		`${cx + Math.sin(angle) * radius},${cy - Math.cos(angle) * radius}`;
	return [
		`M${pt(r, start)}`,
		`A${r},${r} 0 ${large} 1 ${pt(r, e)}`,
		`L${pt(inner, e)}`,
		`A${inner},${inner} 0 ${large} 0 ${pt(inner, start)}`,
		"Z",
	].join(" ");
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
