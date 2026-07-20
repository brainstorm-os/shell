/**
 * Gmail REST API `MailDriver` (`MailProtocol.GmailApi`) — rides the connector
 * OAuth broker's access token (doc 56), so there is no socket to own: every
 * operation is a stateless HTTPS call to `gmail.googleapis.com`. Runs inside
 * the mailbox `utilityProcess` worker and under Vitest, so it is
 * dependency-free (injected `fetchImpl`, Node `Buffer` only) and imports
 * nothing from Electron.
 *
 * Returns RAW messages (header strings, unsanitised HTML, base64url-decoded
 * bodies); all parsing/sanitising happens in the shared `mail-projection`
 * layer, per the driver contract.
 */

import { Buffer } from "node:buffer";
import type { MailAttachmentPart } from "@brainstorm/sdk-types";
import { FolderRole, MailFlag, MailProtocol } from "@brainstorm/sdk-types";
import type {
	DriverCredentials,
	FetchAttachmentResult,
	FetchAttachmentSpec,
	FetchResult,
	FetchSpec,
	MailDriver,
	OutboundMessage,
	RawFolder,
	RawMessage,
	SubmitResult,
} from "../../main/mailbox/mail-driver";
import { FetchWalk, MAX_ATTACHMENT_BYTES } from "../../main/mailbox/mail-driver";
import {
	DriverErrorKind,
	assertOutboundHeadersSafe,
	driverError,
	sanitizeIdToken,
	submissionMessageId,
} from "./driver-common";

const DRIVER_NAME = "gmail";

export type GmailDriverInput = {
	credentials: DriverCredentials;
	fetchImpl?: typeof fetch;
	baseUrl?: string;
	now?: () => number;
};

const DEFAULT_BASE_URL = "https://gmail.googleapis.com";
const USERS_ME = "/gmail/v1/users/me";
const MAX_PAGE_SIZE = 500;
const ERROR_SNIPPET_MAX = 200;
/** Gmail has no bulk message-body endpoint, so a page costs one GET per
 *  message — bounded parallelism keeps a 500-message page at seconds instead
 *  of serial minutes without tripping per-user rate limits. */
const DETAIL_FETCH_CONCURRENCY = 8;

const GmailLabelType = {
	System: "system",
	User: "user",
} as const;

// Gmail's "labels" mix real folders with per-message state (UNREAD, STARRED)
// and inbox-tab categories — only the former project to RawFolder.
const SYSTEM_LABEL_ROLES: Readonly<Record<string, FolderRole>> = {
	INBOX: FolderRole.Inbox,
	SENT: FolderRole.Sent,
	DRAFT: FolderRole.Drafts,
	TRASH: FolderRole.Trash,
	SPAM: FolderRole.Spam,
};
const NON_FOLDER_SYSTEM_LABELS = new Set(["UNREAD", "STARRED", "IMPORTANT", "CHAT"]);
const CATEGORY_LABEL_PREFIX = "CATEGORY_";

const UNREAD_LABEL_ID = "UNREAD";
const STARRED_LABEL_ID = "STARRED";
const INBOX_LABEL_ID = "INBOX";

const MIME_TEXT_PLAIN = "text/plain";
const MIME_TEXT_HTML = "text/html";

type GmailLabel = {
	id?: string;
	name?: string;
	type?: string;
	messagesUnread?: number;
};
type GmailLabelList = { labels?: GmailLabel[] };
type GmailMessageRef = { id?: string };
type GmailMessageList = { messages?: GmailMessageRef[]; nextPageToken?: string };
type GmailHeader = { name?: string; value?: string };
type GmailPartBody = { data?: string; attachmentId?: string; size?: number };
type GmailPart = {
	mimeType?: string;
	filename?: string;
	headers?: GmailHeader[];
	body?: GmailPartBody;
	parts?: GmailPart[];
};
type GmailMessage = {
	id?: string;
	threadId?: string;
	labelIds?: string[];
	internalDate?: string;
	payload?: GmailPart;
};

function kindForStatus(status: number): DriverErrorKind {
	if (status === 401 || status === 403) return DriverErrorKind.Denied;
	if (status === 429 || status >= 500) return DriverErrorKind.Unavailable;
	return DriverErrorKind.Invalid;
}

function decodeBase64Url(data: string): string {
	return Buffer.from(data, "base64url").toString("utf8");
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const h of headers ?? []) {
		if (h.name?.toLowerCase() === wanted && h.value !== undefined) return h.value;
	}
	return undefined;
}

type BodyAccumulator = { text?: string; html?: string; attachments: MailAttachmentPart[] };

/** Gmail addresses an attachment by (message id, attachment id), so the
 *  `partRef` carries both — the fetch needs no other state. */
function gmailPartRef(messageId: string, attachmentId: string): string {
	return `${messageId}:${attachmentId}`;
}

function parseGmailPartRef(partRef: string): { messageId: string; attachmentId: string } | null {
	const split = partRef.indexOf(":");
	if (split <= 0 || split === partRef.length - 1) return null;
	return {
		messageId: partRef.slice(0, split),
		attachmentId: partRef.slice(split + 1),
	};
}

function walkParts(part: GmailPart | undefined, out: BodyAccumulator, messageId: string): void {
	if (!part) return;
	const isAttachment = (part.filename ?? "").length > 0;
	const attachmentId = part.body?.attachmentId;
	if (isAttachment && part.filename && attachmentId) {
		const meta: MailAttachmentPart = {
			partRef: gmailPartRef(messageId, attachmentId),
			filename: part.filename,
		};
		if (part.mimeType !== undefined) meta.mimeType = part.mimeType;
		if (typeof part.body?.size === "number") meta.sizeBytes = part.body.size;
		out.attachments.push(meta);
	}
	const data = part.body?.data;
	if (!isAttachment && data !== undefined && data.length > 0) {
		const mime = (part.mimeType ?? "").toLowerCase();
		if (mime === MIME_TEXT_PLAIN && out.text === undefined) out.text = decodeBase64Url(data);
		else if (mime === MIME_TEXT_HTML && out.html === undefined) out.html = decodeBase64Url(data);
	}
	for (const child of part.parts ?? []) walkParts(child, out, messageId);
}

function projectMessage(message: GmailMessage, folderPath: string): RawMessage {
	const headers = message.payload?.headers;
	const body: BodyAccumulator = { attachments: [] };
	walkParts(message.payload, body, message.id ?? "");

	const from = headerValue(headers, "From") ?? "";
	const to = headerValue(headers, "To");
	const cc = headerValue(headers, "Cc");
	const subject = headerValue(headers, "Subject");
	const messageId =
		headerValue(headers, "Message-ID") ?? `<gmail-${message.id ?? "unknown"}@mail.gmail.com>`;
	const inReplyTo = headerValue(headers, "In-Reply-To");
	const referencesHeader = headerValue(headers, "References");
	const references = referencesHeader?.split(/\s+/).filter((r) => r.length > 0);

	const labelIds = message.labelIds ?? [];
	const flags: MailFlag[] = [];
	if (labelIds.includes(UNREAD_LABEL_ID)) flags.push(MailFlag.Unread);
	if (labelIds.includes(STARRED_LABEL_ID)) flags.push(MailFlag.Flagged);

	return {
		messageId,
		...(message.threadId !== undefined ? { providerThreadId: message.threadId } : {}),
		...(inReplyTo !== undefined ? { inReplyTo } : {}),
		...(references && references.length > 0 ? { references } : {}),
		from,
		...(to !== undefined ? { to } : {}),
		...(cc !== undefined ? { cc } : {}),
		...(subject !== undefined ? { subject } : {}),
		receivedAt: Number(message.internalDate ?? 0),
		...(body.text !== undefined ? { bodyText: body.text } : {}),
		...(body.html !== undefined ? { bodyHtml: body.html } : {}),
		flags,
		folderPath,
		...(body.attachments.length > 0 ? { attachmentParts: body.attachments } : {}),
	};
}

function isAscii(value: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check is the point
	return /^[\x00-\x7F]*$/.test(value);
}

/** RFC 2047 encoded-word for a non-ASCII header value. */
function encodeHeaderValue(value: string): string {
	if (isAscii(value)) return value;
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Base64 body chunked to 76-char lines per RFC 2045 §6.8. */
function encodeBodyBase64(value: string): string {
	const b64 = Buffer.from(value, "utf8").toString("base64");
	return b64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function bodyPartLines(mimeType: string, content: string): string[] {
	return [
		`Content-Type: ${mimeType}; charset=utf-8`,
		"Content-Transfer-Encoding: base64",
		"",
		encodeBodyBase64(content),
	];
}

function buildMime(message: OutboundMessage, messageId: string, nowMs: number): string {
	const lines: string[] = [
		`Message-ID: ${messageId}`,
		`Date: ${new Date(nowMs).toUTCString()}`,
		`From: ${message.from}`,
		`To: ${message.to.join(", ")}`,
	];
	if (message.cc && message.cc.length > 0) lines.push(`Cc: ${message.cc.join(", ")}`);
	if (message.subject !== undefined) {
		lines.push(`Subject: ${encodeHeaderValue(message.subject)}`);
	}
	if (message.inReplyTo !== undefined) lines.push(`In-Reply-To: ${message.inReplyTo}`);
	if (message.references && message.references.length > 0) {
		lines.push(`References: ${message.references.join(" ")}`);
	}
	lines.push("MIME-Version: 1.0");

	const hasText = message.bodyText !== undefined;
	const hasHtml = message.bodyHtml !== undefined;
	if (hasText && hasHtml) {
		const boundary = `bs-${sanitizeIdToken(message.submissionId)}`;
		lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, "");
		lines.push(`--${boundary}`);
		lines.push(...bodyPartLines(MIME_TEXT_PLAIN, message.bodyText ?? ""));
		lines.push(`--${boundary}`);
		lines.push(...bodyPartLines(MIME_TEXT_HTML, message.bodyHtml ?? ""));
		lines.push(`--${boundary}--`);
	} else if (hasHtml) {
		lines.push(...bodyPartLines(MIME_TEXT_HTML, message.bodyHtml ?? ""));
	} else {
		lines.push(...bodyPartLines(MIME_TEXT_PLAIN, message.bodyText ?? ""));
	}
	return lines.join("\r\n");
}

/** Map with at most `limit` calls in flight, preserving input order. */
async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await fn(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export function makeGmailDriver(input: GmailDriverInput): MailDriver {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
	const now = input.now ?? Date.now;
	const secret = input.credentials.secret;

	/** Label name (folder path) → Gmail label id. */
	let labelIdsByPath: Map<string, string> | undefined;

	async function request(
		method: string,
		path: string,
		init?: { method?: string; body?: string },
	): Promise<unknown> {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			method: init?.method ?? "GET",
			headers: {
				Authorization: `Bearer ${secret}`,
				...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			...(init?.body !== undefined ? { body: init.body } : {}),
		});
		if (!response.ok) {
			const snippet = (await response.text().catch(() => "")).slice(0, ERROR_SNIPPET_MAX);
			throw driverError(
				kindForStatus(response.status),
				`gmail: ${method} ${response.status}${snippet.length > 0 ? ` — ${snippet}` : ""}`,
			);
		}
		return response.json();
	}

	async function loadLabels(method: string): Promise<GmailLabel[]> {
		const list = (await request(method, `${USERS_ME}/labels`)) as GmailLabelList;
		const labels = list.labels ?? [];
		labelIdsByPath = new Map();
		for (const label of labels) {
			if (label.name !== undefined && label.id !== undefined) {
				labelIdsByPath.set(label.name, label.id);
			}
		}
		return labels;
	}

	function folderForLabel(label: GmailLabel): RawFolder | undefined {
		const id = label.id ?? "";
		const name = label.name ?? id;
		if (id.length === 0 || name.length === 0) return undefined;
		if (label.type === GmailLabelType.User) return { path: name, role: FolderRole.Custom };
		if (NON_FOLDER_SYSTEM_LABELS.has(id) || id.startsWith(CATEGORY_LABEL_PREFIX)) {
			return undefined;
		}
		const role = SYSTEM_LABEL_ROLES[id];
		return { path: name, role: role ?? FolderRole.Custom };
	}

	async function resolveLabelId(method: string, folderPath: string): Promise<string> {
		if (!labelIdsByPath?.has(folderPath)) await loadLabels(method);
		const id = labelIdsByPath?.get(folderPath);
		if (id === undefined) {
			throw driverError(DriverErrorKind.Invalid, `gmail: unknown folder "${folderPath}"`);
		}
		return id;
	}

	return {
		protocol: MailProtocol.GmailApi,

		async listFolders(): Promise<RawFolder[]> {
			const labels = await loadLabels("listFolders");
			const folders: RawFolder[] = [];
			for (const label of labels) {
				const folder = folderForLabel(label);
				if (folder) folders.push(folder);
			}
			const inbox = folders.find((f) => f.role === FolderRole.Inbox);
			if (inbox) {
				const detail = (await request(
					"listFolders",
					`${USERS_ME}/labels/${INBOX_LABEL_ID}`,
				)) as GmailLabel;
				if (typeof detail.messagesUnread === "number") {
					inbox.unreadCount = detail.messagesUnread;
				}
			}
			return folders;
		},

		async fetch(spec: FetchSpec): Promise<FetchResult> {
			const labelId = await resolveLabelId("fetch", spec.folderPath);
			const params = new URLSearchParams();
			params.set("labelIds", labelId);
			params.set("maxResults", String(Math.min(spec.limit, MAX_PAGE_SIZE)));
			if (spec.cursor !== undefined) params.set("pageToken", spec.cursor);
			// Backfill (Mailbox-12): Gmail's list already walks newest→older via
			// pageToken, so the older-walk is the same call minus the window bound.
			if (spec.walk !== FetchWalk.Backfill && spec.sinceMs !== undefined) {
				params.set("q", `after:${Math.floor(spec.sinceMs / 1000)}`);
			}
			const list = (await request(
				"fetch",
				`${USERS_ME}/messages?${params.toString()}`,
			)) as GmailMessageList;
			const ids = (list.messages ?? [])
				.map((ref) => ref.id)
				.filter((id): id is string => id !== undefined);
			const messages = await mapLimit(ids, DETAIL_FETCH_CONCURRENCY, async (id) => {
				const full = (await request("fetch", `${USERS_ME}/messages/${id}?format=full`)) as GmailMessage;
				return projectMessage(full, spec.folderPath);
			});
			return {
				messages,
				...(list.nextPageToken !== undefined ? { nextCursor: list.nextPageToken } : {}),
			};
		},

		async fetchAttachment(spec: FetchAttachmentSpec): Promise<FetchAttachmentResult> {
			const parsed = parseGmailPartRef(spec.partRef);
			if (!parsed) {
				throw driverError(DriverErrorKind.Invalid, "gmail: malformed attachment part reference");
			}
			const limit = Math.min(spec.maxBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
			const body = (await request(
				"fetchAttachment",
				`${USERS_ME}/messages/${encodeURIComponent(parsed.messageId)}/attachments/${encodeURIComponent(parsed.attachmentId)}`,
			)) as GmailPartBody;
			if (body.data === undefined) {
				throw driverError(DriverErrorKind.Invalid, "gmail: attachment response carried no data");
			}
			const bytes = Buffer.from(body.data, "base64url");
			// The declared `size` is not trusted — only what actually arrived.
			if (bytes.length > limit) {
				throw driverError(
					DriverErrorKind.Invalid,
					`gmail: attachment exceeds ${limit} bytes (got ${bytes.length})`,
				);
			}
			return { bytes: new Uint8Array(bytes) };
		},

		async submit(message: OutboundMessage): Promise<SubmitResult> {
			assertOutboundHeadersSafe(DRIVER_NAME, message);
			const messageId = submissionMessageId(message.submissionId);
			const receivedAt = now();
			const mime = buildMime(message, messageId, receivedAt);
			const raw = Buffer.from(mime, "utf8").toString("base64url");
			await request("submit", `${USERS_ME}/messages/send`, {
				method: "POST",
				body: JSON.stringify({ raw }),
			});
			return { messageId, receivedAt };
		},

		async close(): Promise<void> {
			labelIdsByPath = undefined;
		},
	};
}
