/**
 * Cell registry — a `(ValueType, PropertyView)` pair resolves to one
 * React component; cells pick scalar vs multi at runtime via
 * `def.count`, so the registry only keys off `(valueType, view)`.
 */

import type { CellProps, ValueType } from "@brainstorm-os/sdk-types";
import { PropertyView, ValueType as VT } from "@brainstorm-os/sdk-types";
import type { ComponentType } from "react";
import { CheckboxCell } from "./checkbox-cell";
import { DateCell, RelativeDateCell } from "./date-cell";
import { FileListCell, GalleryCell, ImageRowCell } from "./file-cell";
import { FormattedPillCell, FormattedPlainCell } from "./formatted-cell";
import { FormulaCell } from "./formula-cell";
import { LinkCardCell, LinkInlineCell } from "./link-cell";
import { MultilineCell } from "./multiline-cell";
import { PillCell } from "./pill-cell";
import { PlainCell } from "./plain-cell";
import { ProgressBarCell } from "./progress-cell";
import { RatingCell } from "./rating-cell";
import { TagCell } from "./tag-cell";
import { ToggleCell } from "./toggle-cell";

export type CellComponent = ComponentType<CellProps>;

export type CellRegistryKey = `${ValueType}::${PropertyView}`;

export function cellRegistryKey(valueType: ValueType, view: PropertyView): CellRegistryKey {
	return `${valueType}::${view}`;
}

const REGISTRY = new Map<CellRegistryKey, CellComponent>();

function register(valueType: ValueType, view: PropertyView, cell: CellComponent): void {
	REGISTRY.set(cellRegistryKey(valueType, view), cell);
}

// Text Pill / Plain — the formatted cell (plain text unchanged; Url /
// Email / Phone get red-border + tooltip validation visuals, B5.9).
register(VT.Text, PropertyView.Pill, FormattedPillCell);
register(VT.Text, PropertyView.Plain, FormattedPlainCell);

// Text Multiline — wrapping, multi-line value with an auto-growing editor.
register(VT.Text, PropertyView.Multiline, MultilineCell);

// Number Pill / Plain — generic scalar pill/plain.
register(VT.Number, PropertyView.Pill, PillCell);
register(VT.Number, PropertyView.Plain, PlainCell);

// Number Formula — read-only computed value over the entity's other properties.
register(VT.Number, PropertyView.Formula, FormulaCell);

// Date Pill / Plain / Calendar — the natural-language input paired with a
// month calendar (one popover). Date's default view is Pill. Relative
// renders "in 3 days" / "Yesterday" at rest with the same editor.
register(VT.Date, PropertyView.Pill, DateCell);
register(VT.Date, PropertyView.Plain, DateCell);
register(VT.Date, PropertyView.Calendar, DateCell);
register(VT.Date, PropertyView.Relative, RelativeDateCell);

// EntityRef Pill / Plain — legacy back-compat (pre-B5.9 these defaulted
// here before the Link cells existed; the matrix default is now
// LinkCard but stamped blocks may still carry Pill/Plain).
register(VT.EntityRef, PropertyView.Pill, PillCell);
register(VT.EntityRef, PropertyView.Plain, PlainCell);

// Boolean — Checkbox (default) + Toggle (switch).
register(VT.Boolean, PropertyView.Checkbox, CheckboxCell);
register(VT.Boolean, PropertyView.Toggle, ToggleCell);

// Tag / TagList — `text + vocabulary`. One component; it selects scalar
// (Select) vs multi (MultiSelect) at runtime via `isMultiValued(count)`.
register(VT.Text, PropertyView.Tag, TagCell);
register(VT.Text, PropertyView.TagList, TagCell);

// Number — ProgressBar (range min/max from the def's `range` modifier)
// and Rating (a row of stars, count from `range.max`).
register(VT.Number, PropertyView.ProgressBar, ProgressBarCell);
register(VT.Number, PropertyView.Rating, RatingCell);

// EntityRef File-aware views — accept-only drop targets (upload dep
// pending); one component, three keys.
register(VT.EntityRef, PropertyView.FileList, FileListCell);
register(VT.EntityRef, PropertyView.Gallery, GalleryCell);
register(VT.EntityRef, PropertyView.ImageRow, ImageRowCell);

// EntityRef Link views — stubbed note:* picker over the vaultEntities
// preview surface; one component, two keys. Chip / Card alias to the
// inline / card link cells so an entity ref picked via either view is
// editable (they were display-only PillCell/PlainCell before).
register(VT.EntityRef, PropertyView.LinkInline, LinkInlineCell);
register(VT.EntityRef, PropertyView.LinkCard, LinkCardCell);
register(VT.EntityRef, PropertyView.Chip, LinkInlineCell);
register(VT.EntityRef, PropertyView.Card, LinkCardCell);

/** Look up a cell. `undefined` when the (valueType, view) pair has no
 *  registered component yet (e.g. Tag / TagList / File views in B5.3). */
export function getCell(valueType: ValueType, view: PropertyView): CellComponent | undefined {
	return REGISTRY.get(cellRegistryKey(valueType, view));
}

/** Whether a (valueType, view) pair has a rendering cell. Lets the
 *  PropertyBlock / PropertyList show a "view unavailable" affordance
 *  when a user picks a view that hasn't shipped its cell yet. */
export function hasCell(valueType: ValueType, view: PropertyView): boolean {
	return REGISTRY.has(cellRegistryKey(valueType, view));
}

export function registeredCellKeys(): readonly CellRegistryKey[] {
	return [...REGISTRY.keys()];
}
