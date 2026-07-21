/**
 * Inbound address → existing `Person/v1` resolution (9.23.5; OQ-MB-6 resolved:
 * **link-to-existing, never auto-create**). The app-local twin of the shell's
 * `main/mailbox/person-resolver.ts`: given an email address (from a vCard
 * import, a connector field-map, or any inbound source), find the contact that
 * already lists it — and never mint a new Person on a miss. Promoting an
 * unknown address to a contact is an explicit user action in Contacts.
 *
 * Matching is case-insensitive via the shared `normalizeAddress` so an address
 * resolves identically here and on the shell projection path (the OQ-MB-6
 * keystone). Pure + unit-tested in isolation — no DOM, no services.
 */

import { normalizeAddress } from "@brainstorm-os/sdk-types";
import { PERSON_TYPE, type VaultEntityLike } from "../types/person";
import { toStringArray } from "./person-view";

/** Build a `normalisedEmail → personId` index over a vault snapshot. Every
 *  address a `Person/v1` lists maps to that person. First writer wins on a
 *  duplicate address, so the result is deterministic over the snapshot order
 *  (entities arrive id-ordered). Tolerates the same value shapes the list
 *  reads — bare string, `string[]`, or `{ value }` / `{ label }` envelopes —
 *  via `toStringArray`. */
export function buildPersonEmailIndex(
	entities: readonly VaultEntityLike[],
): ReadonlyMap<string, string> {
	const index = new Map<string, string>();
	for (const entity of entities) {
		if (entity.type !== PERSON_TYPE) continue;
		for (const email of toStringArray(entity.properties.email)) {
			const key = normalizeAddress(email);
			if (key && !index.has(key)) index.set(key, entity.id);
		}
	}
	return index;
}

/** The id of the existing `Person/v1` whose email matches `address`, or `null`
 *  on a miss. Never creates. */
export function resolvePersonIdByEmail(
	index: ReadonlyMap<string, string>,
	address: string,
): string | null {
	const key = normalizeAddress(address);
	return key ? (index.get(key) ?? null) : null;
}

/** The id of the existing `Person/v1` matching *any* of `addresses`, or `null`
 *  when none match. First-match wins (input order). Lets an inbound source
 *  with several addresses (a vCard card, a connector record) resolve to the one
 *  contact that already carries one of them — link-to-existing, never
 *  auto-create. */
export function resolvePersonIdByEmails(
	index: ReadonlyMap<string, string>,
	addresses: readonly string[],
): string | null {
	for (const address of addresses) {
		const id = resolvePersonIdByEmail(index, address);
		if (id) return id;
	}
	return null;
}
