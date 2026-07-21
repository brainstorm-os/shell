/**
 * Re-export shim — the property-predicate / filter-tree language is now
 * canonical in `@brainstorm-os/sdk-types` (9.3.5.1b promoted the rich
 * app-local shape as the superset; the pre-9.3.5.1b thin `EntityQuery.where`
 * subset in sdk-types' `index.ts` was replaced by this definition). The
 * in-app `../types/predicate` import sites are untouched while the single
 * source of truth lives in sdk-types.
 */

export {
	type Comparand,
	type FilterGroupNode,
	FilterGroupOp,
	type FilterNode,
	FilterNodeKind,
	type FilterPredicateNode,
	isPropertyRef,
	type PropertyPath,
	type PropertyPredicate,
	type PropertyRef,
	type ScalarValue,
} from "@brainstorm-os/sdk-types";
