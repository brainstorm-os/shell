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

import { typeDisplayName } from "@brainstorm/sdk/system-entities";
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

/** The entity's display string before truncation: first non-empty string
 *  among `name` → `title`, else a human type caption ("Note (untitled)").
 *  The old fallback painted `entity.id.slice(0, 8)` — but ids are
 *  `ent_<base36-timestamp>…`, so every title-less entity minted the same
 *  day collapsed to one identical internal fragment ("ent_mr15" ×7 on the
 *  canvas, F-320). Matches how Files captions untitled rows
 *  ("(untitled) · Note"), sized for a one-line node caption. */
export function rawNodeLabel(entity: EntityRow): string {
	const props = entity.properties as Record<string, unknown>;
	for (const raw of [props.name, props.title]) {
		if (typeof raw === "string" && raw.trim().length > 0) return raw;
	}
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
