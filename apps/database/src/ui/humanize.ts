/**
 * Property name humanization for the inspector / view settings.
 *
 * The implementation is the shared `humanizeKey` (`@brainstorm-os/sdk`) — the
 * same labels the Files inspector and the Agent's proposed row cards render.
 * Kept under the app's own name because every call site here reads
 * `humanize(key)`.
 *
 * Stage 9.6 (properties service) replaces this with the dictionary lookup
 * wherever a real `PropertyDef` exists; this stays the no-def fallback.
 */

export { humanizeKey as humanize } from "@brainstorm-os/sdk";
