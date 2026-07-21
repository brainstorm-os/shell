/**
 * Database app chrome glyphs.
 *
 * The shared `@brainstorm-os/sdk/icon` registry is the source of truth — every
 * glyph it exposes renders via `createIconElement` so it paints identically
 * across the product (same pattern as `apps/tasks/src/ui/icons.ts`). The only
 * glyphs Database needs that the registry does NOT expose are the **view-kind
 * markers** (Grid / List / Gallery / Board / Calendar / Timeline) plus
 * **Filter**, **Sort**, and **Database** — those live here as local stopgaps
 * (stroke-only, `currentColor`, 16×16 viewBox). Everything else — Plus,
 * Search, Settings, Close, Check, and the left/right carets — routes through
 * the SDK.
 *
 * Per the [[no-plus-text-with-icon]] memory, buttons consuming these icons
 * never duplicate the glyph in the label text.
 */

import { type IconName, createGlyphElement, createIconElement } from "@brainstorm-os/sdk/icon";

/** Glyphs that only live in this app (the shared registry has no equivalent). */
export enum DatabaseIcon {
	Grid = "grid",
	List = "list",
	Gallery = "gallery",
	Board = "board",
	Calendar = "calendar",
	Timeline = "timeline",
	Filter = "filter",
	Sort = "sort",
	Database = "database",
}

type PathSpec = { paths: string[] };

const SPECS: Record<DatabaseIcon, PathSpec> = {
	[DatabaseIcon.Grid]: {
		paths: ["M2.5 2.5h11v11h-11zM2.5 6h11M2.5 9.5h11M6 2.5v11M9.5 2.5v11"],
	},
	[DatabaseIcon.List]: {
		paths: ["M2.5 4h11M2.5 8h11M2.5 12h11"],
	},
	[DatabaseIcon.Gallery]: {
		paths: ["M2.5 2.5h5v5h-5zM8.5 2.5h5v5h-5zM2.5 8.5h5v5h-5zM8.5 8.5h5v5h-5z"],
	},
	[DatabaseIcon.Board]: {
		paths: ["M3 2.5h2.5v11H3zM6.75 2.5h2.5v8h-2.5zM10.5 2.5H13v6h-2.5z"],
	},
	[DatabaseIcon.Calendar]: {
		paths: ["M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2v3M10.5 2v3"],
	},
	[DatabaseIcon.Timeline]: {
		paths: ["M2 8h12", "M3.5 4h5v2h-5zM6 10h6.5v2H6z", "M4.5 4v2M10.5 10v2"],
	},
	[DatabaseIcon.Filter]: {
		paths: ["M2.5 3.5h11l-4 5v4l-3 1.5v-5.5l-4-5Z"],
	},
	[DatabaseIcon.Sort]: {
		paths: ["M4 3v10M4 13l-2-2M4 13l2-2M12 13V3M12 3l-2 2M12 3l2 2"],
	},
	[DatabaseIcon.Database]: {
		paths: [
			"M3 4c0-1 2.2-2 5-2s5 1 5 2-2.2 2-5 2-5-1-5-2zM3 4v8c0 1 2.2 2 5 2s5-1 5-2V4M3 8c0 1 2.2 2 5 2s5-1 5-2",
		],
	},
};

export type CreateIconOptions = {
	size?: number;
	className?: string;
	title?: string;
};

/** Render a shared SDK glyph by `IconName`. Prefer this for any chrome glyph
 *  the registry exposes (Plus, Search, Settings, Close, Check, carets). */
export function createSharedIcon(
	name: IconName | `${IconName}`,
	options: CreateIconOptions = {},
): SVGSVGElement | HTMLSpanElement {
	return createIconElement(name, {
		...(options.size !== undefined ? { size: options.size } : {}),
		...(options.className !== undefined ? { className: options.className } : {}),
	});
}

/** Render a Database-local view-kind / filter / sort / database glyph. */
export function createIcon(glyph: DatabaseIcon, options: CreateIconOptions = {}): SVGSVGElement {
	// 1.25 on a 16-viewBox ≈ Phosphor Regular weight visually. The legacy
	// 1.5 read as Bold — list/sidebar rows looked heavy next to the text.
	return createGlyphElement(
		{ viewBox: "0 0 16 16", paths: SPECS[glyph].paths, strokeWidth: 1.25 },
		options,
	);
}

export function setIcon(host: Element, glyph: DatabaseIcon, options?: CreateIconOptions): void {
	host.replaceChildren(createIcon(glyph, options));
}

/** Set a shared SDK glyph as the sole child of `host` (the `setIcon` twin for
 *  registry glyphs). */
export function setSharedIcon(
	host: Element,
	name: IconName | `${IconName}`,
	options?: CreateIconOptions,
): void {
	host.replaceChildren(createSharedIcon(name, options));
}
