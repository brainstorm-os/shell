/**
 * JMAP `MailDriver` (`MailProtocol.Jmap`, RFC 8620 core + RFC 8621 mail) —
 * the second stateless-HTTPS driver alongside Gmail (doc 53 §shell-vs-app
 * split). There is no long-lived socket: a JMAP account is a session URL plus
 * a bearer secret (an app-password or OAuth token), and every operation is a
 * `POST` of a batched `methodCalls` request to the session's `apiUrl`.
 *
 * Runs inside the mailbox `utilityProcess` worker and under Vitest, so it is
 * dependency-free (injected `fetchImpl`, Node `Buffer` only) and imports
 * nothing from Electron.
 *
 * Returns RAW messages (header strings rebuilt from JMAP's structured address
 * objects, unsanitised HTML from `bodyValues`); all parsing/sanitising happens
 * in the shared `mail-projection` layer, per the driver contract.
 */

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

const DRIVER_NAME = "jmap";

const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";

const ERROR_SNIPPET_MAX = 200;
/** RFC 8621 mailboxes whose `role` maps onto a canonical {@link FolderRole};
 *  anything else (or a null role) projects as {@link FolderRole.Custom}. */
const ROLE_MAP: Readonly<Record<string, FolderRole>> = {
	inbox: FolderRole.Inbox,
	sent: FolderRole.Sent,
	drafts: FolderRole.Drafts,
	trash: FolderRole.Trash,
	junk: FolderRole.Spam,
	archive: FolderRole.Archive,
};

const KEYWORD_SEEN = "$seen";
const KEYWORD_FLAGGED = "$flagged";
const KEYWORD_ANSWERED = "$answered";
const KEYWORD_DRAFT = "$draft";

export type JmapDriverInput = {
	credentials: DriverCredentials;
	/** The JMAP session resource URL (RFC 8620 §2) — the factory derives it
	 *  from the account's server host; tests inject it directly. */
	sessionUrl: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
};

// ─────────────────────────── JMAP wire shapes ───────────────────────────

type JmapAccountId = string;

type JmapSession = {
	apiUrl?: string;
	downloadUrl?: string;
	accounts?: Record<string, unknown>;
	primaryAccounts?: Record<string, JmapAccountId>;
};

/** A single `[name, args, callId]` invocation (RFC 8620 §3.2). */
type MethodCall = [string, Record<string, unknown>, string];
type MethodResponse = [string, Record<string, unknown>, string];
type JmapApiResponse = { methodResponses?: MethodResponse[] };

/** A back-reference (`ResultReference`, RFC 8620 §3.7) — feeds one method's
 *  output straight into the next in the same request. */
type ResultReference = { resultOf: string; name: string; path: string };

type JmapMailbox = {
	id?: string;
	name?: string;
	parentId?: string | null;
	role?: string | null;
	unreadEmails?: number;
};

type JmapEmailAddress = { name?: string | null; email?: string };
type JmapBodyPart = { partId?: string; blobId?: string; type?: string };
type JmapBodyValue = { value?: string; isTruncated?: boolean };
type JmapAttachment = {
	blobId?: string;
	name?: string | null;
	type?: string | null;
	size?: number;
};
type JmapEmail = {
	id?: string;
	blobId?: string;
	threadId?: string;
	messageId?: string[] | null;
	inReplyTo?: string[] | null;
	references?: string[] | null;
	from?: JmapEmailAddress[] | null;
	to?: JmapEmailAddress[] | null;
	cc?: JmapEmailAddress[] | null;
	subject?: string | null;
	receivedAt?: string | null;
	keywords?: Record<string, boolean> | null;
	textBody?: JmapBodyPart[];
	htmlBody?: JmapBodyPart[];
	bodyValues?: Record<string, JmapBodyValue>;
	attachments?: JmapAttachment[];
};

// ─────────────────────────── helpers ───────────────────────────

function kindForStatus(status: number): DriverErrorKind {
	if (status === 401 || status === 403) return DriverErrorKind.Denied;
	if (status === 429 || status >= 500) return DriverErrorKind.Unavailable;
	return DriverErrorKind.Invalid;
}

/** JMAP carries a `Message-ID` as a bare token array (no angle brackets);
 *  the projection expects RFC 5322 `<…>` form, so wrap it back. */
function angle(token: string): string {
	const t = token.trim();
	if (t.length === 0) return t;
	return t.startsWith("<") ? t : `<${t}>`;
}

/** Render JMAP's structured `{name,email}[]` back to a raw header string
 *  (`Dana Lee <dana@x.com>, bob@y.com`) so the shared projection re-parses it
 *  on the one audited address path (OQ-MB-6). A name with header-special
 *  characters is quoted; a blank name yields a bare address. */
function formatAddresses(list: JmapEmailAddress[] | null | undefined): string | undefined {
	if (!list || list.length === 0) return undefined;
	const parts: string[] = [];
	for (const addr of list) {
		const email = (addr.email ?? "").trim();
		if (email.length === 0) continue;
		const name = (addr.name ?? "").trim();
		if (name.length === 0) {
			parts.push(email);
		} else {
			const safe = /[",<>@]/.test(name) ? `"${name.replace(/"/g, "")}"` : name;
			parts.push(`${safe} <${email}>`);
		}
	}
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function firstBodyValue(
	parts: JmapBodyPart[] | undefined,
	values: Record<string, JmapBodyValue> | undefined,
): string | undefined {
	for (const part of parts ?? []) {
		const id = part.partId;
		if (id === undefined) continue;
		const value = values?.[id]?.value;
		if (value !== undefined && value.length > 0) return value;
	}
	return undefined;
}

/** Full hierarchical path for a mailbox (`Parent/Child`) so nested mailboxes
 *  are addressable and unambiguous. `seen` guards a cyclic `parentId`. */
function mailboxPath(mb: JmapMailbox, byId: Map<string, JmapMailbox>): string {
	const segments: string[] = [];
	let current: JmapMailbox | undefined = mb;
	const seen = new Set<string>();
	while (current?.id && !seen.has(current.id)) {
		seen.add(current.id);
		segments.unshift(current.name ?? current.id);
		const parentId: string | null | undefined = current.parentId;
		current = parentId ? byId.get(parentId) : undefined;
	}
	return segments.join("/");
}

function flagsFromKeywords(keywords: Record<string, boolean> | null | undefined): MailFlag[] {
	const flags: MailFlag[] = [];
	// `$seen` present ⇒ read; its ABSENCE is the unread signal (RFC 8621 §4.1.1).
	if (!keywords?.[KEYWORD_SEEN]) flags.push(MailFlag.Unread);
	if (keywords?.[KEYWORD_FLAGGED]) flags.push(MailFlag.Flagged);
	if (keywords?.[KEYWORD_ANSWERED]) flags.push(MailFlag.Answered);
	if (keywords?.[KEYWORD_DRAFT]) flags.push(MailFlag.Draft);
	return flags;
}

function projectEmail(email: JmapEmail, folderPath: string): RawMessage {
	const messageId =
		email.messageId && email.messageId.length > 0
			? angle(email.messageId[0] as string)
			: `<jmap-${email.id ?? "unknown"}@jmap.local>`;
	const inReplyTo =
		email.inReplyTo && email.inReplyTo.length > 0 ? angle(email.inReplyTo[0] as string) : undefined;
	const references =
		email.references && email.references.length > 0
			? email.references.map(angle).filter((r) => r.length > 0)
			: undefined;

	const from = formatAddresses(email.from) ?? "";
	const to = formatAddresses(email.to);
	const cc = formatAddresses(email.cc);
	const bodyText = firstBodyValue(email.textBody, email.bodyValues);
	const bodyHtml = firstBodyValue(email.htmlBody, email.bodyValues);

	const attachmentParts: MailAttachmentPart[] = [];
	for (const att of email.attachments ?? []) {
		if (!att.blobId || !att.name) continue;
		const meta: MailAttachmentPart = { partRef: att.blobId, filename: att.name };
		if (att.type) meta.mimeType = att.type;
		if (typeof att.size === "number") meta.sizeBytes = att.size;
		attachmentParts.push(meta);
	}

	return {
		messageId,
		...(email.threadId !== undefined ? { providerThreadId: email.threadId } : {}),
		...(inReplyTo !== undefined ? { inReplyTo } : {}),
		...(references && references.length > 0 ? { references } : {}),
		from,
		...(to !== undefined ? { to } : {}),
		...(cc !== undefined ? { cc } : {}),
		...(email.subject ? { subject: email.subject } : {}),
		receivedAt: email.receivedAt ? Date.parse(email.receivedAt) : 0,
		...(bodyText !== undefined ? { bodyText } : {}),
		...(bodyHtml !== undefined ? { bodyHtml } : {}),
		flags: flagsFromKeywords(email.keywords),
		folderPath,
		...(attachmentParts.length > 0 ? { attachmentParts } : {}),
	};
}

const EMAIL_PROPERTIES = [
	"id",
	"blobId",
	"threadId",
	"messageId",
	"inReplyTo",
	"references",
	"from",
	"to",
	"cc",
	"subject",
	"receivedAt",
	"keywords",
	"textBody",
	"htmlBody",
	"bodyValues",
	"attachments",
];

export function makeJmapDriver(input: JmapDriverInput): MailDriver {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	const now = input.now ?? Date.now;
	const secret = input.credentials.secret;

	let session: { apiUrl: string; downloadUrl: string; accountId: string } | undefined;
	/** Full hierarchical path (`Parent/Child`) → mailbox id, and its role. */
	let mailboxIdByPath: Map<string, string> | undefined;
	let mailboxRoleById: Map<string, string> | undefined;

	function authHeaders(json: boolean): Record<string, string> {
		return {
			Authorization: `Bearer ${secret}`,
			...(json ? { "Content-Type": "application/json" } : {}),
		};
	}

	async function loadSession(): Promise<{
		apiUrl: string;
		downloadUrl: string;
		accountId: string;
	}> {
		if (session) return session;
		const response = await fetchImpl(input.sessionUrl, {
			method: "GET",
			headers: authHeaders(false),
		});
		if (!response.ok) {
			const snippet = (await response.text().catch(() => "")).slice(0, ERROR_SNIPPET_MAX);
			throw driverError(
				kindForStatus(response.status),
				`jmap: session ${response.status}${snippet.length > 0 ? ` — ${snippet}` : ""}`,
			);
		}
		const body = (await response.json()) as JmapSession;
		const accountId = body.primaryAccounts?.[MAIL_CAPABILITY];
		if (!body.apiUrl || !accountId) {
			throw driverError(
				DriverErrorKind.Denied,
				"jmap: session has no apiUrl or no primary mail account (server may not support urn:ietf:params:jmap:mail)",
			);
		}
		// apiUrl may be relative to the session URL (RFC 8620 §2). downloadUrl is
		// a URI *template* (RFC 6570 `{accountId}`/`{blobId}`/…) — running it
		// through `new URL()` would percent-encode the braces, so it is kept raw
		// and resolved only after the placeholders are filled (see fetchAttachment).
		session = {
			apiUrl: new URL(body.apiUrl, input.sessionUrl).toString(),
			downloadUrl: body.downloadUrl ?? "",
			accountId,
		};
		return session;
	}

	/** POST one batched request and return its `methodResponses`, failing
	 *  closed on transport errors and on a JMAP method-level `error` response. */
	async function apiRequest(using: string[], methodCalls: MethodCall[]): Promise<MethodResponse[]> {
		const s = await loadSession();
		const response = await fetchImpl(s.apiUrl, {
			method: "POST",
			headers: authHeaders(true),
			body: JSON.stringify({ using, methodCalls }),
		});
		if (!response.ok) {
			const snippet = (await response.text().catch(() => "")).slice(0, ERROR_SNIPPET_MAX);
			throw driverError(
				kindForStatus(response.status),
				`jmap: api ${response.status}${snippet.length > 0 ? ` — ${snippet}` : ""}`,
			);
		}
		const body = (await response.json()) as JmapApiResponse;
		const responses = body.methodResponses ?? [];
		for (const [name, args] of responses) {
			if (name === "error") {
				const type = (args as { type?: string }).type ?? "unknown";
				throw driverError(DriverErrorKind.Invalid, `jmap: method error "${type}"`);
			}
		}
		return responses;
	}

	function responseFor(responses: MethodResponse[], callId: string): Record<string, unknown> {
		const found = responses.find((r) => r[2] === callId);
		if (!found) throw driverError(DriverErrorKind.Invalid, `jmap: no response for call "${callId}"`);
		return found[1];
	}

	async function loadMailboxes(): Promise<JmapMailbox[]> {
		const s = await loadSession();
		const responses = await apiRequest(
			[CORE_CAPABILITY, MAIL_CAPABILITY],
			[
				[
					"Mailbox/get",
					{
						accountId: s.accountId,
						ids: null,
						properties: ["id", "name", "parentId", "role", "unreadEmails"],
					},
					"m",
				],
			],
		);
		const list = (responseFor(responses, "m").list ?? []) as JmapMailbox[];
		const byId = new Map<string, JmapMailbox>();
		for (const mb of list) if (mb.id) byId.set(mb.id, mb);
		// The full hierarchical path keeps nested mailboxes addressable and
		// unambiguous (two "Archive" folders under different parents differ).
		mailboxIdByPath = new Map();
		mailboxRoleById = new Map();
		for (const mb of list) {
			if (!mb.id) continue;
			mailboxIdByPath.set(mailboxPath(mb, byId), mb.id);
			if (mb.role) mailboxRoleById.set(mb.id, mb.role);
		}
		return list;
	}

	async function resolveMailboxId(folderPath: string): Promise<string> {
		if (!mailboxIdByPath?.has(folderPath)) await loadMailboxes();
		const id = mailboxIdByPath?.get(folderPath);
		if (id === undefined) {
			throw driverError(DriverErrorKind.Invalid, `jmap: unknown folder "${folderPath}"`);
		}
		return id;
	}

	async function mailboxIdForRole(role: FolderRole): Promise<string | undefined> {
		if (!mailboxRoleById) await loadMailboxes();
		const wanted = Object.entries(ROLE_MAP).find(([, r]) => r === role)?.[0];
		if (!wanted) return undefined;
		for (const [id, r] of mailboxRoleById ?? []) if (r === wanted) return id;
		return undefined;
	}

	return {
		protocol: MailProtocol.Jmap,

		async listFolders(): Promise<RawFolder[]> {
			const list = await loadMailboxes();
			const byId = new Map<string, JmapMailbox>();
			for (const mb of list) if (mb.id) byId.set(mb.id, mb);
			const folders: RawFolder[] = [];
			for (const mb of list) {
				if (!mb.id) continue;
				const path = mailboxPath(mb, byId);
				if (path.length === 0) continue;
				const role = mb.role ? (ROLE_MAP[mb.role] ?? FolderRole.Custom) : FolderRole.Custom;
				const folder: RawFolder = { path, role };
				if (typeof mb.unreadEmails === "number") folder.unreadCount = mb.unreadEmails;
				folders.push(folder);
			}
			return folders;
		},

		async fetch(spec: FetchSpec): Promise<FetchResult> {
			const s = await loadSession();
			const mailboxId = await resolveMailboxId(spec.folderPath);
			const position = spec.cursor !== undefined ? Number.parseInt(spec.cursor, 10) || 0 : 0;
			const filter: Record<string, unknown> = { inMailbox: mailboxId };
			// Backfill (Mailbox-12) walks progressively older with no window bound;
			// Forward bounds the newest-first walk by `sinceMs`.
			if (spec.walk !== FetchWalk.Backfill && spec.sinceMs !== undefined) {
				filter.after = new Date(spec.sinceMs).toISOString();
			}
			const responses = await apiRequest(
				[CORE_CAPABILITY, MAIL_CAPABILITY],
				[
					[
						"Email/query",
						{
							accountId: s.accountId,
							filter,
							sort: [{ property: "receivedAt", isAscending: false }],
							position,
							limit: spec.limit,
							calculateTotal: false,
						},
						"q",
					],
					[
						"Email/get",
						{
							accountId: s.accountId,
							"#ids": {
								resultOf: "q",
								name: "Email/query",
								path: "/ids",
							} as ResultReference,
							properties: EMAIL_PROPERTIES,
							fetchTextBodyValues: true,
							fetchHTMLBodyValues: true,
						},
						"g",
					],
				],
			);
			const queryResult = responseFor(responses, "q");
			const ids = (queryResult.ids ?? []) as string[];
			const emails = (responseFor(responses, "g").list ?? []) as JmapEmail[];
			// Email/get does not guarantee query order; re-order to the query's.
			const byId = new Map<string, JmapEmail>();
			for (const e of emails) if (e.id) byId.set(e.id, e);
			const messages: RawMessage[] = [];
			for (const id of ids) {
				const email = byId.get(id);
				if (email) messages.push(projectEmail(email, spec.folderPath));
			}
			// A full page means there may be more at the next position.
			const nextPosition = position + ids.length;
			return {
				messages,
				...(ids.length >= spec.limit ? { nextCursor: String(nextPosition) } : {}),
			};
		},

		async fetchAttachment(spec: FetchAttachmentSpec): Promise<FetchAttachmentResult> {
			const s = await loadSession();
			if (s.downloadUrl.length === 0) {
				throw driverError(DriverErrorKind.Unavailable, "jmap: session exposes no downloadUrl");
			}
			const limit = Math.min(spec.maxBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
			// The `partRef` IS the JMAP blobId — globally addressable, so no
			// folder select is needed. type/name are cosmetic in the URL template.
			const filled = s.downloadUrl
				.replace("{accountId}", encodeURIComponent(s.accountId))
				.replace("{blobId}", encodeURIComponent(spec.partRef))
				.replace("{type}", encodeURIComponent("application/octet-stream"))
				.replace("{name}", "attachment");
			// Placeholders are now filled (no braces left), so resolving any
			// relative template against the session URL is safe.
			const url = new URL(filled, input.sessionUrl).toString();
			const response = await fetchImpl(url, { method: "GET", headers: authHeaders(false) });
			if (!response.ok) {
				const snippet = (await response.text().catch(() => "")).slice(0, ERROR_SNIPPET_MAX);
				throw driverError(
					kindForStatus(response.status),
					`jmap: download ${response.status}${snippet.length > 0 ? ` — ${snippet}` : ""}`,
				);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			// The declared size is not trusted — only what actually arrived.
			if (bytes.length > limit) {
				throw driverError(
					DriverErrorKind.Invalid,
					`jmap: attachment exceeds ${limit} bytes (got ${bytes.length})`,
				);
			}
			return { bytes };
		},

		async submit(message: OutboundMessage): Promise<SubmitResult> {
			assertOutboundHeadersSafe(DRIVER_NAME, message);
			const s = await loadSession();
			const messageId = submissionMessageId(message.submissionId);
			const receivedAt = now();

			const draftMailboxId = await mailboxIdForRole(FolderRole.Drafts);
			if (!draftMailboxId) {
				throw driverError(DriverErrorKind.Unavailable, "jmap: account has no Drafts mailbox");
			}
			const sentMailboxId = await mailboxIdForRole(FolderRole.Sent);

			const toAddresses = message.to.map((email) => ({ email }));
			const ccAddresses = (message.cc ?? []).map((email) => ({ email }));
			const bodyValues: Record<string, { value: string }> = {};
			const textBody: { partId: string; type: string }[] = [];
			const htmlBody: { partId: string; type: string }[] = [];
			if (message.bodyText !== undefined) {
				bodyValues.text = { value: message.bodyText };
				textBody.push({ partId: "text", type: "text/plain" });
			}
			if (message.bodyHtml !== undefined) {
				bodyValues.html = { value: message.bodyHtml };
				htmlBody.push({ partId: "html", type: "text/html" });
			}
			if (textBody.length === 0 && htmlBody.length === 0) {
				bodyValues.text = { value: "" };
				textBody.push({ partId: "text", type: "text/plain" });
			}

			const draft: Record<string, unknown> = {
				mailboxIds: { [draftMailboxId]: true },
				keywords: { [KEYWORD_DRAFT]: true, [KEYWORD_SEEN]: true },
				from: [{ email: message.from }],
				to: toAddresses,
				...(ccAddresses.length > 0 ? { cc: ccAddresses } : {}),
				...(message.subject !== undefined ? { subject: message.subject } : {}),
				messageId: [messageId.replace(/^<(.*)>$/, "$1")],
				...(message.inReplyTo !== undefined
					? { inReplyTo: [message.inReplyTo.replace(/^<(.*)>$/, "$1")] }
					: {}),
				...(message.references && message.references.length > 0
					? { references: message.references.map((r) => r.replace(/^<(.*)>$/, "$1")) }
					: {}),
				bodyValues,
				...(textBody.length > 0 ? { textBody } : {}),
				...(htmlBody.length > 0 ? { htmlBody } : {}),
			};

			// On success, move the sent copy out of Drafts (mirrors IMAP/Gmail's
			// Sent-folder projection): clear $draft + drop the Drafts mailbox and
			// (when the account has one) file it under Sent.
			const onSuccessUpdate: Record<string, unknown> = {
				[`keywords/${KEYWORD_DRAFT}`]: null,
				[`mailboxIds/${draftMailboxId}`]: null,
			};
			if (sentMailboxId) onSuccessUpdate[`mailboxIds/${sentMailboxId}`] = true;

			const responses = await apiRequest(
				[CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY],
				[
					["Email/set", { accountId: s.accountId, create: { draft } }, "e"],
					[
						"EmailSubmission/set",
						{
							accountId: s.accountId,
							create: {
								sub: {
									emailId: "#draft",
									envelope: {
										mailFrom: { email: message.from },
										rcptTo: [...message.to, ...(message.cc ?? [])].map((email) => ({ email })),
									},
								},
							},
							onSuccessUpdateEmail: { "#sub": onSuccessUpdate },
						},
						"s",
					],
				],
			);

			const setResult = responseFor(responses, "e");
			const notCreated = (setResult.notCreated ?? {}) as Record<string, { type?: string }>;
			if (notCreated.draft) {
				throw driverError(
					DriverErrorKind.Invalid,
					`jmap: draft rejected — ${notCreated.draft.type ?? "unknown"}`,
				);
			}
			const subResult = responseFor(responses, "s");
			const subNotCreated = (subResult.notCreated ?? {}) as Record<string, { type?: string }>;
			if (subNotCreated.sub) {
				throw driverError(
					DriverErrorKind.Unavailable,
					`jmap: submission failed — ${subNotCreated.sub.type ?? "unknown"}`,
				);
			}
			return { messageId, receivedAt };
		},

		async close(): Promise<void> {
			session = undefined;
			mailboxIdByPath = undefined;
			mailboxRoleById = undefined;
		},
	};
}
