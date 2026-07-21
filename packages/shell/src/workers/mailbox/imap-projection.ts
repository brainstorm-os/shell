/**
 * Pure IMAP-side projection + cursor state machine for the IMAP/SMTP
 * `MailDriver` (Mailbox-2). No IO and no imapflow/mailparser imports — the
 * driver feeds in what the wire libraries produced, so every mapping here is
 * fixture-testable: special-use → `FolderRole`, IMAP system flags →
 * `MailFlag`, a parsed RFC 822 message → `RawMessage`, and the
 * `uidValidity:lastUid` resume cursor (a UIDVALIDITY change invalidates every
 * cached UID per RFC 3501 §2.3.1.1 — the cursor fails closed to a re-walk).
 */

import type { MailAttachmentPart } from "@brainstorm-os/sdk-types";
import { FolderRole, MailFlag } from "@brainstorm-os/sdk-types";
import type { RawMessage } from "../../main/mailbox/mail-driver";

// RFC 6154 special-use attributes (plus Gmail's \All).
const SPECIAL_USE_ROLES: Readonly<Record<string, FolderRole>> = {
	"\\inbox": FolderRole.Inbox,
	"\\sent": FolderRole.Sent,
	"\\drafts": FolderRole.Drafts,
	"\\junk": FolderRole.Spam,
	"\\trash": FolderRole.Trash,
	"\\archive": FolderRole.Archive,
	"\\all": FolderRole.Archive,
};

/** RFC 6154 special-use attribute → canonical role; undefined lets the
 *  shared `mail-projection` infer from the folder path instead. */
export function folderRoleFromSpecialUse(specialUse: string | undefined): FolderRole | undefined {
	if (!specialUse) return undefined;
	return SPECIAL_USE_ROLES[specialUse.trim().toLowerCase()];
}

const IMAP_FLAG_SEEN = "\\seen";
const IMAP_FLAG_FLAGGED = "\\flagged";
const IMAP_FLAG_ANSWERED = "\\answered";
const IMAP_FLAG_DRAFT = "\\draft";

/** IMAP system flags → `MailFlag[]`. Note the polarity flip: IMAP stores
 *  `\Seen`, the vault stores `unread`. */
export function imapFlagsToMailFlags(flags: Iterable<string>): MailFlag[] {
	const lower = new Set<string>();
	for (const f of flags) lower.add(f.toLowerCase());
	const out: MailFlag[] = [];
	if (!lower.has(IMAP_FLAG_SEEN)) out.push(MailFlag.Unread);
	if (lower.has(IMAP_FLAG_FLAGGED)) out.push(MailFlag.Flagged);
	if (lower.has(IMAP_FLAG_ANSWERED)) out.push(MailFlag.Answered);
	if (lower.has(IMAP_FLAG_DRAFT)) out.push(MailFlag.Draft);
	return out;
}

/** The per-folder incremental resume point: every UID ≤ `lastUid` under this
 *  `uidValidity` has been seen. Serialized into `FetchResult.nextCursor` /
 *  parsed from `FetchSpec.cursor`. */
export type ImapCursor = {
	/** RFC 3501 UIDVALIDITY, kept as a decimal string (imapflow yields a
	 *  bigint; JSON round-trips strings losslessly). */
	uidValidity: string;
	lastUid: number;
};

export function formatImapCursor(cursor: ImapCursor): string {
	return `${cursor.uidValidity}:${cursor.lastUid}`;
}

/** Null on anything malformed — the driver then falls back to the bounded
 *  re-walk, which is always safe (upserts are idempotent on Message-ID). */
export function parseImapCursor(raw: string): ImapCursor | null {
	const match = raw.match(/^(\d+):(\d+)$/);
	if (!match) return null;
	const uidValidity = match[1];
	const lastUid = Number(match[2]);
	if (uidValidity === undefined || !Number.isSafeInteger(lastUid)) return null;
	return { uidValidity, lastUid };
}

/** Newest-first page selection (OQ-MB-4: the backfill walks newest-first and
 *  stops at the cap) — UIDs ascend with arrival order, so descending UID is
 *  descending age. */
export function selectNewestUids(uids: readonly number[], limit: number): number[] {
	return [...uids].sort((a, b) => b - a).slice(0, Math.max(0, limit));
}

/** Structural subset of mailparser's `ParsedMail` — the driver passes the
 *  real thing; fixtures in tests pass `simpleParser` output directly. */
export type ParsedAddressLike = { text: string };
export type ParsedSourceLike = {
	messageId?: string;
	inReplyTo?: string;
	references?: string | string[];
	from?: ParsedAddressLike;
	to?: ParsedAddressLike | ParsedAddressLike[];
	cc?: ParsedAddressLike | ParsedAddressLike[];
	subject?: string;
	date?: Date;
	text?: string;
	html?: string | false;
	attachments?: {
		filename?: string;
		contentType?: string;
		size?: number;
		/** Decoded bytes — only read by the on-demand attachment fetch; the
		 *  sync projection ignores it so a page of mail never retains bodies. */
		content?: Uint8Array;
	}[];
};

function addressHeaderText(
	value: ParsedAddressLike | ParsedAddressLike[] | undefined,
): string | undefined {
	if (!value) return undefined;
	const text = Array.isArray(value)
		? value
				.map((v) => v.text)
				.filter((t) => t.length > 0)
				.join(", ")
		: value.text;
	return text.length > 0 ? text : undefined;
}

function referencesList(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const list = (Array.isArray(value) ? value : value.split(/\s+/)).filter((r) => r.length > 0);
	return list.length > 0 ? list : undefined;
}

export type ParsedMessageMeta = {
	folderPath: string;
	flags: MailFlag[];
	/** Stable synthetic Message-ID for the (rare) message without one —
	 *  derived from `uidValidity`+UID so a re-fetch dedupes. */
	fallbackMessageId: string;
	/** IMAP INTERNALDATE in epoch ms, used when the Date header is missing
	 *  or unparseable. */
	receivedAtFallback: number;
	/** Addressing pair for a later attachment fetch (Mailbox-6). `uidValidity`
	 *  rides along so a mailbox that was recreated server-side invalidates the
	 *  stored part refs instead of silently fetching a different message. */
	uid: number;
	uidValidity: string;
};

/** IMAP part address: the attachment's index within the re-parsed source,
 *  qualified by the uid it belongs to. */
export function imapPartRef(uidValidity: string, uid: number, index: number): string {
	return `${uidValidity}:${uid}:${index}`;
}

export function parseImapPartRef(
	partRef: string,
): { uidValidity: string; uid: number; index: number } | null {
	const parts = partRef.split(":");
	if (parts.length !== 3) return null;
	const [uidValidity, uidText, indexText] = parts as [string, string, string];
	const uid = Number(uidText);
	const index = Number(indexText);
	if (uidValidity.length === 0) return null;
	if (!Number.isSafeInteger(uid) || uid <= 0) return null;
	if (!Number.isSafeInteger(index) || index < 0) return null;
	return { uidValidity, uid, index };
}

/** A parsed RFC 822 source + IMAP fetch metadata → the driver-contract
 *  `RawMessage` (header strings stay raw; the shared `mail-projection`
 *  parses/sanitises downstream). */
export function rawMessageFromParsed(
	parsed: ParsedSourceLike,
	meta: ParsedMessageMeta,
): RawMessage {
	const to = addressHeaderText(parsed.to);
	const cc = addressHeaderText(parsed.cc);
	const references = referencesList(parsed.references);
	const dateMs = parsed.date?.getTime();
	// Index is the position in the parsed list, so the fetch path must re-parse
	// with the same parser to address the same part.
	const attachmentParts: MailAttachmentPart[] = [];
	(parsed.attachments ?? []).forEach((a, index) => {
		if (typeof a.filename !== "string" || a.filename.length === 0) return;
		const part: MailAttachmentPart = {
			partRef: imapPartRef(meta.uidValidity, meta.uid, index),
			filename: a.filename,
		};
		if (a.contentType !== undefined) part.mimeType = a.contentType;
		if (typeof a.size === "number") part.sizeBytes = a.size;
		attachmentParts.push(part);
	});
	const html = typeof parsed.html === "string" && parsed.html.length > 0 ? parsed.html : undefined;
	return {
		messageId: parsed.messageId ?? meta.fallbackMessageId,
		...(parsed.inReplyTo !== undefined ? { inReplyTo: parsed.inReplyTo } : {}),
		...(references !== undefined ? { references } : {}),
		from: parsed.from?.text ?? "",
		...(to !== undefined ? { to } : {}),
		...(cc !== undefined ? { cc } : {}),
		...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
		receivedAt: dateMs !== undefined && Number.isFinite(dateMs) ? dateMs : meta.receivedAtFallback,
		...(parsed.text !== undefined && parsed.text.length > 0 ? { bodyText: parsed.text } : {}),
		...(html !== undefined ? { bodyHtml: html } : {}),
		flags: meta.flags,
		folderPath: meta.folderPath,
		...(attachmentParts.length > 0 ? { attachmentParts } : {}),
	};
}
