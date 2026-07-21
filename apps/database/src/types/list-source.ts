/**
 * Re-export shim — `ListSource` (the criteria that produce dynamic members
 * of a List) is now canonical in `@brainstorm-os/sdk-types` (9.3.5.1b). The
 * in-app `../types/list-source` import sites are untouched while the single
 * source of truth lives in sdk-types. `ListMode` is the shared
 * Collection-contract derived label (promoted in 9.3.5.1).
 */

export {
	CompositeOp,
	LinkDirection,
	type ListSource,
	type ListSourceByFilter,
	type ListSourceByLink,
	type ListSourceByType,
	type ListSourceByVocabulary,
	type ListSourceComposite,
	ListSourceKind,
	ListMode,
} from "@brainstorm-os/sdk-types";
