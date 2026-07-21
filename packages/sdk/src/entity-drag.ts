/**
 * Entity drag payload contract (B11.8) — the wire format for dragging an
 * object from a list / sidebar / search surface and dropping it into an
 * editor (Notes) as a link or transclusion block.
 *
 * One MIME type product-wide so every draggable object surface and every
 * drop target speak the same shape: `application/vnd.brainstorm.entity+json`
 * carrying `{ entityId, entityType, label, iconRef? }`.
 *
 * Hostile-input hardening mirrors the persisted-node fields
 * (`TransclusionNode.clampField`): every field strips ASCII C0 controls +
 * Unicode bidi-override / zero-width / format codes (Trojan-Source /
 * homoglyph defense) and is length-clamped, because a dropped payload is
 * untrusted text that lands in a brainstorm:// href + a rendered label.
 * `parse` returns null on anything that isn't a well-formed payload with a
 * non-empty `entityId` so a malformed `dataTransfer` is a no-op drop, not a
 * dangling node.
 */

import type { ObjectDragItem, ObjectDragPayload } from "@brainstorm-os/sdk-types";

export const ENTITY_DRAG_MIME = "application/vnd.brainstorm.entity+json";

const MAX_FIELD_LEN = 1024;

/** ASCII C0 controls + Unicode bidi-override / zero-width / format codes —
 *  the same set the persisted editor nodes strip. U+2028/U+2029 (line/paragraph
 *  separators) are included so a label is single-line AND so the hardening of a
 *  label that later reaches a JS string literal (the shell ghost's
 *  `executeJavaScript`) is engine-independent, not reliant on the ES2019 V8
 *  string-literal relaxation. */
const STRIP_FORMAT_CONTROLS_RE = new RegExp(
	"[" +
		"\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F" +
		"\\u200B-\\u200F" +
		"\\u2028\\u2029" +
		"\\u202A-\\u202E" +
		"\\u2066-\\u2069" +
		"]",
	"g",
);

function clampField(value: unknown): string {
	if (typeof value !== "string") return "";
	const stripped = value.replace(STRIP_FORMAT_CONTROLS_RE, "");
	return stripped.length > MAX_FIELD_LEN ? stripped.slice(0, MAX_FIELD_LEN) : stripped;
}

export type EntityDragPayload = {
	entityId: string;
	entityType: string;
	label: string;
	/** Optional icon reference (emoji glyph / icon name) — surfaces that
	 *  carry an icon pass it so the drop can render the object faithfully. */
	iconRef?: string;
};

/** Serialize a payload to the JSON string carried under `ENTITY_DRAG_MIME`.
 *  Fields are clamped/stripped up front so the wire bytes are already clean. */
export function serializeEntityDragPayload(payload: EntityDragPayload): string {
	const out: EntityDragPayload = {
		entityId: clampField(payload.entityId),
		entityType: clampField(payload.entityType),
		label: clampField(payload.label),
	};
	const iconRef = clampField(payload.iconRef);
	if (iconRef.length > 0) out.iconRef = iconRef;
	return JSON.stringify(out);
}

/** Parse a JSON string (as read from `dataTransfer.getData(ENTITY_DRAG_MIME)`)
 *  into a hardened payload, or null when it isn't a well-formed entity drag
 *  with a non-empty id. */
export function parseEntityDragPayload(raw: string | null | undefined): EntityDragPayload | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const entityId = clampField(record.entityId);
	if (entityId.length === 0) return null;
	const out: EntityDragPayload = {
		entityId,
		entityType: clampField(record.entityType),
		label: clampField(record.label),
	};
	const iconRef = clampField(record.iconRef);
	if (iconRef.length > 0) out.iconRef = iconRef;
	return out;
}

/** Stamp the payload onto a `DataTransfer` (call from `dragstart`). Also sets
 *  a `text/plain` fallback (the label) so dropping into a foreign target that
 *  doesn't understand the entity MIME still yields readable text. */
export function setEntityDragData(dataTransfer: DataTransfer, payload: EntityDragPayload): void {
	dataTransfer.setData(ENTITY_DRAG_MIME, serializeEntityDragPayload(payload));
	const label = clampField(payload.label);
	if (label.length > 0) dataTransfer.setData("text/plain", label);
}

/** Read + parse the entity payload from a `DataTransfer` (call from `drop`). */
export function readEntityDragData(dataTransfer: DataTransfer | null): EntityDragPayload | null {
	if (!dataTransfer) return null;
	return parseEntityDragPayload(dataTransfer.getData(ENTITY_DRAG_MIME));
}

/** True when a `DataTransfer` advertises the entity MIME. `getData()` is
 *  blanked during `dragover` for security, but `types` is readable — so a
 *  drop target uses this to decide whether to `preventDefault` (allow drop)
 *  before the payload bytes are available on `drop`. */
export function dataTransferHasEntity(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	for (const type of dataTransfer.types) {
		if (type === ENTITY_DRAG_MIME) return true;
	}
	return false;
}

// ─── Multi-item selection / cross-app drag payload (DND-1,) ──

/** The canonical multi-item drag types live in `@brainstorm-os/sdk-types` (so the
 *  shell `dnd`/`selection` services + the SDK proxy share one home); re-exported
 *  here alongside the hardening helpers. `ObjectDragItem` is structurally
 *  `EntityDragPayload` (the intra-app HTML5 drag item). */
export type { ObjectDragItem, ObjectDragPayload };

/** Upper bound on items carried in one selection / drag payload — bounds the
 *  memory a single `publish` can pin in the shell's selection slot. Mirrors the
 *  collection membership hard cap. */
export const MAX_DRAG_ITEMS = 5000;

/** Harden one item: clamp/strip every field (Trojan-Source / homoglyph
 *  defense), or `null` when it has no usable `entityId`. */
export function hardenObjectDragItem(item: unknown): ObjectDragItem | null {
	if (typeof item !== "object" || item === null) return null;
	const record = item as Record<string, unknown>;
	const entityId = clampField(record.entityId);
	if (entityId.length === 0) return null;
	const out: ObjectDragItem = {
		entityId,
		entityType: clampField(record.entityType),
		label: clampField(record.label),
	};
	const iconRef = clampField(record.iconRef);
	if (iconRef.length > 0) out.iconRef = iconRef;
	return out;
}

/** Harden an items array: drop malformed entries, dedupe by `entityId` (first
 *  wins), and clamp the count to `MAX_DRAG_ITEMS`. The result is safe to store
 *  in the shell selection slot and to ship as an `ObjectDragPayload`. */
export function hardenObjectDragItems(items: unknown): ObjectDragItem[] {
	if (!Array.isArray(items)) return [];
	const out: ObjectDragItem[] = [];
	const seen = new Set<string>();
	for (const raw of items) {
		if (out.length >= MAX_DRAG_ITEMS) break;
		const item = hardenObjectDragItem(raw);
		if (item === null || seen.has(item.entityId)) continue;
		seen.add(item.entityId);
		out.push(item);
	}
	return out;
}

/** Schema version for the widened native payload. */
export const OBJECT_DRAG_PAYLOAD_VERSION = 1 as const;

/** Serialize a multi-item `ObjectDragPayload` to the JSON string carried under
 *  `ENTITY_DRAG_MIME` (DND-3 wire reconciliation, §Part IV.3).
 *  The SAME MIME carries both the legacy single-item shape and this widened
 *  `{ v, sourceApp, items[] }` shape; `parseObjectDragPayload` reads either. */
export function serializeObjectDragPayload(payload: ObjectDragPayload): string {
	return JSON.stringify({
		v: OBJECT_DRAG_PAYLOAD_VERSION,
		sourceApp: clampField(payload.sourceApp),
		items: hardenObjectDragItems(payload.items),
	});
}

/** Parse the entity MIME JSON into a hardened multi-item payload, accepting
 *  BOTH transports' shapes: the widened `{ items[] }` and the legacy single
 *  `{ entityId, … }` (wrapped as a one-item payload). `null` when neither yields
 *  a usable item. NOTE: a native-transport `sourceApp` is self-asserted and
 *  MUST NOT be trusted for authorization — only the shell drag session stamps a
 *  trustworthy `sourceApp`; the target gates on its own capabilities. */
export function parseObjectDragPayload(raw: string | null | undefined): ObjectDragPayload | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (Array.isArray(record.items)) {
		const items = hardenObjectDragItems(record.items);
		if (items.length === 0) return null;
		return { v: OBJECT_DRAG_PAYLOAD_VERSION, sourceApp: clampField(record.sourceApp), items };
	}
	const single = hardenObjectDragItem(record);
	if (!single) return null;
	return { v: OBJECT_DRAG_PAYLOAD_VERSION, sourceApp: "", items: [single] };
}

/** Stamp a multi-item payload onto a `DataTransfer` (call from `dragstart`).
 *  Sets the entity MIME + a `text/plain` fallback (newline-joined labels) so a
 *  foreign target still yields readable text. */
export function setObjectDragData(dataTransfer: DataTransfer, payload: ObjectDragPayload): void {
	// Harden once so the text/plain fallback and the MIME payload describe the
	// SAME item set (a malformed/duplicate item must not appear in one and not
	// the other).
	const items = hardenObjectDragItems(payload.items);
	dataTransfer.setData(ENTITY_DRAG_MIME, serializeObjectDragPayload({ ...payload, items }));
	const labels = items.map((it) => it.label).filter((l) => l.length > 0);
	if (labels.length > 0) dataTransfer.setData("text/plain", labels.join("\n"));
}

/** Read + normalize the entity payload from a `DataTransfer` (call from `drop`),
 *  spanning both the widened and legacy shapes. */
export function readObjectDragData(dataTransfer: DataTransfer | null): ObjectDragPayload | null {
	if (!dataTransfer) return null;
	return parseObjectDragPayload(dataTransfer.getData(ENTITY_DRAG_MIME));
}

/** Deduped entity-type URLs present in a drag — what a drop target (and the
 *  shell's hover-leak notice) keys its accept/effect decision on without caring
 *  WHICH specific objects are dragged. Single home for the dedupe so the shell's
 *  hover-leak set and the SDK target's read can't diverge. */
export function objectDragItemTypes(items: readonly ObjectDragItem[]): string[] {
	const seen = new Set<string>();
	for (const item of items) if (item.entityType) seen.add(item.entityType);
	return [...seen];
}
