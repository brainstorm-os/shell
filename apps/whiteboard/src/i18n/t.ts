/**
 * Whiteboard-app translate function — now a thin binding over the shared
 * `@brainstorm-os/sdk/i18n` `createT` (B-2 landed; the per-app hand-rolled
 * `t()` is retired per the shared-fundamentals contract §C). The app owns
 * only its default-English manifest; lookup, `{param}` interpolation and
 * the missing-key fallback are the SDK's. Every user-visible string wraps
 * in `t(key)` per CLAUDE.md §Localization.
 */

import { type TParams, createT as sdkCreateT } from "@brainstorm-os/sdk/i18n";

export const WHITEBOARD_MANIFEST = {
	// App chrome
	"whiteboard.app.title": "Whiteboard",
	"whiteboard.canvas.aria": "Whiteboard canvas",
	"whiteboard.board.icon.change": "Change icon",

	// Toolbar — zoom. The two reset controls are distinct actions and carry
	// distinct accessible names (F-200): the % chip resets the zoom level
	// only; the corner-brackets button resets zoom AND pan.
	"whiteboard.zoom.out": "Zoom out",
	"whiteboard.zoom.in": "Zoom in",
	"whiteboard.zoom.resetLevel": "Reset zoom to 100%",
	"whiteboard.zoom.resetView": "Reset view",
	"whiteboard.zoom.level": "{percent}%",

	// Authoring toolbar (instruments panel)
	"whiteboard.tools.aria": "Authoring tools",
	"whiteboard.tools.select": "Select",
	"whiteboard.tools.sticky": "Sticky note",
	"whiteboard.tools.text": "Text",
	"whiteboard.tools.frame": "Frame",
	"whiteboard.tools.pen": "Pen",

	// Toolbar — add menu
	"whiteboard.export.menu": "Export",
	"whiteboard.export.svg": "Copy as SVG",
	"whiteboard.export.json": "Copy as JSON",
	"whiteboard.export.copied": "Copied",
	"whiteboard.export.failed": "Clipboard unavailable",
	"whiteboard.export.saveJson": "Save as JSON…",
	"whiteboard.export.saveSvg": "Save as SVG…",
	"whiteboard.export.savePng": "Save as PNG…",
	"whiteboard.export.saveDialogTitle": "Save board export",
	"whiteboard.export.saved": "Saved",
	"whiteboard.export.saveFailed": "Save failed",
	"whiteboard.export.saveUnavailable": "Save unavailable",
	"whiteboard.export.formatLegend": "Format",
	"whiteboard.export.action": "Export",
	"whiteboard.export.cancel": "Cancel",
	"whiteboard.export.destination": "Destination",
	"whiteboard.export.toFile": "Save to file",
	"whiteboard.export.toClipboard": "Copy to clipboard",
	"whiteboard.export.fmtSvg": "SVG",
	"whiteboard.export.fmtJson": "JSON",
	"whiteboard.export.fmtPng": "PNG",
	"whiteboard.add.menu": "Add to board",
	"whiteboard.add.sticky": "Sticky note",
	"whiteboard.add.text": "Text",
	"whiteboard.add.image": "Image…",
	"whiteboard.add.imageDialogTitle": "Add image to board",
	"whiteboard.add.embed": "Embed entity…",
	"whiteboard.add.frame": "Frame",
	"whiteboard.add.rectangle": "Rectangle",
	"whiteboard.add.ellipse": "Ellipse",
	"whiteboard.add.triangle": "Triangle",
	"whiteboard.add.diamond": "Diamond",
	"whiteboard.add.line": "Line",
	"whiteboard.add.arrow": "Arrow",
	"whiteboard.add.group": "Group selection",

	// Toolbar — arrange (align / distribute) menu
	"whiteboard.arrange.menu": "Arrange",
	"whiteboard.arrange.alignLeft": "Align left",
	"whiteboard.arrange.alignCenterX": "Align horizontal centers",
	"whiteboard.arrange.alignRight": "Align right",
	"whiteboard.arrange.alignTop": "Align top",
	"whiteboard.arrange.alignMiddleY": "Align vertical centers",
	"whiteboard.arrange.alignBottom": "Align bottom",
	"whiteboard.arrange.distributeH": "Distribute horizontally",
	"whiteboard.arrange.distributeV": "Distribute vertically",
	"whiteboard.arrange.toFront": "Bring to front",
	"whiteboard.arrange.forward": "Bring forward",
	"whiteboard.arrange.backward": "Send backward",
	"whiteboard.arrange.toBack": "Send to back",
	"whiteboard.arrange.lock": "Lock",
	"whiteboard.arrange.unlock": "Unlock",

	// Style menu (9.17.12, regrouped for F-200) — value rows are single
	// words; the section heading carries the category (one label idiom).
	"whiteboard.style.menu": "Style",
	"whiteboard.style.menuDisabled": "Style — select an object or connector first",
	"whiteboard.style.section.textSize": "Text size",
	"whiteboard.style.section.fill": "Fill",
	"whiteboard.style.section.textColor": "Text colour",
	"whiteboard.style.section.font": "Font",
	"whiteboard.style.section.emphasis": "Emphasis",
	"whiteboard.style.size.small": "Small",
	"whiteboard.style.size.medium": "Medium",
	"whiteboard.style.size.large": "Large",
	"whiteboard.style.needText": "Select a sticky or text node",
	"whiteboard.style.needSticky": "Select a sticky note",
	"whiteboard.style.fill.yellow": "Yellow",
	"whiteboard.style.fill.green": "Green",
	"whiteboard.style.fill.blue": "Blue",
	"whiteboard.style.fill.pink": "Pink",
	"whiteboard.style.fill.purple": "Purple",
	"whiteboard.style.fill.gray": "Gray",
	"whiteboard.style.textColor.default": "Default",
	"whiteboard.style.textColor.red": "Red",
	"whiteboard.style.textColor.amber": "Amber",
	"whiteboard.style.textColor.green": "Green",
	"whiteboard.style.textColor.blue": "Blue",
	"whiteboard.style.textColor.purple": "Purple",
	"whiteboard.style.font.sans": "Sans",
	"whiteboard.style.font.serif": "Serif",
	"whiteboard.style.font.mono": "Mono",
	"whiteboard.style.bold": "Bold",
	"whiteboard.style.italic": "Italic",

	// Inline formatting toolbar (9.17.12 rest) — shown while editing a
	// sticky / text node; formats the selected run range.
	"whiteboard.format.toolbar": "Text formatting",
	"whiteboard.format.bold": "Bold",
	"whiteboard.format.italic": "Italic",
	"whiteboard.format.underline": "Underline",
	"whiteboard.format.strike": "Strikethrough",

	// Connector styling (9.17.16) — shown on the Style ▾ menu when a
	// connector is selected (single-click a connector to select it).
	"whiteboard.connector.routing.bezier": "Route: Curved",
	"whiteboard.connector.routing.step": "Route: Right-angle",
	"whiteboard.connector.routing.straight": "Route: Straight",
	"whiteboard.connector.arrow.none": "End: No arrow",
	"whiteboard.connector.arrow.arrow": "End: Arrow",
	"whiteboard.connector.arrow.dot": "End: Dot",
	"whiteboard.connector.arrow.box": "End: Box",
	"whiteboard.connector.arrow.diamond": "End: Diamond",
	"whiteboard.connector.bidirectional": "Both ends arrowed",
	"whiteboard.connector.dashed": "Dashed line",
	"whiteboard.connector.color.default": "Colour: Default",
	"whiteboard.connector.color.blue": "Colour: Blue",
	"whiteboard.connector.color.green": "Colour: Green",
	"whiteboard.connector.color.red": "Colour: Red",
	"whiteboard.connector.color.amber": "Colour: Amber",
	"whiteboard.connector.color.gray": "Colour: Gray",

	// Left object-navigation sidebar (B8.2)
	"whiteboard.nav.aria": "Boards",
	"whiteboard.nav.toggle": "Toggle board list",
	"whiteboard.nav.show": "Show board list",
	"whiteboard.nav.hide": "Hide board list",
	"whiteboard.nav.resize": "Resize board list",
	"whiteboard.nav.search.placeholder": "Search boards",
	"whiteboard.nav.search.clear": "Clear search",
	"whiteboard.nav.new": "New whiteboard",
	// New-from-template menu (9.17.18)
	"whiteboard.template.blank": "Blank board",
	"whiteboard.template.kanban": "Kanban columns",
	"whiteboard.template.flowchart": "Flowchart",
	"whiteboard.template.mindMap": "Mind map",
	"whiteboard.nav.empty": "No boards",
	"whiteboard.nav.emptySearch": "No boards match “{query}”",
	"whiteboard.untitled": "Untitled whiteboard",

	// In-place board rename (F-198)
	"whiteboard.board.rename.aria": "Rename board",
	"whiteboard.board.rename.hint": "Double-click to rename",
	"whiteboard.board.lock": "Lock board (read-only)",
	"whiteboard.board.unlock": "Unlock board",

	// Object menu
	"whiteboard.menu.more": "More actions",

	// Node defaults / placeholders
	"whiteboard.node.sticky.placeholder": "New note",
	"whiteboard.node.text.placeholder": "Text",
	"whiteboard.node.frame.title": "Frame",
	"whiteboard.node.image.alt": "Image",

	// Node accessible names
	"whiteboard.node.sticky.aria": "Sticky note: {text}",
	"whiteboard.node.text.aria": "Text: {text}",
	"whiteboard.node.image.aria": "Image: {alt}",
	"whiteboard.node.frame.aria": "Frame: {title}",
	"whiteboard.node.group.aria": "Group of {count} items",
	"whiteboard.node.embedded.aria": "Embedded entity",
	"whiteboard.node.shape.aria": "Shape: {shape}",
	"whiteboard.node.ink.aria": "Freehand drawing",
	"whiteboard.shape.rectangle": "Rectangle",
	"whiteboard.shape.ellipse": "Ellipse",
	"whiteboard.shape.triangle": "Triangle",
	"whiteboard.shape.diamond": "Diamond",
	"whiteboard.shape.line": "Line",
	"whiteboard.shape.arrow": "Arrow",

	// Layers panel (9.17.13)
	"whiteboard.layers.region": "Layers",
	"whiteboard.layers.title": "Layers",
	"whiteboard.layers.toggle": "Layers",
	"whiteboard.layers.close": "Close layers panel",
	"whiteboard.layers.empty": "No objects yet",
	"whiteboard.layers.show": "Show",
	"whiteboard.layers.hide": "Hide",
	"whiteboard.layers.locked": "Locked",
	"whiteboard.layer.kind.sticky": "Sticky note",
	"whiteboard.layer.kind.text": "Text",
	"whiteboard.layer.kind.image": "Image",
	"whiteboard.layer.kind.frame": "Frame",
	"whiteboard.layer.kind.group": "Group",
	"whiteboard.layer.kind.embedded": "Embedded",
	"whiteboard.layer.kind.shape": "Shape",
	"whiteboard.layer.kind.ink": "Drawing",
	"whiteboard.node.editor.aria": "Edit node text",
	"whiteboard.edge.label.aria": "Edit connector label",
	"whiteboard.edge.label.placeholder": "Label…",

	// Hint footer — discoverability of the create chords
	"whiteboard.hint":
		"S sticky · T text · F frame · drag to move · double-click to edit · drag a handle to connect · pinch or Ctrl-scroll to zoom",

	// Canvas keyboard a11y (KBN-A-whiteboard) — live-region announcements when
	// keyboard focus selects a node, a node nudges, or the selection clears.
	// Nodes are focusable DOM (Tab cycles them natively); these speak the
	// otherwise-invisible selection state for screen readers.
	"whiteboard.a11y.selected": "Selected {name}, at {x}, {y}",
	"whiteboard.a11y.selectedMany": "{count} objects selected",
	"whiteboard.a11y.cleared": "Selection cleared",
	"whiteboard.a11y.deleted.one": "Deleted {count} object",
	"whiteboard.a11y.deleted.other": "Deleted {count} objects",
	"whiteboard.a11y.kind.sticky": "Sticky note",
	"whiteboard.a11y.kind.text": "Text",
	"whiteboard.a11y.kind.image": "Image",
	"whiteboard.a11y.kind.embedded": "Embedded entity",
	"whiteboard.a11y.kind.frame": "Frame",
	"whiteboard.a11y.kind.group": "Group",
	"whiteboard.a11y.kind.shape": "Shape",
	"whiteboard.a11y.kind.ink": "Drawing",
} as const;

export type WhiteboardMessageKey = keyof typeof WHITEBOARD_MANIFEST;
export type TranslationParams = TParams;

/** Build the app-scoped `t()`. A localised host can later pass overrides
 *  (the same shape the SDK accepts) — none today. */
export function createT(
	overrides?: Partial<Record<WhiteboardMessageKey, string>>,
): (key: WhiteboardMessageKey, params?: TParams) => string {
	return sdkCreateT(WHITEBOARD_MANIFEST, overrides);
}

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. The count
 *  selection lives in the shared SDK helper, never in component code
 *  (CLAUDE.md §Localization). */
export function pluralWith(
	t: (key: WhiteboardMessageKey, params?: TParams) => string,
	count: number,
	oneKey: WhiteboardMessageKey,
	otherKey: WhiteboardMessageKey,
	params?: TParams,
): string {
	// The sanctioned home for the `count === 1` branch (CLAUDE.md
	// §Localization) — never in component code.
	return t(count === 1 ? oneKey : otherKey, { count, ...params });
}
