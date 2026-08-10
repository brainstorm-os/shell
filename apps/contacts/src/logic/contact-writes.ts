/**
 * Whether the read-only lock refuses a Contacts write — the one decision every
 * write path in this app asks, spelled once.
 *
 * Lock-5(b) gated `patchPerson` / `deletePerson` and stopped there, which left
 * three write paths that never reach either: "+ Add company" (writes `company`
 * onto the person), the page body editor, and the duplicates merge (which
 * patches the survivor and BINS the losers). The merge is why this takes a
 * LIST of ids rather than one: a write can touch several objects, and one
 * locked object among them refuses the whole operation — a half-refused merge
 * is worse than no merge.
 *
 * Pure — no DOM, no services, no React.
 */

import { lockRefusesWrite } from "@brainstorm-os/sdk/entity-lock";

/** Refuse a write that touches `ids`. `patch` is the property patch for a
 *  property write (so the lock-flip can be let through when it is the whole
 *  patch), and is OMITTED for a write with no patch to exempt — a delete, or a
 *  merge that destroys its losers. */
export function contactWriteRefused(
	isLocked: (id: string) => boolean,
	ids: readonly string[],
	patch?: Record<string, unknown>,
): boolean {
	return ids.some((id) => lockRefusesWrite(isLocked(id), patch));
}
