/**
 * In-memory demo mail for the no-vault preview (outside the shell, or before
 * a mail account is connected). Shaped exactly like the entities the
 * `MailTransport` worker projects, so the real and demo paths run the same
 * projection code.
 */

import { AuthKind, MailFlag, MailProtocol, SyncWindow } from "@brainstorm-os/sdk-types";
import {
	EMAIL_TYPE_URL,
	FolderRole,
	MAIL_ACCOUNT_TYPE_URL,
	MAIL_FOLDER_TYPE_URL,
	type VaultEntityLike,
} from "../types/mail-view";

const DAY = 24 * 60 * 60 * 1000;
// A fixed epoch so the preview is deterministic (no Date.now() churn).
const BASE = 1_717_000_000_000;

export function demoEntities(): VaultEntityLike[] {
	const acct = "demo-acct";
	const inbox = "demo-folder-inbox";
	const sent = "demo-folder-sent";
	const archive = "demo-folder-archive";

	return [
		{
			id: acct,
			type: MAIL_ACCOUNT_TYPE_URL,
			properties: {
				address: "you@example.com",
				displayName: "You",
				protocol: MailProtocol.Imap,
				authKind: AuthKind.AppPassword,
				incoming: { host: "imap.example.com", port: 993, tls: true },
				outgoing: { host: "smtp.example.com", port: 465, tls: true },
				syncWindow: SyncWindow.Days90,
				enabled: true,
			},
		},
		{
			id: inbox,
			type: MAIL_FOLDER_TYPE_URL,
			properties: { accountRef: acct, path: "INBOX", role: FolderRole.Inbox, unreadCount: 2 },
		},
		{
			id: sent,
			type: MAIL_FOLDER_TYPE_URL,
			properties: {
				accountRef: acct,
				path: "[Gmail]/Sent Mail",
				role: FolderRole.Sent,
				unreadCount: 0,
			},
		},
		{
			id: archive,
			type: MAIL_FOLDER_TYPE_URL,
			properties: { accountRef: acct, path: "Archive", role: FolderRole.Archive, unreadCount: 0 },
		},
		{
			id: "demo-email-1",
			type: EMAIL_TYPE_URL,
			properties: {
				accountRef: acct,
				folderRefs: [inbox],
				messageId: "<atlas-kickoff@example.com>",
				threadKey: "atlas-kickoff@example.com",
				from: [{ address: "dana@northbound.co", name: "Dana Lee" }],
				to: [{ address: "you@example.com", name: "You" }],
				subject: "Project Atlas — kickoff Thursday 10am",
				receivedAt: BASE - 2 * 60 * 60 * 1000,
				bodyText:
					"Hi — confirming the Atlas kickoff for Thursday at 10am. Agenda: scope, owners, first milestone. Can you bring the draft brief?",
				bodyHtmlSafe:
					"<p>Hi —</p><p>Confirming the <strong>Atlas kickoff</strong> for <em>Thursday at 10am</em>.</p><ul><li>Scope</li><li>Owners</li><li>First milestone</li></ul><p>Can you bring the draft brief?</p><p>— Dana</p>",
				flags: [MailFlag.Unread],
				tags: [],
			},
		},
		{
			id: "demo-email-2",
			type: EMAIL_TYPE_URL,
			properties: {
				accountRef: acct,
				folderRefs: [inbox],
				messageId: "<weekly-digest-22@news.example.com>",
				threadKey: "weekly-digest-22@news.example.com",
				from: [{ address: "digest@news.example.com", name: "Industry Weekly" }],
				to: [{ address: "you@example.com" }],
				subject: "Your weekly digest is here",
				receivedAt: BASE - 1 * DAY,
				bodyText: "This week: five stories you might have missed.",
				bodyHtmlSafe:
					'<h2>This week</h2><p>Five stories you might have missed.</p><img src="https://tracker.example.com/pixel.gif?id=42" width="1" height="1" alt=""><p><a href="https://news.example.com/story/1">Read story one</a></p>',
				flags: [MailFlag.Unread],
				tags: [],
			},
		},
		{
			id: "demo-email-3",
			type: EMAIL_TYPE_URL,
			properties: {
				accountRef: acct,
				folderRefs: [inbox],
				messageId: "<reply-atlas@example.com>",
				threadKey: "atlas-kickoff@example.com",
				from: [{ address: "sam@northbound.co", name: "Sam Ortiz" }],
				to: [{ address: "you@example.com" }, { address: "dana@northbound.co" }],
				subject: "Re: Project Atlas — kickoff Thursday 10am",
				receivedAt: BASE - 30 * 60 * 1000,
				bodyText: "Works for me. I'll own the milestone tracker.",
				bodyHtmlSafe: "<p>Works for me. I'll own the milestone tracker.</p><p>— Sam</p>",
				flags: [MailFlag.Flagged],
				tags: [],
			},
		},
		{
			id: "demo-email-4",
			type: EMAIL_TYPE_URL,
			properties: {
				accountRef: acct,
				folderRefs: [sent],
				messageId: "<re-brief@example.com>",
				threadKey: "atlas-kickoff@example.com",
				from: [{ address: "you@example.com", name: "You" }],
				to: [{ address: "dana@northbound.co", name: "Dana Lee" }],
				subject: "Re: Project Atlas — kickoff Thursday 10am",
				receivedAt: BASE - 90 * 60 * 1000,
				bodyText: "Got it — bringing the brief. See you Thursday.",
				bodyHtmlSafe: "<p>Got it — bringing the brief. See you Thursday.</p>",
				flags: [],
				tags: [],
			},
		},
	];
}
