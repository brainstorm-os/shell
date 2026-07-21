/**
 * Shared property-value formatting. Every view renderer routes through
 * `formatCell(value, propertyId)` so that "Done" reads the same in grid /
 * list / board / calendar / timeline / gallery without per-renderer
 * branching.
 *
 * Tightly scoped to the demo's property names — this is not a full property
 * system. The composable property model (Stage 9.6 VP) is what feeds the
 * renderer when Stage 9.3 lands; until then the demo's keys drive the
 * formatter.
 */

import { type DateValue, type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { DateGranularity, PropertyFormat } from "@brainstorm-os/sdk-types";
import {
	CoverRenderKind,
	type CoverViewSource,
	ViewCoverMode,
	resolveCoverForView,
} from "@brainstorm-os/sdk/entity-cover";
import { createEntityIconElement } from "@brainstorm-os/sdk/entity-icon";
import { formatScalar } from "@brainstorm-os/sdk/property-ui/pure";
import { TYPE_LABELS } from "../demo/dataset";
import { type EntityRow, readPropertyPath } from "../logic/in-memory-entities";
import {
	resolvePropertyDef,
	resolveVocabularyColor as vocabularyColor,
	resolveVocabularyLabel as vocabularyLabel,
} from "../logic/property-resolver";

export type CellRender = {
	kind:
		| "text"
		| "pill"
		| "checkbox"
		| "tags"
		| "date"
		| "datetime"
		| "number"
		| "money"
		| "rating"
		| "empty";
	text: string;
	color: string | null;
	raw: unknown;
};

export function renderCell(entity: EntityRow, propertyId: string): CellRender {
	const raw = readPropertyPath(entity, propertyId);
	const def = resolvePropertyDef(propertyId);
	if (def) return renderCellFromDef(def, propertyId, raw);
	return renderCellHeuristic(propertyId, raw);
}

/** Schema-driven path: a real vault `PropertyDef` resolved, so scalar
 *  formatting goes through the shared pure core (`formatScalar`) — the
 *  same code Notes' cells run. The CellRender `kind` is derived from
 *  `def.valueType` / `def.format` / `vocabulary` (a vocabulary-backed
 *  text value paints as a coloured chip, currency/percent as text,
 *  date as date), so the DOM painters below stay unchanged. */
function renderCellFromDef(def: PropertyDef, propertyId: string, raw: unknown): CellRender {
	if (raw === null || raw === undefined || raw === "") {
		return { kind: "empty", text: "", color: null, raw };
	}
	if (Array.isArray(raw)) {
		if (raw.length === 0) return { kind: "empty", text: "", color: null, raw };
		const text = raw.map((v) => formatScalarValue(def, v)).join(", ");
		return { kind: "tags", text, color: null, raw };
	}
	switch (def.valueType) {
		case ValueType.Boolean:
			return { kind: "checkbox", text: raw === true ? "Yes" : "No", color: null, raw };
		case ValueType.Date: {
			const text = formatScalarValue(def, raw);
			const withTime =
				def.granularity === DateGranularity.DateTime || def.granularity === DateGranularity.Time;
			return { kind: withTime ? "datetime" : "date", text, color: null, raw };
		}
		case ValueType.Number: {
			const text = formatScalarValue(def, raw);
			const kind: CellRender["kind"] = def.format === PropertyFormat.Currency ? "money" : "number";
			return { kind, text, color: null, raw };
		}
		default: {
			const text = formatScalarValue(def, raw);
			if (def.vocabulary && typeof raw === "string") {
				// A Select stores the option id; show its label but resolve both
				// label and colour from that id (the colour index is id-keyed,
				// like board/calendar/timeline) so read-only paints read "Lead",
				// not "di_…" (F-031), and a user-created option colours too.
				const label = vocabularyLabel(propertyId, raw) ?? text;
				return { kind: "pill", text: label, color: vocabularyColor(propertyId, raw), raw };
			}
			if (propertyId === "rating" || text.startsWith("★")) {
				return { kind: "rating", text, color: vocabularyColor(propertyId, text), raw };
			}
			return { kind: "text", text, color: null, raw };
		}
	}
}

/** Adapt a Database raw scalar (dates are bare epoch-ms numbers in the
 *  demo / vault preview) into the value-shape `formatScalar` expects,
 *  then format through the shared pure core. */
function formatScalarValue(def: PropertyDef, raw: unknown): string {
	if (def.valueType === ValueType.Date && typeof raw === "number") {
		const value: DateValue = {
			at: raw,
			granularity: def.granularity ?? DateGranularity.Date,
		};
		return formatScalar(def, value);
	}
	return formatScalar(def, raw);
}

function renderCellHeuristic(propertyId: string, raw: unknown): CellRender {
	if (raw === null || raw === undefined || raw === "") {
		// Empty property → blank, not a dash placeholder (user request).
		return { kind: "empty", text: "", color: null, raw };
	}
	if (Array.isArray(raw)) {
		if (raw.length === 0) return { kind: "empty", text: "", color: null, raw };
		const text = raw.map((v) => stringifyScalar(v)).join(", ");
		return { kind: "tags", text, color: null, raw };
	}
	if (typeof raw === "boolean") {
		return { kind: "checkbox", text: raw ? "Yes" : "No", color: null, raw };
	}
	if (typeof raw === "number") {
		if (looksLikeTimestamp(raw)) {
			const text = formatDate(raw);
			const kind: CellRender["kind"] = hasTime(raw) ? "datetime" : "date";
			return { kind, text, color: null, raw };
		}
		if (looksLikeMoney(propertyId)) {
			return { kind: "money", text: formatMoney(raw), color: null, raw };
		}
		return { kind: "number", text: formatNumber(raw), color: null, raw };
	}
	if (typeof raw === "string") {
		if (propertyId === "rating" || raw.startsWith("★")) {
			return { kind: "rating", text: raw, color: vocabularyColor(propertyId, raw), raw };
		}
		const color = vocabularyColor(propertyId, raw);
		if (color !== null) {
			return { kind: "pill", text: raw, color, raw };
		}
		return { kind: "text", text: raw, color: null, raw };
	}
	return { kind: "text", text: stringifyScalar(raw), color: null, raw };
}

function stringifyScalar(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number") return formatNumber(v);
	if (typeof v === "boolean") return v ? "Yes" : "No";
	if (typeof v !== "object") return String(v);
	if ("value" in (v as Record<string, unknown>)) {
		return stringifyScalar((v as { value: unknown }).value);
	}
	if (Array.isArray(v)) {
		const parts = v.map(stringifyScalar).filter((s) => s.length > 0);
		return parts.join(", ");
	}
	// Rich-text body ({ root: { children: [...] } }) → a plain-text
	// preview; any other object → "" (renders as the "—" empty value,
	// never the meaningless "[object Object]" the user saw).
	const text = flattenRichText(v).trim();
	return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Depth-capped walk of a Lexical-ish `{root:{children:[…text…]}}`
 *  blob → concatenated text. Returns "" for any non-rich-text object. */
function flattenRichText(v: unknown, depth = 0): string {
	if (depth > 64 || !v || typeof v !== "object") return "";
	const node = v as { root?: unknown; text?: unknown; children?: unknown };
	if (typeof node.text === "string") return node.text;
	const kids = node.root ?? node.children;
	if (!Array.isArray(kids)) {
		return node.root && typeof node.root === "object" ? flattenRichText(node.root, depth + 1) : "";
	}
	return kids
		.map((c) => flattenRichText(c, depth + 1))
		.join(" ")
		.replace(/\s+/g, " ");
}

function formatNumber(n: number): string {
	if (Number.isInteger(n)) return n.toLocaleString();
	return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatMoney(n: number): string {
	return `$${n.toLocaleString()}`;
}

function looksLikeMoney(propertyId: string): boolean {
	return /cost|price|amount|budget|revenue/i.test(propertyId);
}

/** Treat large positive integers that look like Unix ms timestamps from
 *  the past 30 years as dates. Demo data only — schema would tell us in a
 *  real world. The 30-year window keeps small integers (page counts /
 *  runtimes / IDs) from being mistaken for dates. */
function looksLikeTimestamp(n: number): boolean {
	if (!Number.isFinite(n)) return false;
	if (n < 1_000_000_000_000) return false; // < year 2001
	if (n > 4_000_000_000_000) return false; // > year 2096
	return true;
}

function hasTime(ms: number): boolean {
	const d = new Date(ms);
	return d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
}

export function formatDate(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export function formatDateTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function formatDayLabel(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
}

/** Per-object icon: the object's OWN `properties.icon` if set, else `null`
 *  (NO type-default fallback, NO sized empty slot). Per
 *  [[feedback_no_default_type_icon_fallback]] (project-wide rule, not
 *  just DB): if no icon is set, render NOTHING — the caller's surrounding
 *  flex/grid gap must collapse around the absent slot instead of reserving
 *  a fixed icon column. Callers that wrap the result in a glyph span must
 *  also skip the wrapper when this returns null. */
export function entityIcon(entity: EntityRow, size = 14): HTMLElement | null {
	const own = entity.properties.icon;
	if (own && typeof own === "object") {
		const obj = own as { kind?: unknown; value?: unknown };
		if (typeof obj.kind === "string" && typeof obj.value === "string" && obj.value) {
			return createEntityIconElement(obj as Parameters<typeof createEntityIconElement>[0], {
				size,
			});
		}
	}
	return null;
}

export function typeLabel(typeId: string): string {
	return TYPE_LABELS[typeId] ?? typeId.split("/").slice(-2, -1)[0] ?? typeId;
}

const TITLE_KEYS = ["title", "name", "label"] as const;
const TITLE_BODY_KEYS = ["body", "description", "summary", "content", "text", "note"] as const;
const TITLE_FALLBACK_MAX = 120;

/** Read a useful display title from an entity, regardless of which key the
 *  type uses. If no explicit title-shaped property is set, fall back to the
 *  first ~120 characters of any body/description-shaped text property so the
 *  row reads as content rather than an opaque id. */
export function entityTitle(entity: EntityRow): string {
	const p = entity.properties;
	for (const key of TITLE_KEYS) {
		const v = p[key];
		if (typeof v === "string" && v) return v;
	}
	for (const key of TITLE_BODY_KEYS) {
		const v = p[key];
		if (typeof v === "string" && v.trim()) return truncateForTitle(v);
	}
	return entity.id;
}

function truncateForTitle(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= TITLE_FALLBACK_MAX) return collapsed;
	return `${collapsed.slice(0, TITLE_FALLBACK_MAX).trimEnd()}…`;
}

/** The CSS `background` for a gallery/board card backdrop — the object's
 *  OWN cover (`properties.cover`), or the view's `coverProperty`
 *  override, or the id-seeded gradient. The ONE precedence rule lives in
 *  the SDK's `resolveCoverForView` (per-object-covers-everywhere — never
 *  a per-app cover rule, never keyed off `entity.type`). */
export function coverBackgroundFor(entity: EntityRow, coverProperty: string | null): string {
	const source: CoverViewSource = coverProperty
		? { mode: ViewCoverMode.Property, key: coverProperty }
		: { mode: ViewCoverMode.Inherit };
	const r = resolveCoverForView({ id: entity.id, properties: entity.properties }, source);
	if (r.kind === CoverRenderKind.Paint) return r.css;
	if (r.kind === CoverRenderKind.Image) {
		return `${r.position} / cover no-repeat url("${r.url.replace(/"/g, "%22")}")`;
	}
	return "transparent"; // Suppressed — the view explicitly opted out of a band.
}

/**
 * Shared DOM emitter for a property's value. Every view that surfaces an
 * entity property routes through here so the visual language stays one — a
 * status reads as a chip everywhere, an author name reads as quiet text
 * everywhere, ratings render as bare gold stars instead of being wrapped in
 * a redundant box.
 *
 * Layout: `cell` for grid-style table cells (the value is the only child of
 * a width-constrained container — bare values render as plain text, chip
 * values render inline). `inline` for the property-strip on list rows
 * (returns null for empty values so the strip doesn't keep an empty slot).
 */
export function paintPropertyValue(
	entity: EntityRow,
	propertyId: string,
	layout: "cell" | "inline",
): HTMLElement | null {
	const data = renderCell(entity, propertyId);
	if (data.kind === "empty" && layout === "inline") return null;

	if (data.kind === "pill") {
		const chip = document.createElement("span");
		chip.className = "dbv-chip";
		chip.dataset.kind = "pill";
		if (data.color) tintChip(chip, data.color);
		chip.textContent = data.text;
		return chip;
	}

	if (data.kind === "rating") {
		const stars = document.createElement("span");
		stars.className = "dbv-rating";
		stars.textContent = data.text;
		return stars;
	}

	if (data.kind === "tags") {
		const wrap = document.createElement("span");
		wrap.className = "dbv-tags";
		const items = Array.isArray(data.raw) ? data.raw : String(data.raw).split(",");
		// Per-item scalar repr (stringifyScalar flattens rich text /
		// returns "" for opaque objects) — never `String(obj)` =
		// "[object Object]".
		const labels = items.map((v) => stringifyScalar(v).trim()).filter((s) => s.length > 0);
		if (labels.length === 0) {
			// Array of opaque objects (e.g. whiteboard nodes) → a concise
			// count, not a pile of "[object Object]" / blank pills.
			const span = document.createElement("span");
			span.className = "dbv-value";
			span.dataset.kind = "number";
			span.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
			return span;
		}
		for (const label of labels) {
			const tag = document.createElement("span");
			tag.className = "dbv-tag";
			tag.textContent = label;
			wrap.appendChild(tag);
		}
		return wrap;
	}

	if (data.kind === "checkbox") {
		const box = document.createElement("span");
		box.className = "dbv-checkbox";
		if (data.raw === true) box.dataset.checked = "true";
		return box;
	}

	const text = document.createElement("span");
	text.className = "dbv-value";
	text.dataset.kind = data.kind;
	text.textContent = data.text;
	return text;
}

function tintChip(chip: HTMLElement, color: string): void {
	chip.style.background = `color-mix(in srgb, ${color} 18%, transparent)`;
	chip.style.color = color;
	chip.style.borderColor = `color-mix(in srgb, ${color} 38%, transparent)`;
}
