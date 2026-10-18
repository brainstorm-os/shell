/**
 * Text colour + highlight model. The persisted representation is a plain
 * inline CSS `color` / `background-color` on the Lexical TextNode (Lexical
 * serialises a node's `style` verbatim, so this round-trips through the
 * entities.db body with no schema change).
 *
 * The palette is a curated, named set (not a free colour wheel) — same
 * spirit as property vocabulary colours: the chosen colour is user data,
 * but it resolves through a themable custom property so a theme can
 * retune the whole palette. A baked fallback in the `var(...)` keeps the
 * document readable even if the app stylesheet is swapped out.
 */

import { $getSelectionStyleValueForProperty, $patchStyleText } from "@lexical/selection";
import {
	$getNodeByKey,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	type LexicalEditor,
	type LexicalNode,
	type NodeKey,
	type TextNode,
} from "lexical";

/** The string values ARE the CSS property names — passed straight into
 *  `$patchStyleText`. */
export enum ColorTarget {
	Text = "color",
	Highlight = "background-color",
}

/** `Default` clears the property (inherit theme text colour / no
 *  highlight). Order here is the swatch order in the picker. */
export enum SwatchColor {
	Default = "default",
	Gray = "gray",
	Brown = "brown",
	Orange = "orange",
	Yellow = "yellow",
	Green = "green",
	Blue = "blue",
	Purple = "purple",
	Pink = "pink",
	Red = "red",
}

export const SWATCH_COLORS: readonly SwatchColor[] = [
	SwatchColor.Default,
	SwatchColor.Gray,
	SwatchColor.Brown,
	SwatchColor.Orange,
	SwatchColor.Yellow,
	SwatchColor.Green,
	SwatchColor.Blue,
	SwatchColor.Purple,
	SwatchColor.Pink,
	SwatchColor.Red,
];

type Hued = Exclude<SwatchColor, SwatchColor.Default>;

/** Baked fallbacks, used only if the app stylesheet doesn't define the
 *  matching custom property. Tuned for contrast on both themes — a
 *  highlight is a tint behind body text, so it resolves per theme via
 *  `light-dark()` (pale wash under dark text in light themes; deep tint
 *  under light text in dark themes). Text colours read on both grounds as
 *  a single value, so they stay flat. */
const FALLBACK: Record<Hued, { text: string; highlight: string }> = {
	[SwatchColor.Gray]: { text: "#8d8d8d", highlight: "light-dark(#e6e6e6, #3a3a3a)" },
	[SwatchColor.Brown]: { text: "#b07b54", highlight: "light-dark(#ecdfd5, #4a382c)" },
	[SwatchColor.Orange]: { text: "#e0823d", highlight: "light-dark(#fbe2cc, #523620)" },
	[SwatchColor.Yellow]: { text: "#d6b656", highlight: "light-dark(#fbf1c7, #4d4424)" },
	[SwatchColor.Green]: { text: "#5fa87d", highlight: "light-dark(#d6ecdb, #274034)" },
	[SwatchColor.Blue]: { text: "#5b9bd5", highlight: "light-dark(#d4e7f7, #22384d)" },
	[SwatchColor.Purple]: { text: "#a17fc4", highlight: "light-dark(#e7ddf4, #3a2f4d)" },
	[SwatchColor.Pink]: { text: "#d06a9c", highlight: "light-dark(#f7dcea, #4d2c3e)" },
	[SwatchColor.Red]: { text: "#dd6058", highlight: "light-dark(#fbdbd7, #4d2926)" },
};

/** The baked tint behind a swatch (a `light-dark()` pair) — also what an
 *  exported page with no app stylesheet falls back to. */
export function highlightFallback(color: SwatchColor): string | null {
	return color === SwatchColor.Default ? null : FALLBACK[color].highlight;
}

function channel(target: ColorTarget): "text" | "highlight" {
	return target === ColorTarget.Text ? "text" : "highlight";
}

/** The CSS value persisted in the node's inline `style`. `null` for
 *  Default → `$patchStyleText` removes the property entirely. */
export function swatchCssValue(target: ColorTarget, color: SwatchColor): string | null {
	if (color === SwatchColor.Default) return null;
	const ch = channel(target);
	return `var(--notes-swatch-${ch}-${color}, ${FALLBACK[color][ch]})`;
}

/** Inverse of {@link swatchCssValue} for reflecting the active swatch in
 *  the toolbar. Matches on the custom-property NAME, not the whole string,
 *  so text highlighted before a fallback retune (e.g. the light-dark()
 *  pass) still reflects its swatch. Unknown / empty → Default. */
export function swatchFromCss(target: ColorTarget, css: string): SwatchColor {
	const trimmed = css.trim();
	if (trimmed.length === 0) return SwatchColor.Default;
	const ch = channel(target);
	for (const color of SWATCH_COLORS) {
		if (color === SwatchColor.Default) continue;
		if (trimmed.startsWith(`var(--notes-swatch-${ch}-${color}`)) return color;
	}
	return SwatchColor.Default;
}

export function applySwatch(editor: LexicalEditor, target: ColorTarget, color: SwatchColor): void {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		$patchStyleText(selection, { [target]: swatchCssValue(target, color) });
	});
}

/** Reads the active swatch for `target` off the current selection. Must
 *  be called inside an editor read/update (it touches the selection). */
export function readActiveSwatch(target: ColorTarget): SwatchColor {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return SwatchColor.Default;
	return swatchFromCss(target, $getSelectionStyleValueForProperty(selection, target, ""));
}

/** Merge a single CSS declaration into an inline `style` string, preserving the
 *  others (the sibling colour channel + any future inline style). `null`
 *  removes the property (Default → no inline colour). */
export function mergeStyleProp(style: string, prop: string, value: string | null): string {
	const map = new Map<string, string>();
	for (const decl of style.split(";")) {
		const idx = decl.indexOf(":");
		if (idx < 0) continue;
		const key = decl.slice(0, idx).trim();
		const val = decl.slice(idx + 1).trim();
		if (key.length > 0) map.set(key, val);
	}
	if (value === null) map.delete(prop);
	else map.set(prop, value);
	return Array.from(map, ([k, v]) => `${k}: ${v}`).join("; ");
}

function collectTextNodes(node: LexicalNode, out: TextNode[]): void {
	if ($isTextNode(node)) {
		out.push(node);
		return;
	}
	if ($isElementNode(node)) {
		for (const child of node.getChildren()) collectTextNodes(child, out);
	}
}

/** Bulk colour (B11.7): apply a swatch to every text node inside the given
 *  block keys. Block-selection mode has no Lexical range to `$patchStyleText`,
 *  so each node's inline `style` is merged directly — the same persisted
 *  representation `applySwatch` writes through a selection. */
export function applySwatchToBlocks(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
	target: ColorTarget,
	color: SwatchColor,
): void {
	if (keys.size === 0) return;
	const value = swatchCssValue(target, color);
	editor.update(() => {
		const texts: TextNode[] = [];
		for (const key of keys) {
			const node = $getNodeByKey(key);
			if (node) collectTextNodes(node, texts);
		}
		for (const node of texts) node.setStyle(mergeStyleProp(node.getStyle(), target, value));
	});
}
