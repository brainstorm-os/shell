/**
 * Pure display logic for the embedded-list block (F-210): column derivation,
 * header naming, and cell-value formatting. Split from `entry.ts` so the
 * grid's "what to show" rules are testable without the block harness, and so
 * the heuristics are SHARED with the main Database app rather than forked:
 * type inference comes from `logic/effective-def` (`inferPropertyDef`),
 * labels from `ui/humanize`, dates from `@brainstorm-os/sdk/date-formatters`.
 *
 * The block has NO catalog access — its only vault channel is the BP graph
 * module (`getEntity`/`queryEntities`), and `PropertyDef`s live in the
 * properties Y.Doc the graph module doesn't expose. So minted opaque keys
 * (`prop_<t36>_<r>`) can never resolve their user-given display name here;
 * they fall back to a TYPE-derived header ("Date", "Reference", …) instead
 * of leaking the raw id ("Prop mpye0tff 8acd19"). Same for stored ids in
 * cells: an `ent_…` id resolves to the referenced entity's title via the
 * graph (the caller passes the resolved map in), anything unresolvable
 * (`di_…` dictionary options without a dictionary) renders a neutral
 * "1 reference" placeholder — NEVER the raw id.
 */

import { ValueType } from "@brainstorm-os/sdk-types";
import { formatDate, formatTime } from "@brainstorm-os/sdk/date-formatters";
import { inferPropertyDef } from "../../logic/effective-def";
import { humanize } from "../../ui/humanize";

/** The slice of a BP entity the formatting layer needs. */
export type EmbedRow = { properties: Record<string, unknown> };

/** Resolved reference titles: stored id → referenced entity's title. */
export type RefTitles = ReadonlyMap<string, string>;

export const EMPTY_REF_TITLES: RefTitles = new Map();

/** Cap on rows resolved per embed — a doc-embedded grid is a preview, not the
 *  full app. Beyond this the host card's "open" affordance is the path. */
export const MAX_ROWS = 100;
/** Cap on derived columns so a wide entity doesn't overflow the doc column. */
export const MAX_COLS = 6;
/** Cap on reference-title lookups per embed (one `getEntity` each). */
export const MAX_REF_LOOKUPS = 50;
/** Property keys never shown as columns (structural / rendered elsewhere). */
const HIDDEN_KEYS = new Set(["id", "createdAt", "updatedAt", "icon", "cover", "deletedAt"]);

/** A vault-minted property key (`newPropertyKey()` in `@brainstorm-os/sdk/
 *  properties-keys`) — an opaque id whose display name lives only in the
 *  properties catalog the block can't reach. */
export function isOpaqueKey(key: string): boolean {
	return /^prop_[a-z0-9]+_[a-z0-9]+$/.test(key);
}

/** A stored value that is a minted vault id rather than human text: an
 *  entity id (`ent_<t36><rand>`, resolvable via graph `getEntity`) or a
 *  properties-catalog id (`di_`/`dict_`/`prop_` + `<t36>_<rand>`, never
 *  resolvable from the block jail). */
export function isRefLikeId(value: string): boolean {
	return /^(?:ent_[a-z0-9]{6,}|(?:di|dict|prop)_[a-z0-9]+_[a-z0-9]+)$/.test(value);
}

/** Derive the column set: the most-frequently-populated property keys across
 *  the rows (mirrors the Database app's `deriveColumns` heuristic), so the
 *  embed shows the same salient columns the full app would. Legible keys
 *  outrank opaque minted ones at equal frequency — the preview should lead
 *  with columns whose headers carry real names. */
export function deriveColumns(rows: readonly EmbedRow[]): string[] {
	const freq = new Map<string, number>();
	for (const row of rows) {
		for (const key of Object.keys(row.properties)) {
			if (HIDDEN_KEYS.has(key)) continue;
			if (row.properties[key] == null || row.properties[key] === "") continue;
			freq.set(key, (freq.get(key) ?? 0) + 1);
		}
	}
	// name/title first (the human label), then frequency desc, then legible
	// keys before opaque minted ones, then alpha.
	return [...freq.entries()]
		.sort((a, b) => {
			const aw = a[0] === "name" || a[0] === "title" ? 1 : 0;
			const bw = b[0] === "name" || b[0] === "title" ? 1 : 0;
			if (aw !== bw) return bw - aw;
			if (b[1] !== a[1]) return b[1] - a[1];
			const ao = isOpaqueKey(a[0]) ? 1 : 0;
			const bo = isOpaqueKey(b[0]) ? 1 : 0;
			if (ao !== bo) return ao - bo;
			return a[0].localeCompare(b[0]);
		})
		.slice(0, MAX_COLS)
		.map(([key]) => key);
}

function firstPopulated(rows: readonly EmbedRow[], key: string): unknown {
	for (const row of rows) {
		const v = row.properties[key];
		if (v === null || v === undefined || v === "") continue;
		if (Array.isArray(v) && v.length === 0) continue;
		return v;
	}
	return undefined;
}

/** Header label for one column. Legible keys humanize (`dueDate` → "Due
 *  date"); opaque minted keys label by the column's inferred TYPE — the raw
 *  id is never shown. */
function columnLabel(key: string, rows: readonly EmbedRow[]): string {
	if (!isOpaqueKey(key)) return humanize(key);
	const populated = firstPopulated(rows, key);
	const sample = Array.isArray(populated) ? populated[0] : populated;
	if (typeof sample === "string" && isRefLikeId(sample)) return "Reference";
	const def = sample === undefined ? null : inferPropertyDef(key, sample);
	switch (def?.valueType) {
		case ValueType.Date:
			return "Date";
		case ValueType.Number:
			return "Number";
		case ValueType.Boolean:
			return "Checkbox";
		case ValueType.Text:
			return "Text";
		default:
			return "Property";
	}
}

/** Header labels for the whole column set, deduped ("Date", "Date 2") so two
 *  unresolvable columns of the same type stay distinguishable. */
export function columnLabels(columns: readonly string[], rows: readonly EmbedRow[]): string[] {
	const used = new Map<string, number>();
	return columns.map((key) => {
		const base = columnLabel(key, rows);
		const n = (used.get(base) ?? 0) + 1;
		used.set(base, n);
		return n === 1 ? base : `${base} ${n}`;
	});
}

/** Best-effort plain text for a title-ish value (string, or an object
 *  carrying a `name`/`title`/`value`/`label`). */
export function plainText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(", ");
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const label = obj.name ?? obj.title ?? obj.value ?? obj.label;
		if (typeof label === "string") return label;
	}
	return "";
}

/** Mirrors `render/cells.ts`: a date stored with a non-midnight UTC clock
 *  reads as a datetime, a midnight one as a bare date. */
function hasTime(ms: number): boolean {
	const d = new Date(ms);
	return d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
}

const referencePlaceholder = (count: number): string =>
	count === 1 ? "1 reference" : `${count} references`;

/** One formatted cell: the display text plus whether it is a neutral
 *  unresolved-reference placeholder (so the renderer can dim it). */
export type CellDisplay = { text: string; placeholder: boolean };

function cell(text: string, placeholder = false): CellDisplay {
	return { text, placeholder };
}

function formatScalar(key: string, value: unknown, titles: RefTitles): CellDisplay {
	if (value === null || value === undefined || value === "") return cell("");
	if (typeof value === "boolean") return cell(value ? "Yes" : "No");
	if (typeof value === "number") {
		const def = inferPropertyDef(key, value);
		if (def?.valueType === ValueType.Date) {
			return cell(hasTime(value) ? `${formatDate(value)} ${formatTime(value)}` : formatDate(value));
		}
		return cell(
			Number.isInteger(value)
				? value.toLocaleString()
				: value.toLocaleString(undefined, { maximumFractionDigits: 2 }),
		);
	}
	if (typeof value === "string") {
		if (isRefLikeId(value)) {
			const title = titles.get(value);
			return title ? cell(title) : cell(referencePlaceholder(1), true);
		}
		return cell(value);
	}
	return cell(plainText(value));
}

/** Display for one grid cell. Dates format through the shared SDK formatter,
 *  numbers localize, ref-like ids resolve to the referenced entity's title
 *  via `titles` or collapse to a neutral placeholder — never the raw id. */
export function formatCell(key: string, value: unknown, titles: RefTitles): CellDisplay {
	if (value === null || value === undefined || value === "") return cell("");
	if (Array.isArray(value)) {
		if (value.length === 0) return cell("");
		const unresolved = value.filter(
			(v) => typeof v === "string" && isRefLikeId(v) && !titles.has(v),
		).length;
		if (unresolved === value.length) return cell(referencePlaceholder(unresolved), true);
		return cell(
			value
				.map((v) => formatScalar(key, v, titles).text)
				.filter(Boolean)
				.join(", "),
		);
	}
	return formatScalar(key, value, titles);
}

/** Unique ref-like ids stored in the visible columns, capped at
 *  {@link MAX_REF_LOOKUPS} — the candidates worth a `getEntity` title
 *  lookup. */
export function collectRefIds(rows: readonly EmbedRow[], columns: readonly string[]): string[] {
	const ids = new Set<string>();
	for (const row of rows) {
		for (const key of columns) {
			const value = row.properties[key];
			const scalars = Array.isArray(value) ? value : [value];
			for (const v of scalars) {
				if (typeof v === "string" && isRefLikeId(v)) ids.add(v);
				if (ids.size >= MAX_REF_LOOKUPS) return [...ids];
			}
		}
	}
	return [...ids];
}
