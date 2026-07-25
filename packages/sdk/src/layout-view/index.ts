/**
 * `@brainstorm-os/sdk/layout-view` — the `brainstorm/Layout/v1` render
 * pipeline (Stage 8.3).
 *
 * `resolveLayout` (8.2) picks which layout wins; this renders it.
 * Import the CSS subpath (`@brainstorm-os/sdk/layout-view.css`) — it
 * owns the stacked / grid / freeform geometry.
 */

export { LayoutView, type LayoutViewProps, type LayoutViewSeams } from "./LayoutView";
export {
	type CellStyle,
	cellStyle,
	containerClass,
	freeformExtent,
	groupMode,
	isCellVisible,
	orderedSiblings,
	planSiblings,
	readingOrderRank,
} from "./plan";
export {
	type LayoutValueSource,
	type MutableLayoutValueSource,
	createLayoutValueSource,
	staticLayoutValueSource,
} from "./value-source";
