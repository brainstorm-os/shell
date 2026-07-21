/**
 * Pure decision for the readable-content (re)capture (`captureContent`).
 * Extracted so the "does a fetched body replace the stored one" policy is
 * unit-tested without the shell / network broker.
 */

import type { SerializedBlock } from "@brainstorm-os/sdk-types";

/**
 * The captured blocks that should replace a bookmark's stored body, or null to
 * keep what's already there.
 *
 * `network.readable` returns `blocks: null` when the fetch succeeded but no
 * readable body was recovered (a JS-only SPA, a paywall, an extraction-worker
 * hiccup); an empty array means the same. On the FIRST capture there's nothing
 * to lose, but on a RE-capture ("Reload from source") replacing the body with
 * nothing silently wipes the content the user already captured — so an
 * empty/absent result keeps the existing body untouched.
 */
export function capturedBlocksToApply(
	blocks: SerializedBlock[] | null | undefined,
): SerializedBlock[] | null {
	if (!blocks || blocks.length === 0) return null;
	return blocks;
}
