/**
 * The `MailDriver` transport interface — the protocol seam behind which IMAP,
 * JMAP, and provider-API drivers live (doc 53 §shell-vs-app split; OQ-MB-2:
 * the long-lived socket is owned inside the driver, never exposed to a
 * renderer). The shell-side sync engine + worker speak only this interface,
 * so a new provider is one new driver and zero engine changes — the connector
 * framework's "no provider code runs in the engine" discipline (doc 56)
 * applied to mail.
 *
 * A driver yields **raw** messages (header strings, unsanitised HTML); the
 * pure `mail-projection` layer parses + sanitises them into `Email/v1`
 * properties. Keeping parsing/sanitising out of the driver means every
 * driver shares one (audited) projection path.
 *
 * Leaf module: only sdk-types enums, so both the worker and the main-process
 * engine import it without pulling heavy deps into the worker bundle.
 */

import type {
	FolderRole,
	MailAttachmentPart,
	MailFlag,
	MailProtocol,
} from "@brainstorm-os/sdk-types";

/** A server folder/label as the driver sees it. `role` is the driver's best
 *  guess (e.g. IMAP `\Sent` special-use, Gmail label); the projection
 *  normalises a missing role from the path. */
export type RawFolder = {
	path: string;
	role?: FolderRole;
	unreadCount?: number;
};

/** A message as fetched, before parsing/sanitising. Header fields are raw
 *  strings (`"Dana Lee <dana@x.com>, bob@y.com"`) parsed by the projection;
 *  `bodyHtml` is **unsanitised** and must never reach a renderer un-projected. */
export type RawMessage = {
	messageId: string;
	/** Provider thread id where the protocol supplies one (Gmail/JMAP). */
	providerThreadId?: string;
	inReplyTo?: string;
	references?: string[];
	/** Raw `From` header value. */
	from: string;
	/** Raw `To` header value. */
	to?: string;
	/** Raw `Cc` header value. */
	cc?: string;
	subject?: string;
	receivedAt: number;
	bodyText?: string;
	bodyHtml?: string;
	flags?: MailFlag[];
	/** The folder/label this message was fetched from. */
	folderPath: string;
	/** Server-declared attachment metadata — names, types, and the
	 *  driver-issued part address. Sync stays metadata-only; bytes come later
	 *  via {@link MailDriver.fetchAttachment} on user demand (Mailbox-6). */
	attachmentParts?: MailAttachmentPart[];
};

/** Which way a fetch walks the folder (Mailbox-12). */
export enum FetchWalk {
	/** Newest-first within the window; `cursor` resumes past the last seen
	 *  message (the scheduled-sync walk). */
	Forward = "forward",
	/** Progressively OLDER mail, ignoring `sinceMs` — the user asked for
	 *  history beyond the window. `cursor` is the older-walk resume token;
	 *  absent starts at the newest and walks down. */
	Backfill = "backfill",
}

/** A bounded fetch request for one folder — the selective/incremental sync
 *  unit (doc 20). `sinceMs` bounds the initial walk by `syncWindow`
 *  (Forward only); `cursor` resumes a walk in the direction of `walk`;
 *  `limit` caps a single page. */
export type FetchSpec = {
	folderPath: string;
	sinceMs?: number;
	cursor?: string;
	/** Defaults to {@link FetchWalk.Forward}. */
	walk?: FetchWalk;
	limit: number;
};

export type FetchResult = {
	messages: RawMessage[];
	/** Opaque resume token for the SAME walk direction, persisted by the
	 *  caller; absent ⇒ that walk is caught up / exhausted. */
	nextCursor?: string;
};

/** An outbound message for SMTP/JMAP submission. `submissionId` is the
 *  client-stamped idempotency key — the engine refuses a duplicate so a
 *  flaky network never double-sends (doc 53 §Sending). */
export type OutboundMessage = {
	from: string;
	to: string[];
	cc?: string[];
	subject?: string;
	bodyText?: string;
	bodyHtml?: string;
	submissionId: string;
	inReplyTo?: string;
	references?: string[];
};

export type SubmitResult = {
	/** RFC 5322 `Message-ID` the server (or driver) assigned. */
	messageId: string;
	receivedAt: number;
};

/** Hard ceiling on a single attachment fetch. The server's declared size is
 *  advisory (a lying server must not size our buffer), so drivers enforce
 *  this against bytes actually received and abort past it. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Locate one attachment for a bounded, on-demand fetch (Mailbox-6). The
 *  `partRef` is the token the SAME driver minted during projection. */
export type FetchAttachmentSpec = {
	/** Folder to select before addressing the part (IMAP); provider-API
	 *  drivers whose `partRef` is globally addressable ignore it. */
	folderPath: string;
	/** The token this driver minted during projection. It encodes whatever
	 *  the protocol needs to reach the part (Gmail: message id + attachment
	 *  id; IMAP: uid + MIME part path), so no protocol state travels with the
	 *  caller. */
	partRef: string;
	/** Caller-supplied ceiling, clamped to {@link MAX_ATTACHMENT_BYTES}. */
	maxBytes?: number;
};

export type FetchAttachmentResult = {
	bytes: Uint8Array;
	/** Server-declared content type, if any — advisory (see
	 *  {@link MailAttachmentPart.mimeType}). */
	mimeType?: string;
};

/** The protocol engine for one account. Implementations own the long-lived
 *  socket(s); the engine/worker treat them as opaque. */
export type MailDriver = {
	readonly protocol: MailProtocol;
	listFolders(): Promise<RawFolder[]>;
	fetch(spec: FetchSpec): Promise<FetchResult>;
	submit(message: OutboundMessage): Promise<SubmitResult>;
	/** Fetch one attachment's bytes on demand. Optional: a driver that cannot
	 *  address parts simply omits it and the service reports `Unavailable`
	 *  rather than the app having to probe by protocol. */
	fetchAttachment?(spec: FetchAttachmentSpec): Promise<FetchAttachmentResult>;
	/** Release sockets / handles. Idempotent. */
	close(): Promise<void>;
};

/** Auth + host coordinates a driver factory needs. The secret is injected
 *  here (read from Tier 2 by the main process) and **never** leaves the
 *  worker/main boundary toward a renderer (doc 53 §security). */
export type DriverCredentials = {
	/** OAuth2 access token, app-password, or basic password. */
	secret: string;
	/** Username for basic/app-password auth (usually the address). */
	username?: string;
};
