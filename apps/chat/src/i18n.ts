/**
 * Chat app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm/sdk/i18n`) — no bare literals. `createT`
 * does `{name}` interpolation only (no ICU); plurals go through the shared
 * `plural` helper against two catalog keys.
 */

import { createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";

export const CHAT_I18N = {
	"app.title": "Chat",
	"header.members.show": "Show members",
	"header.members.hide": "Hide members",
	"header.members.disabled": "Open a channel to see its members",
	"header.moreActions": "More actions",

	"menu.editIdentity": "Change display name…",

	"sidebar.channels": "Channels",
	"sidebar.newChannel": "New channel",
	"sidebar.empty": "No channels yet.",
	"sidebar.show": "Show channels",
	"sidebar.hide": "Hide channels",

	"channel.empty.title": "No messages yet",
	"channel.empty.blurb": "Say hello to start the conversation in #{name}.",
	"channel.none.title": "Pick a channel",
	"channel.none.blurb": "Choose a channel on the left, or create one to start chatting.",

	"composer.placeholder": "Message #{name}…",
	"composer.send": "Send",
	"composer.attach.button": "Add context",
	"composer.attach.mention": "Mention a person…",
	"composer.attach.linkDocument": "Link a document…",
	"composer.attach.linkDocument.placeholder": "Search documents…",
	"composer.attach.linkDocument.aria": "Link a document",
	"composer.attach.linkDocument.empty": "No documents found",
	"composer.attach.upload": "Upload media…",
	"composer.attach.search": "Mention a person",
	"composer.attach.empty": "No people found",
	"composer.attach.remove": "Remove {label}",

	"members.title": "Members",
	"members.you": "you",
	"members.guest": "guest",
	"members.unknown": "Unknown member",
	"members.one": "{count} member",
	"members.other": "{count} members",

	"newChannel.title": "New channel",
	"newChannel.name.label": "Name",
	"newChannel.name.placeholder": "e.g. general",
	"newChannel.topic.label": "Topic (optional)",
	"newChannel.topic.placeholder": "What's this channel about?",
	"newChannel.cancel": "Cancel",
	"newChannel.create": "Create channel",

	"identity.title": "Your display name",
	"identity.label": "Display name",
	"identity.placeholder": "How you appear to others",
	"identity.cancel": "Cancel",
	"identity.save": "Save",

	"day.today": "Today",
	"day.yesterday": "Yesterday",
} as const;

export type ChatMessageId = keyof typeof CHAT_I18N;

export const t = createT(CHAT_I18N);

/** Catalog-bound plural (the sanctioned app-side plural seam). */
export function plural(count: number, one: ChatMessageId, other: ChatMessageId): string {
	return sdkPlural(t, count, one, other);
}
