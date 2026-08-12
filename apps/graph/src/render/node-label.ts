/**
 * Shared node-label resolution + truncation. Extracted so the SVG renderer
 * and the Pixi DOM-overlay renderer derive the *same* label from the same
 * entity and apply the *same* hard character cap.
 *
 * Why this exists: the Pixi overlay used to call a private `labelFor` that
 * did **no** truncation while the `.graph-canvas__label` div had no CSS
 * rule — a long entity name overflowed unbounded across the canvas (a
 * silent prod regression after the 9.13.5 Pixi swap). The SVG renderer's
 * `labelFor` already capped at `NODE_LABEL_MAX_CHARS`; the two paths
 * diverged. One module, one cap, no divergence (DRY).
 *
 * The character cap is the model-level guard (deterministic, testable, no
 * DOM dependency). The render layer additionally ellipsises any residual
 * pixel overflow via `.graph-canvas__label` CSS — defence in depth, per
 * the [[long-strings-must-be-clipped]] convention (clip at the data layer
 * when possible AND at the render layer always).
 */

import { resolveEntityTitle } from "@brainstorm-os/sdk/entity-title";
import { typeDisplayName } from "@brainstorm-os/sdk/system-entities";
import { t } from "../i18n/t";
import type { EntityRow } from "../logic/in-memory-graph";

/** Hard character ceiling for a painted node label. A 48-glyph name is
 *  already wider than any sane node disc at default zoom; past it the
 *  label is noise. The CSS `max-width`/`text-overflow:ellipsis` rule is
 *  the pixel-precise second line of defence for whatever survives. */
export const NODE_LABEL_MAX_CHARS = 48;

/** Per-type memo for the untitled caption. `nodeLabel` runs per labeled
 *  node per pan/zoom frame (twice, via the Pixi overlay's width pass +
 *  text pass), and the fallback's `typeDisplayName` (split + 2 regexes +
 *  title-case) plus `t()` interpolation is real per-frame work the old
 *  `id.slice` fallback never did. A vault holds ~a dozen types, so the map
 *  stays tiny. A plain Map keyed on the type id alone is safe because the
 *  Graph `t` is module-stable — bound once over the static English
 *  manifest, no live locale switch (see `i18n/t.ts`). */
const untitledCaptionByType = new Map<string, string>();

/** The entity's display string before truncation: the SHARED title chain
 *  (`@brainstorm-os/sdk/entity-title` — title → name → displayName → label
 *  → path leaf), else a human type caption ("Note (untitled)").
 *
 *  The chain is not ours to pick: Graph used to prefer `name` over `title`
 *  and know nothing of `displayName`/`path`, so the same object was called
 *  one thing on the canvas and another on its Files tile (DS-entity-title-1).
 *  Only the FALLBACK is Graph's — the old one painted
 *  `entity.id.slice(0, 8)`, but ids are `ent_<base36-timestamp>…`, so every
 *  title-less entity minted the same day collapsed to one identical
 *  internal fragment ("ent_mr15" ×7 on the canvas, F-320). */
export function rawNodeLabel(entity: EntityRow): string {
	const resolved = resolveEntityTitle(entity.properties as Record<string, unknown>);
	if (resolved !== null) return resolved;
	let caption = untitledCaptionByType.get(entity.type);
	if (caption === undefined) {
		caption = t("node.untitled", { type: typeDisplayName(entity.type) });
		untitledCaptionByType.set(entity.type, caption);
	}
	return caption;
}

/** Resolve + hard-truncate a node label to at most `NODE_LABEL_MAX_CHARS`
 *  characters, appending an ellipsis when clipped. Trailing whitespace
 *  before the ellipsis is trimmed so we never render "foo …". */
export function nodeLabel(entity: EntityRow): string {
	const text = rawNodeLabel(entity);
	if (text.length <= NODE_LABEL_MAX_CHARS) return text;
	return `${text.slice(0, NODE_LABEL_MAX_CHARS - 1).trimEnd()}…`;
}
