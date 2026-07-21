/**
 * Address → `Person/v1` resolution (Mailbox-7; OQ-MB-6 resolved:
 * **link-to-existing, never auto-create**). A participant address that
 * matches a contact's email gets a `personRef`, so Graph paints
 * sender↔thread↔task edges and a Database list can filter "Emails where
 * `from` is in my Investors collection" — all "for free" because the
 * participant is now a real entity ref (doc 53 §Agentic surface).
 *
 * We deliberately do **not** create a Person on first sight: that would
 * pollute the contact list with every newsletter sender (OQ-MB-6 / overlaps
 * OQ-CT-1). A user promotes an address to a contact explicitly in Contacts.
 *
 * Pure + dependency-light (reused by the sync engine's projection and
 * unit-tested directly). Matching is case-insensitive via the shared
 * `normalizeAddress` so it is identical to how the address was parsed.
 */

import { type MailAddress, normalizeAddress } from "@brainstorm-os/sdk-types";

export const PERSON_TYPE = "brainstorm/Person/v1";

/** The minimal entity shape the resolver reads. */
export type EntityLike = { id: string; type: string; properties: Record<string, unknown> };

/** Build a `normalisedEmail → personId` index from the entity snapshot. A
 *  `Person/v1` carries an `email: string[]`; every address it lists maps to
 *  that person. First writer wins on a duplicate address (deterministic over
 *  the snapshot order — the entities arrive id-ordered). */
export function buildPersonIndex(entities: readonly EntityLike[]): Map<string, string> {
	const index = new Map<string, string>();
	for (const entity of entities) {
		if (entity.type !== PERSON_TYPE) continue;
		const emails = entity.properties.email;
		if (!Array.isArray(emails)) continue;
		for (const email of emails) {
			if (typeof email !== "string" || email.length === 0) continue;
			const key = normalizeAddress(email);
			if (!index.has(key)) index.set(key, entity.id);
		}
	}
	return index;
}

/** The id of the `Person/v1` whose email matches `address`, or undefined. */
export function resolvePersonRef(
	index: ReadonlyMap<string, string>,
	address: string,
): string | undefined {
	return index.get(normalizeAddress(address));
}

/** Return a copy of `addresses` with `personRef` set where the address
 *  matches an existing contact. Never mutates the input; leaves unmatched
 *  addresses untouched (no auto-create). */
export function resolveParticipants(
	index: ReadonlyMap<string, string>,
	addresses: readonly MailAddress[],
): MailAddress[] {
	return addresses.map((addr) => {
		const ref = resolvePersonRef(index, addr.address);
		return ref ? { ...addr, personRef: ref } : { ...addr };
	});
}
