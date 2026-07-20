/**
 * Mailbox view-models + the canonical mail type URLs it reads. The three
 * `Mail*`/`Email` types are vault entities the shell-side `MailTransport`
 * worker projects; the app only reads them (received mail is immutable —
 * doc 53) and flips `flags`/`tags`. These view types are the typed shapes
 * the UI renders, projected from the entity property bags.
 */

import {
	EMAIL_TYPE_URL,
	FolderRole,
	MAIL_ACCOUNT_TYPE_URL,
	MAIL_FOLDER_TYPE_URL,
	type MailAddress,
	type MailAttachmentPart,
	MailFlag,
} from "@brainstorm/sdk-types";

export { EMAIL_TYPE_URL, MAIL_ACCOUNT_TYPE_URL, MAIL_FOLDER_TYPE_URL, FolderRole, MailFlag };
export type { MailAddress, MailAttachmentPart };

/** The minimal entity shape Mailbox consumes from the vault snapshot. */
export type VaultEntityLike = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
};

export type MailHostView = { host: string; port: number; tls: boolean };

/** A configured account, projected for the folder rail's grouping and the
 *  reconnect-in-place prefill (Mailbox-13). */
export type AccountView = {
	id: string;
	address: string;
	displayName: string;
	/** Present on IMAP accounts — seeds the reconnect dialog. */
	imap?: { incoming: MailHostView; outgoing: MailHostView; syncWindow?: string };
};

/** A folder/label row in the rail. `id` is the real `MailFolder/v1` entity
 *  id; a synthetic selection (unified inbox / flagged) is modelled by
 *  `FolderSelection`, not by a fake folder. */
export type FolderView = {
	id: string;
	accountRef: string;
	path: string;
	role: FolderRole;
	unreadCount: number;
	/** The older-walk for this folder is exhausted (Mailbox-12). */
	backfillDone: boolean;
};

/** A message, projected from an `Email/v1` property bag into typed UI shape. */
export type MessageView = {
	id: string;
	accountRef: string;
	folderRefs: string[];
	messageId: string;
	threadKey: string;
	from: MailAddress[];
	to: MailAddress[];
	cc: MailAddress[];
	subject: string;
	receivedAt: number;
	bodyText: string;
	bodyHtmlSafe: string;
	/** `File/v1` refs for parts whose bytes are already in the vault. */
	attachments: string[];
	/** What the server says the message carries (Mailbox-6). Present without
	 *  any download — chips render from this, and fetching a part on demand
	 *  is what mints its `File/v1`. */
	attachmentParts: MailAttachmentPart[];
	flags: MailFlag[];
	tags: string[];
	unread: boolean;
	flagged: boolean;
};

/** What the rail has selected. A unified inbox / flagged smart view is a
 *  query over messages (doc 53: "unified inbox as a saved `List/v1`"), not a
 *  real folder, so it is a selection kind rather than a folder id. */
export type FolderSelection =
	| { kind: "unified-inbox" }
	| { kind: "flagged" }
	| { kind: "folder"; folderId: string };
