/**
 * Re-export shim — mention trigger/filter ops now live in
 * `@brainstorm-os/editor`. Notes-local imports (transclusion / block-embed /
 * link-markup typeaheads) keep working through here; new code should
 * import from `@brainstorm-os/editor` directly.
 */

export {
	type MentionTrigger,
	type EntityFilterResult,
	detectMentionTrigger,
	entityDisplayName,
	filterEntities,
} from "@brainstorm-os/editor";
