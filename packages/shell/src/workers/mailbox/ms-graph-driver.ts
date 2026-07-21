/**
 * Microsoft Graph (Microsoft 365 / Outlook) `MailDriver` (`MailProtocol.MsGraph`)
 * — rides the connector OAuth broker's access token (doc 56), so like Gmail
 * and JMAP there is no socket: every operation is a stateless HTTPS call to
 * `graph.microsoft.com`. Runs inside the mailbox `utilityProcess` worker and
 * under Vitest, so it is dependency-free (injected `fetchImpl`, Node `Buffer`
 * only) and imports nothing from Electron.
 *
 * Returns RAW messages (Graph already gives structured addresses + a single
 * body, which are rebuilt/passed through for the shared `mail-projection`
 * layer). Send goes out as raw MIME through Graph's `sendMail` MIME endpoint,
 * built by the shared `mail-mime` builder, so the self-stamped `Message-ID`
 * idempotency is identical to the Gmail driver.
 */

import { Buffer } from "node:buffer";
import type { MailAttachmentPart } from "@brainstorm-os/sdk-types";
import { FolderRole, MailFlag, MailProtocol } from "@brainstorm-os/sdk-types";
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
	submissionMessageId,
} from "./driver-common";
import { buildMimeMessage } from "./mail-mime";

const DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";
const ME = "/me";
const ERROR_SNIPPET_MAX = 200;
/** Graph caps `$top` at 1000 for messages; folders far fewer. */
const MAX_PAGE_SIZE = 999;

/** `wellKnownName` → canonical role; anything else (a user folder, or a null
 *  well-known name) projects as {@link FolderRole.Custom}. */
const WELL_KNOWN_ROLES: Readonly<Record<string, FolderRole>> = {
	inbox: FolderRole.Inbox,
	sentitems: FolderRole.Sent,
	drafts: FolderRole.Drafts,
	deleteditems: FolderRole.Trash,
	junkemail: FolderRole.Spam,
	archive: FolderRole.Archive,
};

/** partRef = `<messageId>::<attachmentId>` — Graph addresses an attachment by
 *  both, and neither id contains `::`. */
const PART_REF_SEP = "::";

const MESSAGE_SELECT = [
	"id",
	"internetMessageId",
	"subject",
	"from",
	"toRecipients",
	"ccRecipients",
	"receivedDateTime",
	"body",
	"isRead",
	"flag",
	"conversationId",
	"internetMessageHeaders",
	"hasAttachments",
].join(",");

export type MsGraphDriverInput = {
	credentials: DriverCredentials;
	fetchImpl?: typeof fetch;
	baseUrl?: string;
	now?: () => number;
};

// ─────────────────────────── Graph wire shapes ───────────────────────────

type GraphEmailAddress = { name?: string; address?: string };
type GraphRecipient = { emailAddress?: GraphEmailAddress };
type GraphHeader = { name?: string; value?: string };
type GraphBody = { contentType?: string; content?: string };
type GraphAttachment = {
	id?: string;
	name?: string;
	contentType?: string;
	size?: number;
	isInline?: boolean;
};
type GraphMessage = {
	id?: string;
	internetMessageId?: string;
	subject?: string;
	from?: GraphRecipient;
	toRecipients?: GraphRecipient[];
	ccRecipients?: GraphRecipient[];
	receivedDateTime?: string;
	body?: GraphBody;
	isRead?: boolean;
	flag?: { flagStatus?: string };
	conversationId?: string;
	internetMessageHeaders?: GraphHeader[];
	attachments?: GraphAttachment[];
};
type GraphMessageList = { value?: GraphMessage[]; "@odata.nextLink"?: string };
type GraphFolder = {
	id?: string;
	displayName?: string;
	wellKnownName?: string | null;
	unreadItemCount?: number;
	parentFolderId?: string | null;
};
type GraphFolderList = { value?: GraphFolder[]; "@odata.nextLink"?: string };

// ─────────────────────────── helpers ───────────────────────────

function kindForStatus(status: number): DriverErrorKind {
	if (status === 401 || status === 403) return DriverErrorKind.Denied;
	if (status === 429 || status >= 500) return DriverErrorKind.Unavailable;
	return DriverErrorKind.Invalid;
}

function formatRecipient(addr: GraphEmailAddress | undefined): string | undefined {
	const email = (addr?.address ?? "").trim();
	if (email.length === 0) return undefined;
	const name = (addr?.name ?? "").trim();
	if (name.length === 0 || name === email) return email;
	const safe = /[",<>@]/.test(name) ? `"${name.replace(/"/g, "")}"` : name;
	return `${safe} <${email}>`;
}

function formatRecipients(list: GraphRecipient[] | undefined): string | undefined {
	const parts: string[] = [];
	for (const r of list ?? []) {
		const one = formatRecipient(r.emailAddress);
		if (one) parts.push(one);
	}
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function headerValue(headers: GraphHeader[] | undefined, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const h of headers ?? []) {
		if (h.name?.toLowerCase() === wanted && h.value !== undefined) return h.value;
	}
	return undefined;
}

function folderPath(folder: GraphFolder, byId: Map<string, GraphFolder>): string {
	const segments: string[] = [];
	let current: GraphFolder | undefined = folder;
	const seen = new Set<string>();
	while (current?.id && !seen.has(current.id)) {
		seen.add(current.id);
		segments.unshift(current.displayName ?? current.id);
		const parentId: string | null | undefined = current.parentFolderId;
		current = parentId ? byId.get(parentId) : undefined;
	}
	return segments.join("/");
}

function graphPartRef(messageId: string, attachmentId: string): string {
	return `${messageId}${PART_REF_SEP}${attachmentId}`;
}

function parseGraphPartRef(partRef: string): { messageId: string; attachmentId: string } | null {
	const split = partRef.indexOf(PART_REF_SEP);
	if (split <= 0 || split >= partRef.length - PART_REF_SEP.length) return null;
	return {
		messageId: partRef.slice(0, split),
		attachmentId: partRef.slice(split + PART_REF_SEP.length),
	};
}

function projectMessage(message: GraphMessage, folderPath: string): RawMessage {
	const graphId = message.id ?? "";
	const messageId = message.internetMessageId ?? `<graph-${graphId}@outlook.local>`;
	const from = formatRecipient(message.from?.emailAddress) ?? "";
	const to = formatRecipients(message.toRecipients);
	const cc = formatRecipients(message.ccRecipients);

	const bodyKind = (message.body?.contentType ?? "").toLowerCase();
	const content = message.body?.content;
	const bodyHtml = bodyKind === "html" && content ? content : undefined;
	const bodyText = bodyKind === "text" && content ? content : undefined;

	const inReplyTo = headerValue(message.internetMessageHeaders, "In-Reply-To");
	const referencesHeader = headerValue(message.internetMessageHeaders, "References");
	const references = referencesHeader?.split(/\s+/).filter((r) => r.length > 0);

	const flags: MailFlag[] = [];
	if (message.isRead === false) flags.push(MailFlag.Unread);
	if (message.flag?.flagStatus === "flagged") flags.push(MailFlag.Flagged);

	const attachmentParts: MailAttachmentPart[] = [];
	for (const att of message.attachments ?? []) {
		if (att.isInline || !att.id || !att.name) continue;
		const meta: MailAttachmentPart = { partRef: graphPartRef(graphId, att.id), filename: att.name };
		if (att.contentType) meta.mimeType = att.contentType;
		if (typeof att.size === "number") meta.sizeBytes = att.size;
		attachmentParts.push(meta);
	}

	return {
		messageId,
		...(message.conversationId !== undefined ? { providerThreadId: message.conversationId } : {}),
		...(inReplyTo !== undefined ? { inReplyTo } : {}),
		...(references && references.length > 0 ? { references } : {}),
		from,
		...(to !== undefined ? { to } : {}),
		...(cc !== undefined ? { cc } : {}),
		...(message.subject ? { subject: message.subject } : {}),
		receivedAt: message.receivedDateTime ? Date.parse(message.receivedDateTime) : 0,
		...(bodyText !== undefined ? { bodyText } : {}),
		...(bodyHtml !== undefined ? { bodyHtml } : {}),
		flags,
		folderPath,
		...(attachmentParts.length > 0 ? { attachmentParts } : {}),
	};
}

export function makeMsGraphDriver(input: MsGraphDriverInput): MailDriver {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
	const now = input.now ?? Date.now;
	const secret = input.credentials.secret;

	/** Full hierarchical path → folder id. */
	let folderIdByPath: Map<string, string> | undefined;

	async function request(
		op: string,
		url: string,
		init?: { method?: string; body?: string; contentType?: string; raw?: boolean },
	): Promise<unknown> {
		const absolute = url.startsWith("http") ? url : `${baseUrl}${url}`;
		const response = await fetchImpl(absolute, {
			method: init?.method ?? "GET",
			headers: {
				Authorization: `Bearer ${secret}`,
				...(init?.body !== undefined ? { "Content-Type": init.contentType ?? "application/json" } : {}),
			},
			...(init?.body !== undefined ? { body: init.body } : {}),
		});
		if (!response.ok) {
			const snippet = (await response.text().catch(() => "")).slice(0, ERROR_SNIPPET_MAX);
			throw driverError(
				kindForStatus(response.status),
				`ms-graph: ${op} ${response.status}${snippet.length > 0 ? ` — ${snippet}` : ""}`,
			);
		}
		// sendMail returns 202 with an empty body; nothing to parse.
		if (init?.raw || response.status === 202 || response.status === 204) return undefined;
		return response.json();
	}

	async function loadFolders(): Promise<GraphFolder[]> {
		const folders: GraphFolder[] = [];
		let url: string | undefined =
			`${ME}/mailFolders?$top=100&$select=id,displayName,wellKnownName,unreadItemCount,parentFolderId`;
		while (url) {
			const page = (await request("listFolders", url)) as GraphFolderList;
			for (const f of page.value ?? []) folders.push(f);
			url = page["@odata.nextLink"];
		}
		const byId = new Map<string, GraphFolder>();
		for (const f of folders) if (f.id) byId.set(f.id, f);
		folderIdByPath = new Map();
		for (const f of folders) {
			if (!f.id) continue;
			folderIdByPath.set(folderPath(f, byId), f.id);
		}
		return folders;
	}

	async function resolveFolderId(path: string): Promise<string> {
		if (!folderIdByPath?.has(path)) await loadFolders();
		const id = folderIdByPath?.get(path);
		if (id === undefined) {
			throw driverError(DriverErrorKind.Invalid, `ms-graph: unknown folder "${path}"`);
		}
		return id;
	}

	return {
		protocol: MailProtocol.MsGraph,

		async listFolders(): Promise<RawFolder[]> {
			const folders = await loadFolders();
			const byId = new Map<string, GraphFolder>();
			for (const f of folders) if (f.id) byId.set(f.id, f);
			const out: RawFolder[] = [];
			for (const f of folders) {
				if (!f.id) continue;
				const path = folderPath(f, byId);
				if (path.length === 0) continue;
				const wkn = (f.wellKnownName ?? "").toLowerCase();
				const folder: RawFolder = { path, role: WELL_KNOWN_ROLES[wkn] ?? FolderRole.Custom };
				if (typeof f.unreadItemCount === "number") folder.unreadCount = f.unreadItemCount;
				out.push(folder);
			}
			return out;
		},

		async fetch(spec: FetchSpec): Promise<FetchResult> {
			let url: string;
			if (spec.cursor !== undefined) {
				// The cursor is an opaque Graph `@odata.nextLink` — it already
				// carries the folder, order, filter, and skip, so follow it verbatim.
				url = spec.cursor;
			} else {
				const folderId = await resolveFolderId(spec.folderPath);
				const params = new URLSearchParams();
				params.set("$top", String(Math.min(spec.limit, MAX_PAGE_SIZE)));
				params.set("$orderby", "receivedDateTime desc");
				params.set("$select", MESSAGE_SELECT);
				params.set("$expand", "attachments($select=id,name,contentType,size,isInline)");
				// Backfill walks progressively older with no window bound; Forward
				// bounds the newest-first walk by `sinceMs`.
				if (spec.walk !== FetchWalk.Backfill && spec.sinceMs !== undefined) {
					params.set("$filter", `receivedDateTime ge ${new Date(spec.sinceMs).toISOString()}`);
				}
				url = `${ME}/mailFolders/${encodeURIComponent(folderId)}/messages?${params.toString()}`;
			}
			const page = (await request("fetch", url)) as GraphMessageList;
			const messages = (page.value ?? []).map((m) => projectMessage(m, spec.folderPath));
			const nextCursor = page["@odata.nextLink"];
			return { messages, ...(nextCursor !== undefined ? { nextCursor } : {}) };
		},

		async fetchAttachment(spec: FetchAttachmentSpec): Promise<FetchAttachmentResult> {
			const parsed = parseGraphPartRef(spec.partRef);
			if (!parsed) {
				throw driverError(DriverErrorKind.Invalid, "ms-graph: malformed attachment part reference");
			}
			const limit = Math.min(spec.maxBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
			const url = `${baseUrl}${ME}/messages/${encodeURIComponent(parsed.messageId)}/attachments/${encodeURIComponent(parsed.attachmentId)}/$value`;
			const response = await fetchImpl(url, {
				method: "GET",
				headers: { Authorization: `Bearer ${secret}` },
			});
			if (!response.ok) {
				const snippet = (await response.text().catch(() => "")).slice(0, ERROR_SNIPPET_MAX);
				throw driverError(
					kindForStatus(response.status),
					`ms-graph: fetchAttachment ${response.status}${snippet.length > 0 ? ` — ${snippet}` : ""}`,
				);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			// The declared size is not trusted — only what actually arrived.
			if (bytes.length > limit) {
				throw driverError(
					DriverErrorKind.Invalid,
					`ms-graph: attachment exceeds ${limit} bytes (got ${bytes.length})`,
				);
			}
			return { bytes };
		},

		async submit(message: OutboundMessage): Promise<SubmitResult> {
			assertOutboundHeadersSafe("ms-graph", message);
			const messageId = submissionMessageId(message.submissionId);
			const receivedAt = now();
			// Graph's sendMail accepts a base64 MIME body (Content-Type text/plain),
			// so the self-stamped Message-ID rides through exactly as it does for
			// Gmail — Graph files the Sent copy itself.
			const mime = buildMimeMessage(message, messageId, receivedAt);
			const raw = Buffer.from(mime, "utf8").toString("base64");
			await request("submit", `${ME}/sendMail`, {
				method: "POST",
				body: raw,
				contentType: "text/plain",
				raw: true,
			});
			return { messageId, receivedAt };
		},

		async close(): Promise<void> {
			folderIdByPath = undefined;
		},
	};
}
