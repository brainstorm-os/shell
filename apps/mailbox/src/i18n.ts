/**
 * Mailbox app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm/sdk/i18n`) — no bare literals. The
 * app-side `t()` does `{name}` interpolation only (no ICU plurals — that is
 * the renderer catalog's job).
 */

import { type TParams, createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";

export const MAILBOX_I18N = {
	"app.title": "Mailbox",

	"header.sidebar.show": "Show sidebar",
	"header.sidebar.hide": "Hide sidebar",
	"header.menu": "More actions",
	"header.syncNow": "Sync now",
	"menu.markAllRead": "Mark all as read",
	"menu.connect": "Connect Google account…",
	"menu.syncNow": "Sync now",

	"connect.title": "Connect Google account",
	"connect.help":
		"Create a Desktop-app OAuth client in Google Cloud Console (APIs & Services → Credentials), enable the Gmail API, then paste the client ID and secret here. Google opens in your browser to ask for consent; the credentials are sealed in this vault's keystore.",
	"connect.clientId": "OAuth client ID",
	"connect.clientId.placeholder": "….apps.googleusercontent.com",
	"connect.clientSecret": "Client secret",
	"connect.label": "Account label",
	"connect.label.placeholder": "Work, Personal…",
	"connect.waiting": "Waiting for Google — finish signing in in your browser.",
	"connect.error": "Connection failed: {message}",
	"connect.cancel": "Cancel",
	"connect.submit": "Connect",
	"connect.connecting": "Connecting…",
	"connect.mode": "Account type",
	"connect.mode.gmail": "Google",
	"connect.mode.imap": "IMAP / SMTP",
	"connect.imap.help":
		"Enter your mail server details and an app password. The password is sealed in this vault's keystore; TLS is always required — the connection upgrades via STARTTLS on a non-TLS port.",
	"connect.imap.address": "Email address",
	"connect.imap.address.placeholder": "you@example.com",
	"connect.imap.username": "Username",
	"connect.imap.username.placeholder": "Defaults to the address",
	"connect.imap.password": "App password",
	"connect.imap.host": "IMAP host",
	"connect.imap.port": "Port",
	"connect.imap.tls": "TLS",
	"connect.smtp.host": "SMTP host",
	"connect.smtp.port": "Port",
	"connect.smtp.tls": "TLS",

	"sync.running": "Syncing…",
	"sync.done": "Sync finished — {created} new, {updated} updated.",
	"sync.error": "Sync failed: {message}",
	"sync.dismiss": "Dismiss sync status",

	"cta.title": "No mail account yet",
	"cta.blurb": "Connect your Google account to sync mail into this vault.",
	"cta.connect": "Connect Gmail",

	"folders.unified": "All inboxes",
	"folders.flagged": "Flagged",
	"folders.sent": "Sent",
	"folders.drafts": "Drafts",
	"folders.archive": "Archive",
	"folders.trash": "Trash",
	"folders.spam": "Spam",
	"folders.aria": "Mail folders",
	"folders.unreadAria": "{count} unread",

	"list.search.placeholder": "Search mail",
	"list.search.aria": "Search mail by subject, sender, or text",
	"list.aria": "Messages",
	"list.empty.title": "No messages",
	"list.empty.blurb": "Mail for this folder will appear here once it syncs.",
	"list.noResults": "No messages match “{query}”.",
	"list.noSubject": "(no subject)",
	"list.noSender": "(unknown sender)",
	"list.attachment": "Has attachments",
	"list.unreadDot": "Unread",
	"list.thread.toggle.on": "Group by conversation",
	"list.thread.toggle.off": "Show all messages",
	"list.thread.count.one": "{count} message",
	"list.thread.count.other": "{count} messages",
	"list.thread.expand": "Expand conversation",
	"list.thread.collapse": "Collapse conversation",

	"reading.empty.title": "Select a message",
	"reading.empty.blurb": "Choose a message from the list to read it here.",
	"reading.back": "Back to messages",
	"reading.to": "To",
	"reading.cc": "Cc",
	"reading.markUnread": "Mark as unread",
	"reading.markRead": "Mark as read",
	"reading.flag": "Flag",
	"reading.unflag": "Unflag",
	"reading.reply": "Reply",
	"reading.forward": "Forward",

	"compose.title": "New message",
	"compose.open": "Compose",
	"compose.from": "From",
	"compose.from.pick": "Choose account",
	"compose.to": "To",
	"compose.to.placeholder": "name@example.com, …",
	"compose.cc": "Cc",
	"compose.subject": "Subject",
	"compose.body": "Message",
	"compose.cancel": "Cancel",
	"compose.send": "Send",
	"compose.sending": "Sending…",
	"compose.sent": "Message sent.",
	"compose.error": "Send failed: {message}",
	"compose.quoteHeader": "{sender} wrote:",

	"body.frameTitle": "Message content",
	"body.remote.blocked": "Remote images and content were blocked to protect your privacy.",
	"body.remote.show": "Show remote content",
	"body.empty": "This message has no displayable content.",

	"date.today": "Today",
	"date.tomorrow": "Tomorrow",
	"date.yesterday": "Yesterday",

	"demo.banner": "Preview data — connect a mail account to see real mail.",

	"widget.title": "Inbox",
	"widget.unread.one": "{count} unread",
	"widget.unread.other": "{count} unread",
	"widget.messages.one": "{count} message",
	"widget.messages.other": "{count} messages",
	"widget.empty": "Inbox is empty",
	"widget.open": "Open Mailbox",
} as const;

export type MailboxI18nKey = keyof typeof MAILBOX_I18N;

export const t = createT(MAILBOX_I18N);

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. The count
 *  selection lives in the shared SDK helper (the sanctioned place), never in
 *  component code. */
export const plural = (
	count: number,
	oneKey: MailboxI18nKey,
	otherKey: MailboxI18nKey,
	params?: TParams,
): string => sdkPlural(t, count, oneKey, otherKey, params);
