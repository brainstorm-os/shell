/**
 * Contacts view-model + the canonical type URLs it reads. `Person/v1` is a
 * sanctioned canonical vault type shared with Database (OQ-CT-1); Contacts
 * owns read+write on it but does not redefine its shape. `Company/v1` is the
 * typed `Person.company` target (OQ-CT-2 — already landed with the
 * graph-link-reasons work); Contacts only reads it.
 */

import type { Cover, Icon } from "@brainstorm-os/sdk-types";

export const PERSON_TYPE = "brainstorm/Person/v1";
export const COMPANY_TYPE = "brainstorm/Company/v1";
export const PROJECT_TYPE = "brainstorm/Project/v1";

/** The minimal entity shape Contacts consumes from the vault snapshot. */
export type VaultEntityLike = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
};

/** A person, projected from a `Person/v1` entity's property bag into the
 *  typed shape the UI renders. `companyId` / `linkIds` are entity refs the
 *  UI resolves to names against the live snapshot. */
export type Person = {
	id: string;
	name: string;
	emails: string[];
	phones: string[];
	companyId: string | null;
	role: string;
	birthday: number | null;
	anniversary: number | null;
	linkIds: string[];
	bio: string;
	/** The person's OWN universal icon (`properties.icon`) — never a
	 *  synthesized default; `null` is genuinely unset (initials render). */
	icon: Icon | null;
	/** The person's OWN cover (`properties.cover`); `null` → no band. */
	cover: Cover | null;
};
