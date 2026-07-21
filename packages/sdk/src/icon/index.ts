/**
 * `@brainstorm-os/sdk/icon` — the app-side interface-glyph primitive.
 * `<Icon>` (React) and `createIconElement` (pure DOM) paint the SAME glyph
 * from one shared `IconName` enum + registry, mirroring the shell's
 * `ui/icon.tsx` so an app's chrome looks identical to the shell's. An
 * installed `IconPack/v1` overrides individual glyphs on top of that
 * built-in base (`setActiveIconPack` / `useIcon`).
 */

export { Icon, type IconProps } from "./icon";
export { createIconElement, type CreateIconOptions } from "./create-icon-element";
export { createGlyphElement, type GlyphOptions, type GlyphSpec } from "./builtin-glyph";
export { glyphIconParam } from "./glyph-icon-param";
export { ALL_ICON_NAMES, ICON_ASSET, IconDirection, IconName, IconWeight } from "./icon-registry";
export {
	getActiveIconPack,
	getIconPackEpoch,
	resolveIconOverride,
	setActiveIconPack,
	subscribeIconPack,
} from "./icon-pack-runtime";
export { useIcon } from "./use-icon";
