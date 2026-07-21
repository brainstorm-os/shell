/**
 * Tasks chrome glyphs.
 *
 * The shared `@brainstorm-os/sdk/icon` set is the source of truth — anything
 * in it renders via `createIconElement`. The only glyphs Tasks' sidebar
 * needs that the shared registry does NOT yet expose are the **Inbox**
 * (Phosphor `tray`) and **Upcoming** (Phosphor `calendar-dots`) markers
 * for the two built-in surfaces that aren't a real calendar day. Per the
 * shared-fundamentals contract we must NOT hand-edit the generated SDK
 * glyph file to add them — the gap is flagged upstream (STOP-and-report:
 * "add `inbox` (tray) and `upcoming` (calendar-dots) to the SDK
 * `IconName` set"). Until that lands, the two glyphs live here as a
 * minimal, documented stopgap (Phosphor regular weight, `currentColor`,
 * `viewBox="0 0 256 256"` matching the SDK glyph metrics) so the sidebar
 * surface rows match the rest of the app chrome. Every other Tasks glyph
 * routes through the SDK — today via `IconName.KindDate`, and so on.
 */

import { type IconName, createGlyphElement, createIconElement } from "@brainstorm-os/sdk/icon";

export enum TasksIcon {
	Inbox = "inbox",
	Upcoming = "upcoming",
	Timeline = "timeline",
}

/** Phosphor regular-weight inner markup, lifted verbatim from
 *  `@phosphor-icons/core/assets/regular/<name>.svg`. */
const STOPGAP_MARKUP: Record<TasksIcon, string> = {
	[TasksIcon.Inbox]:
		'<path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Zm0,16V152h-28.7A15.86,15.86,0,0,0,168,156.69L148.69,176H107.31L88,156.69A15.86,15.86,0,0,0,76.69,152H48V48Zm0,160H48V168H76.69L96,187.31A15.86,15.86,0,0,0,107.31,192h41.38A15.86,15.86,0,0,0,160,187.31L179.31,168H208v40Z"/>',
	[TasksIcon.Upcoming]:
		'<path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Zm-68-76a12,12,0,1,1-12-12A12,12,0,0,1,140,132Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,184,132ZM96,172a12,12,0,1,1-12-12A12,12,0,0,1,96,172Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,140,172Zm44,0a12,12,0,1,1-12-12A12,12,0,0,1,184,172Z"/>',
	// Gantt bars — three offset rounded spans (same 256 grid / filled
	// contract as the Phosphor stopgaps above; no Phosphor "gantt" exists).
	[TasksIcon.Timeline]:
		'<rect x="32" y="44" width="128" height="32" rx="10"/><rect x="72" y="112" width="152" height="32" rx="10"/><rect x="32" y="180" width="104" height="32" rx="10"/>',
};

export type CreateIconOptions = {
	size?: number;
	className?: string;
};

/** Render a shared SDK glyph by `IconName`. Prefer this for any chrome
 *  glyph that exists in the registry. */
export function createSharedIcon(
	name: IconName | `${IconName}`,
	options: CreateIconOptions = {},
): SVGSVGElement | HTMLSpanElement {
	return createIconElement(name, {
		...(options.size !== undefined ? { size: options.size } : {}),
		...(options.className !== undefined ? { className: options.className } : {}),
	});
}

/** The stopgap glyph — same `viewBox`/`fill` contract the SDK
 *  `createIconElement` emits, so it visually matches the shared set. */
export function createTasksIcon(glyph: TasksIcon, options: CreateIconOptions = {}): SVGSVGElement {
	return createGlyphElement(
		{ viewBox: "0 0 256 256", filled: true, innerMarkup: STOPGAP_MARKUP[glyph] },
		options,
	);
}
