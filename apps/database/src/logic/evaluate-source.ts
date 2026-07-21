/**
 * Re-export shim — the `ListSource` evaluator is now canonical in
 * `@brainstorm-os/sdk/predicate-eval` (promoted at 9.12.3 so the shell's
 * entities-service membership resolution runs the same code as this
 * renderer — parity by construction). In-app import sites are untouched.
 */

export { applyMemberOverrides, evaluateSource } from "@brainstorm-os/sdk/predicate-eval";
