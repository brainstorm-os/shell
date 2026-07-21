/**
 * Re-export shim — `List/v1` (the single canonical entity for sets,
 * collections, and the hybrid in-between) is now canonical in
 * `@brainstorm-os/sdk-types` (9.3.5.1b). Mode-derivation logic still lives in
 * `../logic/list-mode.ts`; the membership sub-contract
 * (`MemberOverrides` et al.) was promoted in 9.3.5.1. The ~dozens of
 * in-app `../types/list` import sites are untouched while the single
 * source of truth lives in sdk-types. See
 * .
 */

export {
	type List,
	ListMode,
	MEMBERS_HARD_CAP,
	type MemberExclude,
	type MemberInclude,
	type MemberOverrides,
	type MemberOverrideSource,
} from "@brainstorm-os/sdk-types";
