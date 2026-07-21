/**
 * The object's OWN icon, read + validated to the universal `Icon` shape.
 *
 * Per-object-icons-everywhere (foundations/39-universal-icons.md): a record's
 * `properties.icon` is the ONLY thing that renders as *its* icon; the type
 * glyph is fallback-only. `readEntityIcon` returns the validated own `Icon`
 * or `null` (→ caller falls back to the type glyph) — never the type glyph.
 *
 * Pure + synchronous, deliberately free of the renderer graph so tests can
 * import it without booting the Database app (`src/app.ts` boots at
 * module-eval, scheduling async work that outlives a jsdom test env).
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { IconKind } from "../types/icon";
import type { EntityRow } from "./in-memory-entities";

export function readEntityIcon(entity: EntityRow): Icon | null {
	const raw = entity.properties.icon;
	if (!raw || typeof raw !== "object") return null;
	const c = raw as { kind?: unknown; value?: unknown };
	if (typeof c.value !== "string" || c.value.length === 0) return null;
	if (c.kind === IconKind.Pack || c.kind === IconKind.Emoji || c.kind === IconKind.Image) {
		return c as Icon;
	}
	return null;
}
