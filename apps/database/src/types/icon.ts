/**
 * Re-export shim — the universal icon shape is now canonical in
 * `@brainstorm-os/sdk-types` (9.3.5.1b reconciled the former app-local mirror
 * with the SDK definition; the SDK's `Icon` is the superset — its `Pack`
 * variant additionally carries an optional `color` tint). The ~dozen
 * in-app `./icon` / `../types/icon` import sites are untouched while the
 * single source of truth lives in sdk-types.
 */

export { IconKind } from "@brainstorm-os/sdk-types";
export type { Icon } from "@brainstorm-os/sdk-types";
