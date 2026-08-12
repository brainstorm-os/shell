/**
 * The shell's binding of the shared "what is this object called?" chain
 * (`@brainstorm-os/sdk/entity-title` — title → name → displayName → label
 * → path leaf, type-agnostic on purpose: a Note has `title`, a Person has
 * `name`, a `Profile/v1` has only `displayName`, a `CodeFile/v1` only
 * `path`; none get a per-type allowlist).
 *
 * The search collector, the bin service and the dashboard pin resolver all
 * call this, so a renamed object surfaces identically in search, in the bin
 * and on a pinned tile — and, since the chain is the SDK's, identically to
 * the same object's Files tile / Graph node / Database row.
 *
 * The shell's fallback for a nameless object is "" — callers render their
 * own untitled caption.
 */

import { entityTitleOr } from "@brainstorm-os/sdk/entity-title";

export function deriveEntityTitle(properties: Record<string, unknown>): string {
	return entityTitleOr(properties, "");
}
