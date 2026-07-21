/**
 * `@brainstorm-os/sdk/icon-picker` — the ONE icon picker + the emoji/Phosphor
 * data behind it. React `<IconPicker>` is the host-agnostic chooser
 * (labels injected per the SDK i18n convention); the data helpers
 * (`emojiUrl`, the Phosphor lazy-load) are what `EntityIcon` renders
 * with, so every app's icon *render* and icon *picker* share one source.
 */

export {
	IconPicker,
	type IconPickerProps,
	type IconPickerLabels,
	type IconUploadService,
} from "./picker";
export { DEFAULT_ICON_PICKER_LABELS } from "../i18n/common-labels";
export {
	EMOJI_GROUPS,
	ALL_EMOJIS,
	SKIN_TONE_BASE_CHARS,
	type EmojiData,
	type EmojiGroup,
	applySkinTone,
	emojiFilename,
	emojiUrl,
	searchEmojis,
} from "./emoji-data";
export {
	EMOJI_SHORTCODE_BODY,
	emojiShortcodeCandidates,
	resolveEmojiShortcode,
} from "./emoji-shortcode";
export {
	PHOSPHOR_GROUPS,
	PHOSPHOR_ICONS,
	PHOSPHOR_PACK_ID,
	type PhosphorComponent,
	type PhosphorGroup,
	type PhosphorMeta,
	findPhosphor,
	loadPhosphorReact,
	searchPhosphor,
	subscribePhosphorReact,
	tryGetPhosphorComponent,
} from "./phosphor-data";
