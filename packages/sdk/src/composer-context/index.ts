/**
 * `@brainstorm/sdk/composer-context` — the shared composer "context rail": let a
 * chat composer attach explicit context to a turn (pinned documents, @-mentioned
 * people, uploaded media) so it reaches the agent. The durable wire shape is
 * `MessageAttachment` (sdk-types); this primitive owns the UI — the inline `@`
 * typeahead, the chip rail, the attach button — over a host-supplied search +
 * upload seam, so the Agent app and the Chats app build the same affordance.
 *
 * Pair the CSS subpath `@brainstorm/sdk/composer-context.css`.
 */

export {
	ATTACHMENTS_MAX,
	type ComposerContextHost,
	type ContextCandidate,
	MEDIA_BYTES_MAX,
	attachmentIcon,
	attachmentKey,
	attachmentLabel,
	candidateToAttachment,
	inlineMentionRefs,
	parseAttachments,
	visibleAttachments,
	withMentionAttachments,
} from "./types";
export { objectItemToAttachment } from "./object-attachment";
export { pickFile } from "./media";
export { type ComposerContextState, useComposerContext } from "./use-composer-context";
export {
	MENTION_QUERY_MAX,
	type MentionMatch,
	clearMentionToken,
	detectMention,
} from "./mention-detect";
export {
	type MentionTypeahead,
	type UseMentionTypeaheadOptions,
	useMentionTypeahead,
} from "./use-mention-typeahead";
export {
	ComposerContextRail,
	type ComposerContextRailProps,
} from "./ComposerContextRail";
export {
	AttachContextButton,
	type AttachContextButtonLabels,
	type AttachContextButtonProps,
} from "./AttachContextButton";
export { type ComposerObjectDropTarget, useComposerObjectDrop } from "./use-object-drop";
