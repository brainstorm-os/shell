/**
 * Re-export shim — `dispatchOpenEntity` now lives in `@brainstorm-os/editor`
 * (it routes through the host-injected `openEntity`, wired in Notes' boot
 * via `setEditorHost`). Notes-local imports keep working through here;
 * new code should import from `@brainstorm-os/editor` directly.
 */

export { dispatchOpenEntity } from "@brainstorm-os/editor";
