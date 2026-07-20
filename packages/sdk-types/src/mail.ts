/**
 * Mail contracts (`brainstorm/MailAccount|MailFolder|Email/v1`) per
 * .
 *
 * Mailbox brings email **inside the vault as entities** in the one shared
 * object space (doc 21): a received `Email/v1` is a normal object, so
 * Automations, the Agent app, Search, and Graph operate on mail the same
 * way they operate on everything else — no Mailbox API needed. Mailbox is
 * also the **reference connector** for the connector framework (doc 56);
 * these three types are the data its shell-side `MailTransport` worker
 * projects fetched messages into, and the data the viewer app reads.
 *
 * **Contract-freeze scope (Mailbox-1).** Shapes + enums + structural
 * validators + the two load-bearing decisions encoded as code:
 *   - **threadKey derivation** (OQ-MB-3 → derive from the RFC 5322
 *     `References`/`In-Reply-To` chain ourselves, preferring a
 *     provider-supplied thread id when present — cross-provider consistent
 *     yet free where the provider already grouped).
 *   - **address parsing/normalisation** the `from`/`to`/`cc` projection and
 *     the Person resolver (OQ-MB-6 → link-to-existing, never auto-create)
 *     share, so an address resolves identically on both paths.
 *
 * **Custody invariant (mirrors doc 56 / 29).** A `MailAccount/v1` holds
 * **no secret** — the OAuth token / app-password lives in Tier 2 keyed by
 * the account id; the shell injects auth into `MailTransport`, the renderer
 * never holds it. `validateMailAccount` enforces this structurally: a
 * token-shaped field on the entity is a validation error.
 *
 * Near-leaf: only the `enum-guard` leaf is imported, so this barrel
 * re-exports with no cycle (same discipline as `connector.ts`).
 */

import { enumGuard } from "./enum-guard";

export const MAIL_ACCOUNT_TYPE_URL = "brainstorm/MailAccount/v1";
export const MAIL_FOLDER_TYPE_URL = "brainstorm/MailFolder/v1";
export const EMAIL_TYPE_URL = "brainstorm/Email/v1";

/** Local alias for an entity id — a plain `string` (rather than the
 *  `index.ts` `EntityId` alias) so this contract leaf stays
 *  dependency-free and introduces no barrel cycle. */
type MailEntityId = string;

// ───────────────────────────── enums ─────────────────────────────

/** Wire protocol of a configured account (doc 53 §`MailAccount/v1`).
 *  `imap`+SMTP and `jmap` are v1; `gmail-api`/`ms-graph` ride the connector
 *  OAuth broker (doc 56). */
export enum MailProtocol {
	Imap = "imap",
	Jmap = "jmap",
	GmailApi = "gmail-api",
	MsGraph = "ms-graph",
}

export const MAIL_PROTOCOLS = Object.freeze([
	MailProtocol.Imap,
	MailProtocol.Jmap,
	MailProtocol.GmailApi,
	MailProtocol.MsGraph,
]) as readonly MailProtocol[];

/** How `MailTransport` authenticates. `oauth2` flows through the connector
 *  OAuth broker (doc 56 §OAuth broker); `app-password`/`basic` store a
 *  secret in Tier 2 (doc 29). */
export enum AuthKind {
	OAuth2 = "oauth2",
	AppPassword = "app-password",
	Basic = "basic",
}

export const AUTH_KINDS = Object.freeze([
	AuthKind.OAuth2,
	AuthKind.AppPassword,
	AuthKind.Basic,
]) as readonly AuthKind[];

/** Bounds the initial backfill (doc 53 §Sync model; mirrors selective sync,
 *  doc 20). `all` is hard-capped + paginated, never unbounded (OQ-MB-4). */
export enum SyncWindow {
	Days30 = "30d",
	Days90 = "90d",
	Year1 = "1y",
	All = "all",
}

export const SYNC_WINDOWS = Object.freeze([
	SyncWindow.Days30,
	SyncWindow.Days90,
	SyncWindow.Year1,
	SyncWindow.All,
]) as readonly SyncWindow[];

/** A server folder/label's canonical role, so role-based views (inbox,
 *  sent) work cross-provider regardless of the localised folder name. */
export enum FolderRole {
	Inbox = "inbox",
	Sent = "sent",
	Drafts = "drafts",
	Archive = "archive",
	Trash = "trash",
	Spam = "spam",
	Custom = "custom",
}

export const FOLDER_ROLES = Object.freeze([
	FolderRole.Inbox,
	FolderRole.Sent,
	FolderRole.Drafts,
	FolderRole.Archive,
	FolderRole.Trash,
	FolderRole.Spam,
	FolderRole.Custom,
]) as readonly FolderRole[];

/** Per-message server flags (doc 53). **Mutable** and synced back to the
 *  server by `MailTransport` — distinct from vault-local `tags` which never
 *  leave the device. */
export enum MailFlag {
	Unread = "unread",
	Flagged = "flagged",
	Answered = "answered",
	Draft = "draft",
}

export const MAIL_FLAGS = Object.freeze([
	MailFlag.Unread,
	MailFlag.Flagged,
	MailFlag.Answered,
	MailFlag.Draft,
]) as readonly MailFlag[];

export const isMailProtocol = enumGuard(MAIL_PROTOCOLS);
export const isAuthKind = enumGuard(AUTH_KINDS);
export const isSyncWindow = enumGuard(SYNC_WINDOWS);
export const isFolderRole = enumGuard(FOLDER_ROLES);
export const isMailFlag = enumGuard(MAIL_FLAGS);

// ──────────────────────── value shapes ────────────────────────

/** IMAP/SMTP host coordinates. Absent for JMAP / provider-API protocols
 *  (a single endpoint, derived from the connector). */
export type MailHostConfig = {
	host: string;
	port: number;
	/** `true` = implicit TLS (IMAPS 993 / SMTPS 465); `false` = STARTTLS
	 *  upgrade on the cleartext port (143 / 587). Plain cleartext is never
	 *  an option — there is no `none`. */
	tls: boolean;
};

/** One participant on a message. The raw `address` + `name` are always
 *  preserved (for display and for re-resolution); `personRef` is set by the
 *  address→`Person/v1` resolver (Mailbox-7) when the address matches an
 *  existing contact (OQ-MB-6: link-to-existing). */
export type MailAddress = {
	address: string;
	name?: string;
	personRef?: MailEntityId;
};

/** Where an attachment lives on the server, so its bytes can be fetched
 *  lazily on user demand instead of eagerly at sync (Mailbox-6). The shape
 *  is protocol-neutral: IMAP addresses a part by the message uid + MIME part
 *  path, Gmail by its opaque `attachmentId`, so each driver reads back only
 *  the token it minted and no cross-driver decoding exists. */
export type MailAttachmentPart = {
	/** Driver-issued address for this part — opaque above the driver. */
	partRef: string;
	filename: string;
	/** Server-declared content type. Advisory: the fetch path re-derives a
	 *  served mime from the filename rather than trusting a server string. */
	mimeType?: string;
	/** Server-declared size. Advisory only — the fetch is bounded
	 *  independently, since a lying server must not size our buffer. */
	sizeBytes?: number;
};

// ──────────────────────── entity payloads ────────────────────────

/** `brainstorm/MailAccount/v1` — one configured account. **Holds no
 *  secret** (custody invariant): the token / app-password lives in Tier 2
 *  keyed by this entity's id (doc 29). */
export type MailAccountDef = {
	address: string;
	displayName?: string;
	protocol: MailProtocol;
	authKind: AuthKind;
	/** IMAP host (absent for JMAP / provider-API). */
	incoming?: MailHostConfig;
	/** SMTP host (absent for JMAP / provider-API). */
	outgoing?: MailHostConfig;
	syncWindow: SyncWindow;
	enabled: boolean;
	/** `ConnectorAccount/v1` whose Tier-2 entry holds this account's OAuth
	 *  tokens (doc 56 custody) — set for provider-API protocols
	 *  (`gmail-api` / `ms-graph`) that auth through the connector broker;
	 *  absent for IMAP/JMAP password auth (their secret keys off this
	 *  entity's own id). */
	connectorAccountRef?: MailEntityId;
};

/** `brainstorm/MailFolder/v1` — a server folder/label, mirrored so folder
 *  views work offline and a folder is addressable. */
export type MailFolderDef = {
	accountRef: MailEntityId;
	/** Server path / label name (`INBOX`, `[Gmail]/Sent Mail`, a custom
	 *  label). */
	path: string;
	role: FolderRole;
	unreadCount: number;
};

/** `brainstorm/Email/v1` — the message. **Received mail is immutable**;
 *  only `flags` (server state) and `tags` (vault-local) and a draft body
 *  are mutable. */
export type EmailDef = {
	accountRef: MailEntityId;
	/** A message can be in multiple labels (Gmail), count `{1,∞}`. */
	folderRefs: MailEntityId[];
	/** RFC 5322 `Message-ID` — the stable dedupe + idempotency key across
	 *  devices. */
	messageId: string;
	/** Provider thread id or References-derived (see `deriveThreadKey`);
	 *  threads surface as a `List/v1` view, not a new type. */
	threadKey?: string;
	from: MailAddress[];
	to: MailAddress[];
	cc?: MailAddress[];
	subject?: string;
	/** Epoch ms (the `dateTime` property type stores ms). */
	receivedAt: number;
	bodyText?: string;
	/** Sanitised HTML, rendered through the embed sandbox (no scripts, no
	 *  remote fetch until "Show remote content"). Immutable. */
	bodyHtmlSafe?: string;
	/** Each attachment is a `File/v1` entity (doc 30) — populated only once
	 *  its bytes have actually been fetched into the vault. Empty on a
	 *  freshly-synced message even when it *has* attachments; read
	 *  `attachmentParts` for what the message carries. */
	attachments?: MailEntityId[];
	/** What the server says this message carries, captured at sync so the
	 *  reading pane can show chips without downloading anything (Mailbox-6:
	 *  sync stays metadata-only). Fetching a part mints a `File/v1` and
	 *  appends it to `attachments`. */
	attachmentParts?: MailAttachmentPart[];
	flags: MailFlag[];
	tags?: MailEntityId[];
	/** Client-stamped id for an outbound message — the Sent-folder
	 *  projection rejects a duplicate so a flaky network never double-sends
	 *  (doc 53 §Sending; idempotent submission). Absent on received mail. */
	submissionId?: string;
};

// ──────────────────────── sync budgets ────────────────────────
//
// doc 53 §Performance budgets + OQ-MB-4 (syncWindow=all is bounded, never
// unbounded). The backfill walks newest-first and stops at whichever bound
// hits first.

/** `all` is not "every message ever" — it is hard-capped per account so a
 *  200k-message mailbox cannot exhaust the storage budget (OQ-MB-4
 *  resolved: hard cap + newest-first pagination, not refuse). */
export const SYNC_WINDOW_ALL_MAX_MESSAGES = 50_000;

/** Days of backfill each bounded `SyncWindow` covers; `all` returns null
 *  (no time bound — only the message-count cap applies). */
export function syncWindowDays(window: SyncWindow): number | null {
	switch (window) {
		case SyncWindow.Days30:
			return 30;
		case SyncWindow.Days90:
			return 90;
		case SyncWindow.Year1:
			return 365;
		case SyncWindow.All:
			return null;
	}
}

// ──────────────────────── address helpers ────────────────────────
//
// Shared by the projection (`from`/`to`/`cc` mapping in MailTransport) and
// the Person resolver (Mailbox-7) so an address resolves identically on
// both paths — the OQ-MB-6 keystone.

/** Lowercase + trim for case-insensitive equality. Email local-parts are
 *  technically case-sensitive per RFC 5321, but no real-world provider
 *  honours that, and matching against a `Person/v1` must be forgiving. */
export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

/** A deliberately permissive `local@domain` shape check — enough to reject
 *  obvious junk in a header without rejecting valid-but-unusual addresses
 *  (full RFC 5322 grammar is not worth re-implementing). */
export function isEmailAddress(value: string): boolean {
	const v = value.trim();
	const at = v.indexOf("@");
	if (at <= 0 || at !== v.lastIndexOf("@")) return false;
	const domain = v.slice(at + 1);
	return domain.length > 0 && domain.includes(".") && !/\s/.test(v);
}

/** Parse one RFC 5322 address (`Dana Lee <dana@example.com>`,
 *  `"Lee, Dana" <dana@example.com>`, or a bare `dana@example.com`) into
 *  `{ address, name? }`. Returns null when no address can be extracted. */
export function parseMailAddress(raw: string): MailAddress | null {
	const s = raw.trim();
	if (s.length === 0) return null;
	const angle = s.match(/^(.*?)<([^>]+)>\s*$/);
	if (angle) {
		const address = (angle[2] ?? "").trim();
		if (!isEmailAddress(address)) return null;
		let name = (angle[1] ?? "")
			.trim()
			.replace(/^"(.*)"$/, "$1")
			.trim();
		if (name.length === 0) name = "";
		return name.length > 0 ? { address, name } : { address };
	}
	if (!isEmailAddress(s)) return null;
	return { address: s };
}

/** Parse a comma-separated address header (`a@x.com, "Lee, D" <d@y.com>`)
 *  into `MailAddress[]`. Splits on commas that are not inside quotes or
 *  angle brackets, so a quoted display name containing a comma survives. */
export function parseAddressList(header: string): MailAddress[] {
	const out: MailAddress[] = [];
	let depthAngle = 0;
	let inQuote = false;
	let start = 0;
	const flush = (end: number): void => {
		const chunk = header.slice(start, end);
		const parsed = parseMailAddress(chunk);
		if (parsed) out.push(parsed);
		start = end + 1;
	};
	for (let i = 0; i < header.length; i++) {
		const ch = header[i];
		if (ch === '"') inQuote = !inQuote;
		else if (!inQuote && ch === "<") depthAngle++;
		else if (!inQuote && ch === ">") depthAngle = Math.max(0, depthAngle - 1);
		else if (ch === "," && !inQuote && depthAngle === 0) flush(i);
	}
	flush(header.length);
	return out;
}

/** Render a `MailAddress` back to a header form for display / compose
 *  (`Dana Lee <dana@example.com>` or a bare address). */
export function formatMailAddress(addr: MailAddress): string {
	const name = addr.name?.trim();
	if (!name) return addr.address;
	const safe = /[",<>]/.test(name) ? `"${name.replace(/"/g, "")}"` : name;
	return `${safe} <${addr.address}>`;
}

// ──────────────────────── thread derivation ────────────────────────

/** Inputs to `deriveThreadKey`: whatever the transport could extract. */
export type ThreadInput = {
	messageId: string;
	/** Provider-supplied thread id (Gmail `threadId`, JMAP `threadId`). */
	providerThreadId?: string;
	/** RFC 5322 `In-Reply-To` (a single message id). */
	inReplyTo?: string;
	/** RFC 5322 `References` (ordered, root-first). */
	references?: string[];
};

/** Strip surrounding `<…>` and whitespace from a raw message-id token. */
function cleanMessageId(id: string): string {
	return id
		.trim()
		.replace(/^<(.*)>$/, "$1")
		.trim();
}

/**
 * The thread a message belongs to (OQ-MB-3 resolved). Precedence:
 *   1. the provider's own thread id when present (Gmail/JMAP already
 *      grouped — honour it, it is authoritative and cross-device stable);
 *   2. else the **root** of the `References` chain (the conversation's
 *      first message id) — RFC 5322 §3.6.4 puts the originating id first;
 *   3. else `In-Reply-To` (a one-deep reply with no `References`);
 *   4. else the message's own id (a thread of one).
 * Always returns a non-empty key (the message-id fallback never collides
 * since `Message-ID` is unique).
 */
export function deriveThreadKey(input: ThreadInput): string {
	const provider = input.providerThreadId?.trim();
	if (provider) return provider;
	const refs = (input.references ?? []).map(cleanMessageId).filter((r) => r.length > 0);
	if (refs.length > 0) return refs[0] as string;
	const inReplyTo = input.inReplyTo ? cleanMessageId(input.inReplyTo) : "";
	if (inReplyTo.length > 0) return inReplyTo;
	return cleanMessageId(input.messageId);
}

// ──────────────────────────── validators ────────────────────────────
//
// Structural validation only — non-blank required fields, known enum
// members, no embedded secret (custody invariant). Mirrors connector.ts:
// each returns a list of stable issue codes so callers can localise.

export enum MailIssueCode {
	EmptyAddress = "empty-address",
	InvalidAddress = "invalid-address",
	InvalidProtocol = "invalid-protocol",
	InvalidAuthKind = "invalid-auth-kind",
	InvalidSyncWindow = "invalid-sync-window",
	InvalidHostConfig = "invalid-host-config",
	EmbeddedSecret = "embedded-secret",
	MissingAccountRef = "missing-account-ref",
	EmptyFolderPath = "empty-folder-path",
	InvalidFolderRole = "invalid-folder-role",
	EmptyMessageId = "empty-message-id",
	NoFolderRefs = "no-folder-refs",
	NoSender = "no-sender",
	InvalidReceivedAt = "invalid-received-at",
	InvalidFlag = "invalid-flag",
}

export type MailIssue = { code: MailIssueCode; message: string };

function isBlank(v: unknown): boolean {
	return typeof v !== "string" || v.trim().length === 0;
}

/** Keys whose presence on a `MailAccount` signals a leaked secret — the
 *  custody invariant says the token lives in Tier 2, never on the entity
 *  (same pattern as `connector.ts`). */
const SECRET_KEY_PATTERN =
	/(token|secret|password|passwd|access[_-]?token|refresh[_-]?token|api[_-]?key|credential)/i;

function isValidHostConfig(h: unknown): h is MailHostConfig {
	if (!h || typeof h !== "object") return false;
	const c = h as Record<string, unknown>;
	return (
		typeof c.host === "string" &&
		c.host.trim().length > 0 &&
		typeof c.port === "number" &&
		Number.isInteger(c.port) &&
		c.port > 0 &&
		c.port <= 65535 &&
		typeof c.tls === "boolean"
	);
}

export function validateMailAccount(def: MailAccountDef): MailIssue[] {
	const issues: MailIssue[] = [];
	if (isBlank(def.address)) {
		issues.push({ code: MailIssueCode.EmptyAddress, message: "Account has no address." });
	} else if (!isEmailAddress(def.address)) {
		issues.push({
			code: MailIssueCode.InvalidAddress,
			message: `Account address "${def.address}" is not a valid email address.`,
		});
	}
	if (!isMailProtocol(def.protocol)) {
		issues.push({
			code: MailIssueCode.InvalidProtocol,
			message: `Unknown mail protocol "${String(def.protocol)}".`,
		});
	}
	if (!isAuthKind(def.authKind)) {
		issues.push({
			code: MailIssueCode.InvalidAuthKind,
			message: `Unknown auth kind "${String(def.authKind)}".`,
		});
	}
	if (!isSyncWindow(def.syncWindow)) {
		issues.push({
			code: MailIssueCode.InvalidSyncWindow,
			message: `Unknown sync window "${String(def.syncWindow)}".`,
		});
	}
	// IMAP requires both host configs; JMAP / provider-API use a single
	// derived endpoint and legitimately carry neither.
	if (def.protocol === MailProtocol.Imap) {
		if (!isValidHostConfig(def.incoming)) {
			issues.push({
				code: MailIssueCode.InvalidHostConfig,
				message: "IMAP account is missing a valid incoming host config.",
			});
		}
		if (!isValidHostConfig(def.outgoing)) {
			issues.push({
				code: MailIssueCode.InvalidHostConfig,
				message: "IMAP account is missing a valid outgoing (SMTP) host config.",
			});
		}
	} else {
		if (def.incoming !== undefined && !isValidHostConfig(def.incoming)) {
			issues.push({
				code: MailIssueCode.InvalidHostConfig,
				message: "incoming host config is present but malformed.",
			});
		}
		if (def.outgoing !== undefined && !isValidHostConfig(def.outgoing)) {
			issues.push({
				code: MailIssueCode.InvalidHostConfig,
				message: "outgoing host config is present but malformed.",
			});
		}
	}
	for (const key of Object.keys(def as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			issues.push({
				code: MailIssueCode.EmbeddedSecret,
				message: `Account entity carries a secret-shaped field "${key}" — secrets belong in Tier 2.`,
			});
		}
	}
	return issues;
}

export function validateMailFolder(def: MailFolderDef): MailIssue[] {
	const issues: MailIssue[] = [];
	if (isBlank(def.accountRef)) {
		issues.push({
			code: MailIssueCode.MissingAccountRef,
			message: "Folder has no account reference.",
		});
	}
	if (isBlank(def.path)) {
		issues.push({ code: MailIssueCode.EmptyFolderPath, message: "Folder has no path." });
	}
	if (!isFolderRole(def.role)) {
		issues.push({
			code: MailIssueCode.InvalidFolderRole,
			message: `Unknown folder role "${String(def.role)}".`,
		});
	}
	return issues;
}

export function validateEmail(def: EmailDef): MailIssue[] {
	const issues: MailIssue[] = [];
	if (isBlank(def.accountRef)) {
		issues.push({
			code: MailIssueCode.MissingAccountRef,
			message: "Email has no account reference.",
		});
	}
	if (isBlank(def.messageId)) {
		issues.push({ code: MailIssueCode.EmptyMessageId, message: "Email has no Message-ID." });
	}
	if (!Array.isArray(def.folderRefs) || def.folderRefs.length === 0) {
		issues.push({ code: MailIssueCode.NoFolderRefs, message: "Email is in no folder." });
	}
	if (!Array.isArray(def.from) || def.from.length === 0) {
		issues.push({ code: MailIssueCode.NoSender, message: "Email has no sender." });
	}
	if (typeof def.receivedAt !== "number" || !Number.isFinite(def.receivedAt)) {
		issues.push({
			code: MailIssueCode.InvalidReceivedAt,
			message: "Email receivedAt must be an epoch-ms number.",
		});
	}
	if (Array.isArray(def.flags)) {
		for (const flag of def.flags) {
			if (!isMailFlag(flag)) {
				issues.push({
					code: MailIssueCode.InvalidFlag,
					message: `Unknown mail flag "${String(flag)}".`,
				});
			}
		}
	}
	return issues;
}

export const isValidMailAccount = (def: MailAccountDef): boolean =>
	validateMailAccount(def).length === 0;
export const isValidMailFolder = (def: MailFolderDef): boolean =>
	validateMailFolder(def).length === 0;
export const isValidEmail = (def: EmailDef): boolean => validateEmail(def).length === 0;
