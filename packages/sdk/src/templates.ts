/**
 * Templates foundation (B11.10) — the public SDK surface.
 *
 * Re-exports the pure template codec + the create-flow decision layer so any
 * app that hosts a create-flow (the "+ New" picker) or `@brainstorm/editor` (the
 * slash-menu / save-as-template) picks up templating from one place, rather than
 * each app re-importing the internal modules (66-templates.md §The shared
 * surfaces). The body copy (a template's `root` Y.XmlText ⇄ an entity's `root`)
 * stays the consuming surface's job — these modules are pure + dependency-free.
 */

export * from "./template-entity-codec";
export * from "./template-create-flow";
