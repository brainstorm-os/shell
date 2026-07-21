/**
 * Re-export shim — `<EntityIcon>` now lives in `@brainstorm-os/editor`
 * (it's a pure SDK-icon React twin with no Notes coupling, shared by
 * every editor surface). Notes-local imports keep working through here;
 * new code should import from `@brainstorm-os/editor` directly.
 */

export { type EntityIconProps, EntityIcon } from "@brainstorm-os/editor";
