/**
 * Re-export shim — the `PropertyPredicate` evaluator is now canonical in
 * `@brainstorm-os/sdk/predicate-eval` (promoted at 9.12.3 so the shell's
 * `ListSource` query path and this renderer share ONE truth-table).
 * In-app import sites are untouched.
 */

export { evaluatePredicate } from "@brainstorm-os/sdk/predicate-eval";
