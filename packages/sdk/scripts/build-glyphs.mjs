/**
 * Regenerates `src/icon/icon-glyphs.ts` — the pure-DOM `<Icon>` twin's glyph
 * pack — from the pinned `@phosphor-icons/core` asset SVGs.
 *
 * The pack mirrors the full `ICON_ASSET` registry — one glyph per `IconName`,
 * keyed by the enum VALUE — so the pure-DOM `createIconElement` can paint any
 * name the React `<Icon>` can. Add a name to the registry (`icon-registry.ts`)
 * then re-run `bun run --filter @brainstorm-os/sdk build:glyphs`.
 *
 * The asset → markup extraction matches the committed bytes exactly (Phosphor
 * is pinned), so a clean run is purely additive for any newly-registered name.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const REGISTRY = join(PKG_ROOT, "src/icon/icon-registry.ts");
const OUT = join(PKG_ROOT, "src/icon/icon-glyphs.ts");
const ASSETS = join(PKG_ROOT, "node_modules/@phosphor-icons/core/assets");

const WEIGHTS = ["thin", "light", "regular", "bold", "fill", "duotone"];

/** Parse the registry into the ordered `IconName` members (enum order, which
 *  is the ICON_ASSET declaration order) plus member → enum value and member →
 *  Phosphor asset name. */
function parseRegistry() {
	const src = readFileSync(REGISTRY, "utf8");
	const value = {};
	for (const m of src.matchAll(/^\t(\w+)\s*=\s*"([^"]+)",/gm)) {
		value[m[1]] = m[2];
	}
	const asset = {};
	const order = [];
	for (const m of src.matchAll(/\[IconName\.(\w+)\]:\s*"([^"]+)",/g)) {
		asset[m[1]] = m[2];
		order.push(m[1]);
	}
	return { value, asset, order };
}

function innerMarkup(assetName, weight) {
	const file = weight === "regular" ? `${assetName}.svg` : `${assetName}-${weight}.svg`;
	const svg = readFileSync(join(ASSETS, weight, file), "utf8");
	return svg
		.replace(/^<svg[^>]*>/, "")
		.replace(/<\/svg>\s*$/, "")
		.trim();
}

const { value, asset, order } = parseRegistry();

const entries = order
	.map((member) => {
		const key = value[member];
		const assetName = asset[member];
		if (!key) throw new Error(`IconName.${member} has no enum value`);
		if (!assetName) throw new Error(`IconName.${member} has no ICON_ASSET mapping`);
		const weights = WEIGHTS.map(
			(w) => `\t\t${w}:\n\t\t\t${JSON.stringify(innerMarkup(assetName, w))},`,
		).join("\n");
		return `\t${JSON.stringify(key)}: {\n${weights}\n\t},`;
	})
	.join("\n");

const header = `/**
 * Phosphor glyph path data for the SDK's pure-DOM <Icon> twin
 * (createIconElement). GENERATED — do not hand-edit.
 *
 * Source: @phosphor-icons/core asset SVGs (thin/light/regular/bold/fill/
 * duotone), inner markup only. The React <Icon> uses @phosphor-icons/react
 * directly; this mirror exists so plain-DOM apps render the SAME glyph
 * without a build-time SVG loader (mirrors entity-icon.ts: self-contained,
 * stylesheet-independent). Keyed by the IconName enum value so it stays in
 * sync with the registry in ./icon-registry.ts.
 *
 * Regenerate: bun run --filter @brainstorm-os/sdk build:glyphs
 * (scripts/build-glyphs.mjs reads node_modules/@phosphor-icons/core/assets/
 * <weight>/<name>[-<weight>].svg for every glyph in the curated DOM_PACK).
 */

import type { IconWeight } from "./icon-registry";

export type GlyphMarkup = Record<IconWeight, string>;

export const ICON_GLYPHS: Record<string, GlyphMarkup> = {
${entries}
};
`;

writeFileSync(OUT, header, "utf8");
console.log(`[build:glyphs] wrote ${order.length} glyphs → ${OUT}`);
