/**
 * IMAP+SMTP `MailDriver` (`MailProtocol.Imap`) — the real wire transport for
 * classic mail accounts (Mailbox-2). Runs only inside the mailbox
 * `utilityProcess` worker: the long-lived TLS sockets live here and never
 * reach a renderer (OQ-MB-2).
 *
 * Wire protocols ride small vetted dependencies rather than hand-rolled
 * parsers: `imapflow` (IMAP), `nodemailer` (SMTP submission), `mailparser`
 * (RFC 822 → structured message). Everything this file *decides* — special-
 * use → role, flags polarity, the UIDVALIDITY cursor state machine, parsed
 * source → `RawMessage` — is pure code in `imap-projection.ts`, unit-tested
 * on fixtures; the wire clients are injected (`ImapDriverIo`) so the driver
 * flow itself is tested without a socket.
 *
 * TLS posture (doc 53 / `MailHostConfig`): `tls: true` is implicit TLS
 * (IMAPS 993 / SMTPS 465); `tls: false` is a **mandatory** STARTTLS upgrade
 * on the cleartext port — plain cleartext is never an option.
 */

import { createRequire } from "node:module";
import { MailProtocol } from "@brainstorm/sdk-types";
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
import {
	type ParsedSourceLike,
	folderRoleFromSpecialUse,
	formatImapCursor,
	imapFlagsToMailFlags,
	parseImapCursor,
	parseImapPartRef,
	rawMessageFromParsed,
	selectNewestUids,
} from "./imap-projection";

const DRIVER_NAME = "imap";

export type MailHostConfigLike = { host: string; port: number; tls: boolean };

// ── injectable wire-client seams (structural subsets of imapflow /
//    nodemailer, so tests drive the driver with fixtures, no socket) ───────

export type ImapListEntryLike = { path: string; specialUse?: string };
export type ImapMailboxLike = { uidValidity?: bigint };
export type ImapLockLike = { release(): void };
export type ImapFetchedMessageLike = {
	uid: number;
	source?: Uint8Array;
	flags?: Set<string> | string[];
	internalDate?: Date;
};
export type ImapClientLike = {
	connect(): Promise<void>;
	logout(): Promise<void>;
	/** EventEmitter seam — imapflow reports post-connect socket failures
	 *  (timeouts, resets) as `'error'` EVENTS outside any command promise;
	 *  an unlistened `'error'` escalates to an uncaughtException and kills
	 *  the worker (F-434). Optional so test fixtures without events still
	 *  satisfy the seam. */
	on?(event: "error", handler: (error: Error) => void): unknown;
	list(): Promise<ImapListEntryLike[]>;
	status(path: string, query: { unseen: boolean }): Promise<{ unseen?: number }>;
	getMailboxLock(path: string): Promise<ImapLockLike>;
	/** Populated while a mailbox is open (imapflow sets `false` otherwise). */
	mailbox?: ImapMailboxLike | false;
	search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false>;
	fetchOne(
		uid: number,
		query: Record<string, unknown>,
		options: { uid: true },
	): Promise<ImapFetchedMessageLike | false>;
};

export type SmtpTransportLike = {
	sendMail(input: Record<string, unknown>): Promise<unknown>;
	close(): void;
};

export type ImapDriverIo = {
	makeImapClient?: (config: {
		host: string;
		port: number;
		secure: boolean;
		auth: { user: string; pass: string };
	}) => ImapClientLike;
	makeSmtpTransport?: (config: {
		host: string;
		port: number;
		secure: boolean;
		requireTLS: boolean;
		auth: { user: string; pass: string };
	}) => SmtpTransportLike;
	parseSource?: (source: Uint8Array) => Promise<ParsedSourceLike>;
	now?: () => number;
};

export type ImapDriverInput = {
	incoming: MailHostConfigLike;
	outgoing: MailHostConfigLike;
	credentials: DriverCredentials;
	io?: ImapDriverIo;
};

// Deferred loads keep imapflow/nodemailer/mailparser (and their dep trees)
// out of test runs that inject fakes; the worker resolves them on first use.
const nodeRequire = createRequire(import.meta.url);

function defaultMakeImapClient(config: {
	host: string;
	port: number;
	secure: boolean;
	auth: { user: string; pass: string };
}): ImapClientLike {
	const { ImapFlow } = nodeRequire("imapflow") as {
		ImapFlow: new (options: Record<string, unknown>) => ImapClientLike;
	};
	return new ImapFlow({ ...config, logger: false });
}

function defaultMakeSmtpTransport(config: {
	host: string;
	port: number;
	secure: boolean;
	requireTLS: boolean;
	auth: { user: string; pass: string };
}): SmtpTransportLike {
	const { createTransport } = nodeRequire("nodemailer") as {
		createTransport: (options: Record<string, unknown>) => SmtpTransportLike;
	};
	return createTransport({ ...config });
}

async function defaultParseSource(source: Uint8Array): Promise<ParsedSourceLike> {
	const { simpleParser } = nodeRequire("mailparser") as {
		simpleParser: (source: Uint8Array) => Promise<ParsedSourceLike>;
	};
	return simpleParser(source);
}

/** imapflow stamps `authenticationFailed` on credential rejections; map that
 *  to `Denied` so the main process surfaces a re-auth, everything else to
 *  `Unavailable` (network / server). */
function toDriverError(error: unknown): Error {
	if (error instanceof Error) {
		const flagged = error as Error & { authenticationFailed?: boolean };
		if (flagged.authenticationFailed === true) {
			return driverError(DriverErrorKind.Denied, `${DRIVER_NAME}: authentication failed`);
		}
		if (
			error.name === DriverErrorKind.Denied ||
			error.name === DriverErrorKind.Invalid ||
			error.name === DriverErrorKind.Unavailable
		) {
			return error;
		}
		return driverError(DriverErrorKind.Unavailable, `${DRIVER_NAME}: ${error.message}`);
	}
	return driverError(DriverErrorKind.Unavailable, `${DRIVER_NAME}: ${String(error)}`);
}

export function makeImapSmtpDriver(input: ImapDriverInput): MailDriver {
	const username = input.credentials.username;
	if (!username || username.length === 0) {
		throw driverError(DriverErrorKind.Invalid, `${DRIVER_NAME}: credentials require a username`);
	}
	const io = input.io ?? {};
	const makeImapClient = io.makeImapClient ?? defaultMakeImapClient;
	const makeSmtpTransport = io.makeSmtpTransport ?? defaultMakeSmtpTransport;
	const parseSource = io.parseSource ?? defaultParseSource;
	const now = io.now ?? Date.now;
	const auth = { user: username, pass: input.credentials.secret };

	let imap: ImapClientLike | null = null;
	let imapReady: Promise<ImapClientLike> | null = null;
	let smtp: SmtpTransportLike | null = null;

	function ensureImap(): Promise<ImapClientLike> {
		if (!imapReady) {
			const client = makeImapClient({
				host: input.incoming.host,
				port: input.incoming.port,
				secure: input.incoming.tls,
				auth,
			});
			// Lifetime 'error' listener (F-434): a socket timeout on an idle or
			// half-torn-down connection must drop the cached client so the next
			// call reconnects — never crash the worker as an unhandled 'error'.
			client.on?.("error", (error) => {
				console.warn(`[mailbox:imap] connection error: ${error.message}`);
				if (imap === client) {
					imap = null;
					imapReady = null;
				}
			});
			imapReady = client
				.connect()
				.then(() => {
					imap = client;
					return client;
				})
				.catch((error: unknown) => {
					imapReady = null;
					throw toDriverError(error);
				});
		}
		return imapReady;
	}

	function ensureSmtp(): SmtpTransportLike {
		if (!smtp) {
			smtp = makeSmtpTransport({
				host: input.outgoing.host,
				port: input.outgoing.port,
				secure: input.outgoing.tls,
				// The STARTTLS upgrade is mandatory on a cleartext port — fail
				// the submission rather than ever sending credentials in clear.
				requireTLS: !input.outgoing.tls,
				auth,
			});
		}
		return smtp;
	}

	return {
		protocol: MailProtocol.Imap,

		async listFolders(): Promise<RawFolder[]> {
			const client = await ensureImap();
			try {
				const entries = await client.list();
				const folders: RawFolder[] = [];
				for (const entry of entries) {
					const role = folderRoleFromSpecialUse(entry.specialUse);
					folders.push({ path: entry.path, ...(role !== undefined ? { role } : {}) });
				}
				// Unread count only for the inbox (mirrors the Gmail driver —
				// one STATUS round-trip, not one per folder).
				const inbox = folders.find((f) => f.path.toUpperCase() === "INBOX");
				if (inbox) {
					try {
						const status = await client.status(inbox.path, { unseen: true });
						if (typeof status.unseen === "number") inbox.unreadCount = status.unseen;
					} catch {
						// STATUS is a nicety; a server rejecting it never fails the sync.
					}
				}
				return folders;
			} catch (error) {
				throw toDriverError(error);
			}
		},

		async fetch(spec: FetchSpec): Promise<FetchResult> {
			const fetchUids = async (
				c: ImapClientLike,
				picked: readonly number[],
				uidValidity: string,
			): Promise<RawMessage[]> => {
				const out: RawMessage[] = [];
				for (const uid of picked) {
					const fetched = await c.fetchOne(
						uid,
						{ source: true, flags: true, internalDate: true },
						{ uid: true },
					);
					if (!fetched || !fetched.source) continue;
					const parsed = await parseSource(fetched.source);
					out.push(
						rawMessageFromParsed(parsed, {
							folderPath: spec.folderPath,
							flags: imapFlagsToMailFlags(fetched.flags ?? []),
							fallbackMessageId: `<imap-${uidValidity}-${uid}@brainstorm.local>`,
							receivedAtFallback: fetched.internalDate?.getTime() ?? now(),
							uid,
							uidValidity,
						}),
					);
				}
				return out;
			};
			const client = await ensureImap();
			let lock: ImapLockLike | null = null;
			try {
				lock = await client.getMailboxLock(spec.folderPath);
				const mailbox = client.mailbox;
				const uidValidity =
					mailbox && typeof mailbox === "object" && mailbox.uidValidity !== undefined
						? mailbox.uidValidity.toString()
						: "0";

				const parsedCursor = spec.cursor !== undefined ? parseImapCursor(spec.cursor) : null;
				// A UIDVALIDITY mismatch voids the cursor entirely — its lastUid
				// belongs to the dead UID space and must not seed the new one.
				const cursor = parsedCursor && parsedCursor.uidValidity === uidValidity ? parsedCursor : null;

				if (spec.walk === FetchWalk.Backfill) {
					// Older-walk (Mailbox-12): newest N strictly below the cursor's
					// floor; `sinceMs` deliberately ignored — the user asked for
					// mail beyond the window. A voided cursor restarts from the top
					// (idempotent upserts absorb the overlap).
					const floor = cursor ? cursor.lastUid : Number.POSITIVE_INFINITY;
					if (floor <= 1) {
						return { messages: [] };
					}
					const found =
						floor === Number.POSITIVE_INFINITY
							? await client.search({ all: true }, { uid: true })
							: await client.search({ uid: `1:${floor - 1}` }, { uid: true });
					const below = (found || []).filter((u) => u < floor);
					const picked = selectNewestUids(below, spec.limit);
					const messages = await fetchUids(client, picked, uidValidity);
					const lowest = picked.reduce((min, u) => (u < min ? u : min), Number.POSITIVE_INFINITY);
					const remaining = below.some((u) => u < lowest);
					return {
						messages,
						...(remaining ? { nextCursor: formatImapCursor({ uidValidity, lastUid: lowest }) } : {}),
					};
				}

				let uids: number[];
				if (cursor) {
					// Incremental: everything after the last seen UID. The `n:*`
					// range always matches at least the newest message even when
					// its UID < n (RFC 3501 §6.4.8), so filter defensively.
					const found = await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true });
					uids = (found || []).filter((u) => u > cursor.lastUid);
				} else {
					// Initial walk (or UIDVALIDITY changed — every cached UID is
					// void, re-walk bounded by the window; upserts dedupe).
					const query = spec.sinceMs !== undefined ? { since: new Date(spec.sinceMs) } : { all: true };
					uids = (await client.search(query, { uid: true })) || [];
				}

				const highestUid = uids.reduce((max, u) => (u > max ? u : max), cursor?.lastUid ?? 0);
				const picked = selectNewestUids(uids, spec.limit);
				const messages = await fetchUids(client, picked, uidValidity);

				return {
					messages,
					...(highestUid > 0
						? { nextCursor: formatImapCursor({ uidValidity, lastUid: highestUid }) }
						: {}),
				};
			} catch (error) {
				throw toDriverError(error);
			} finally {
				lock?.release();
			}
		},

		async fetchAttachment(spec: FetchAttachmentSpec): Promise<FetchAttachmentResult> {
			const addr = parseImapPartRef(spec.partRef);
			if (!addr) {
				throw driverError(DriverErrorKind.Invalid, "imap: malformed attachment part reference");
			}
			const limit = Math.min(spec.maxBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
			const client = await ensureImap();
			let lock: ImapLockLike | null = null;
			try {
				lock = await client.getMailboxLock(spec.folderPath);
				const mailbox = client.mailbox;
				const uidValidity =
					mailbox && typeof mailbox === "object" && mailbox.uidValidity !== undefined
						? mailbox.uidValidity.toString()
						: "0";
				// A recreated mailbox reuses uids for different messages, so a stale
				// part ref must fail rather than return some other message's bytes.
				if (uidValidity !== addr.uidValidity) {
					throw driverError(
						DriverErrorKind.Invalid,
						"imap: attachment reference is stale (uidValidity changed)",
					);
				}
				const fetched = await client.fetchOne(addr.uid, { source: true }, { uid: true });
				if (!fetched || !fetched.source) {
					throw driverError(DriverErrorKind.Invalid, "imap: message no longer available");
				}
				const parsed = await parseSource(fetched.source);
				const attachment = (parsed.attachments ?? [])[addr.index];
				if (!attachment?.content) {
					throw driverError(DriverErrorKind.Invalid, "imap: attachment part not found");
				}
				const bytes = attachment.content;
				if (bytes.length > limit) {
					throw driverError(
						DriverErrorKind.Invalid,
						`imap: attachment exceeds ${limit} bytes (got ${bytes.length})`,
					);
				}
				return {
					bytes,
					...(attachment.contentType !== undefined ? { mimeType: attachment.contentType } : {}),
				};
			} catch (error) {
				throw toDriverError(error);
			} finally {
				lock?.release();
			}
		},

		async submit(message: OutboundMessage): Promise<SubmitResult> {
			assertOutboundHeadersSafe(DRIVER_NAME, message);
			const messageId = submissionMessageId(message.submissionId);
			const receivedAt = now();
			try {
				await ensureSmtp().sendMail({
					from: message.from,
					to: message.to,
					...(message.cc && message.cc.length > 0 ? { cc: message.cc } : {}),
					...(message.subject !== undefined ? { subject: message.subject } : {}),
					...(message.bodyText !== undefined ? { text: message.bodyText } : {}),
					...(message.bodyHtml !== undefined ? { html: message.bodyHtml } : {}),
					...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
					...(message.references && message.references.length > 0
						? { references: message.references }
						: {}),
					messageId,
					date: new Date(receivedAt),
				});
			} catch (error) {
				throw toDriverError(error);
			}
			return { messageId, receivedAt };
		},

		async close(): Promise<void> {
			const client = imap;
			imap = null;
			imapReady = null;
			if (client) await client.logout().catch(() => {});
			const transport = smtp;
			smtp = null;
			try {
				transport?.close();
			} catch {
				// close() is best-effort and idempotent.
			}
		},
	};
}
