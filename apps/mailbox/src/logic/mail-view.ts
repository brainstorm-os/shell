/**
 * Pure projection from vault entities → Mailbox view-models, plus the
 * folder-selection filter. No reactivity here — `app.tsx` feeds it the live
 * `useVaultEntities` snapshot. Kept pure so it is unit-testable without a
 * vault (the demo path uses the exact same functions).
 */

import {
	type MailAddress,
	type MailAttachmentPart,
	MailFlag,
	formatMailAddress,
	isMailFlag,
} from "@brainstorm-os/sdk-types";
import {
	type AccountView,
	EMAIL_TYPE_URL,
	FolderRole,
	type FolderSelection,
	type FolderView,
	MAIL_ACCOUNT_TYPE_URL,
	MAIL_FOLDER_TYPE_URL,
	type MessageView,
	type VaultEntityLike,
} from "../types/mail-view";

function str(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function strArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function addrArray(v: unknown): MailAddress[] {
	if (!Array.isArray(v)) return [];
	const out: MailAddress[] = [];
	for (const item of v) {
		if (item && typeof item === "object" && typeof (item as MailAddress).address === "string") {
			out.push(item as MailAddress);
		}
	}
	return out;
}

/** A part with no `partRef` can never be fetched, so it is dropped rather
 *  than rendered as a chip that would always fail. */
function attachmentPartArray(v: unknown): MailAttachmentPart[] {
	if (!Array.isArray(v)) return [];
	const out: MailAttachmentPart[] = [];
	for (const item of v) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.partRef !== "string" || candidate.partRef.length === 0) continue;
		if (typeof candidate.filename !== "string" || candidate.filename.length === 0) continue;
		const part: MailAttachmentPart = {
			partRef: candidate.partRef,
			filename: candidate.filename,
		};
		if (typeof candidate.mimeType === "string") part.mimeType = candidate.mimeType;
		if (typeof candidate.sizeBytes === "number") part.sizeBytes = candidate.sizeBytes;
		out.push(part);
	}
	return out;
}

function flagArray(v: unknown): MailFlag[] {
	return Array.isArray(v) ? v.filter((x): x is MailFlag => isMailFlag(x)) : [];
}

function hostView(v: unknown): { host: string; port: number; tls: boolean } | null {
	if (!v || typeof v !== "object") return null;
	const raw = v as Record<string, unknown>;
	if (typeof raw.host !== "string" || typeof raw.port !== "number") return null;
	return { host: raw.host, port: raw.port, tls: raw.tls === true };
}

export function accountsFromEntities(entities: readonly VaultEntityLike[]): AccountView[] {
	return (
		entities
			// `enabled: false` is how `mail.disconnect` retires an account (the row
			// survives so synced mail keeps its accountRef) — hide it from the UI.
			.filter((e) => e.type === MAIL_ACCOUNT_TYPE_URL && e.properties.enabled !== false)
			.map((e) => {
				const address = str(e.properties.address);
				const incoming = hostView(e.properties.incoming);
				const outgoing = hostView(e.properties.outgoing);
				const syncWindow = str(e.properties.syncWindow);
				return {
					id: e.id,
					address,
					displayName: str(e.properties.displayName) || address,
					...(incoming && outgoing
						? { imap: { incoming, outgoing, ...(syncWindow ? { syncWindow } : {}) } }
						: {}),
				};
			})
	);
}

export function foldersFromEntities(entities: readonly VaultEntityLike[]): FolderView[] {
	return entities
		.filter((e) => e.type === MAIL_FOLDER_TYPE_URL)
		.map((e) => {
			const roleRaw = str(e.properties.role, FolderRole.Custom);
			const role = (Object.values(FolderRole) as string[]).includes(roleRaw)
				? (roleRaw as FolderRole)
				: FolderRole.Custom;
			const unread = e.properties.unreadCount;
			return {
				id: e.id,
				accountRef: str(e.properties.accountRef),
				path: str(e.properties.path),
				role,
				unreadCount: typeof unread === "number" && Number.isFinite(unread) ? unread : 0,
				backfillDone: e.properties.backfillDone === true,
			};
		});
}

export function toMessageView(e: VaultEntityLike): MessageView {
	const flags = flagArray(e.properties.flags);
	const receivedAt =
		typeof e.properties.receivedAt === "number" && Number.isFinite(e.properties.receivedAt)
			? e.properties.receivedAt
			: 0;
	const messageId = str(e.properties.messageId);
	return {
		id: e.id,
		accountRef: str(e.properties.accountRef),
		folderRefs: strArray(e.properties.folderRefs),
		messageId,
		// Never collapse a missing threadKey to "" — that would merge every
		// keyless message into one bogus thread. Fall back to the (unique)
		// message id, then the entity id.
		threadKey: str(e.properties.threadKey) || messageId || e.id,
		from: addrArray(e.properties.from),
		to: addrArray(e.properties.to),
		cc: addrArray(e.properties.cc),
		subject: str(e.properties.subject),
		receivedAt,
		bodyText: str(e.properties.bodyText),
		bodyHtmlSafe: str(e.properties.bodyHtmlSafe),
		attachments: strArray(e.properties.attachments),
		attachmentParts: attachmentPartArray(e.properties.attachmentParts),
		flags,
		tags: strArray(e.properties.tags),
		unread: flags.includes(MailFlag.Unread),
		flagged: flags.includes(MailFlag.Flagged),
	};
}

/** All messages, newest first. */
export function messagesFromEntities(entities: readonly VaultEntityLike[]): MessageView[] {
	return entities
		.filter((e) => e.type === EMAIL_TYPE_URL)
		.map(toMessageView)
		.sort((a, b) => b.receivedAt - a.receivedAt);
}

/** A conversation: every message sharing a `threadKey` (OQ-MB-3 —
 *  `deriveThreadKey`, shipped in Mailbox-1), collapsed into one list row.
 *  `messages` is oldest-first so an expanded thread reads top→bottom like a
 *  conversation; `latest` drives the collapsed row + sort order. */
export type ThreadView = {
	threadKey: string;
	messages: MessageView[];
	latest: MessageView;
	count: number;
	unreadCount: number;
	flagged: boolean;
	hasAttachments: boolean;
	subject: string;
};

/** Group an already-filtered, newest-first message list into threads, newest
 *  thread first (a thread's recency is its latest message). A single-message
 *  thread is still a `ThreadView` with `count === 1` so the list renders one
 *  uniform row shape whether threading reveals a conversation or not. */
export function groupThreads(messages: readonly MessageView[]): ThreadView[] {
	const order: string[] = [];
	const byKey = new Map<string, MessageView[]>();
	for (const msg of messages) {
		const existing = byKey.get(msg.threadKey);
		if (existing) {
			existing.push(msg);
		} else {
			byKey.set(msg.threadKey, [msg]);
			order.push(msg.threadKey);
		}
	}

	const threads: ThreadView[] = order.map((threadKey) => {
		const group = byKey.get(threadKey) ?? [];
		const ascending = [...group].sort((a, b) => a.receivedAt - b.receivedAt);
		const latest = ascending[ascending.length - 1] ?? group[0];
		if (!latest) {
			throw new Error("groupThreads: empty thread group");
		}
		return {
			threadKey,
			messages: ascending,
			latest,
			count: ascending.length,
			unreadCount: ascending.filter((m) => m.unread).length,
			flagged: ascending.some((m) => m.flagged),
			hasAttachments: ascending.some((m) => m.attachments.length > 0),
			// The earliest message's subject anchors the conversation (later
			// "Re:" subjects echo it); fall back to the latest if the first is
			// empty.
			subject: ascending[0]?.subject || latest.subject,
		};
	});

	return threads.sort((a, b) => b.latest.receivedAt - a.latest.receivedAt);
}

/** Folder entity ids whose role is `inbox` — the union the unified-inbox
 *  smart view aggregates. */
function inboxFolderIds(folders: readonly FolderView[]): Set<string> {
	return new Set(folders.filter((f) => f.role === FolderRole.Inbox).map((f) => f.id));
}

/** Messages matching the rail selection (newest-first, already sorted). */
export function messagesForSelection(
	messages: readonly MessageView[],
	folders: readonly FolderView[],
	selection: FolderSelection,
): MessageView[] {
	switch (selection.kind) {
		case "flagged":
			return messages.filter((m) => m.flagged);
		case "unified-inbox": {
			const inbox = inboxFolderIds(folders);
			// With no real inbox folder yet (fresh / demo), show everything so the
			// unified view is never empty.
			if (inbox.size === 0) return [...messages];
			return messages.filter((m) => m.folderRefs.some((id) => inbox.has(id)));
		}
		case "folder":
			return messages.filter((m) => m.folderRefs.includes(selection.folderId));
	}
}

/** Count of unread messages in the unified inbox — drives the rail badge. */
export function unifiedUnreadCount(
	messages: readonly MessageView[],
	folders: readonly FolderView[],
): number {
	return messagesForSelection(messages, folders, { kind: "unified-inbox" }).filter((m) => m.unread)
		.length;
}

/** A one-line sender label for the list row. */
export function senderLabel(msg: MessageView): string {
	const first = msg.from[0];
	if (!first) return "";
	return first.name?.trim() || first.address;
}

/** A comma-joined recipient summary for the reading-pane header. */
export function recipientSummary(addrs: readonly MailAddress[]): string {
	return addrs.map(formatMailAddress).join(", ");
}

/** Case-insensitive match over subject / sender / recipients / body text. */
export function matchesQuery(msg: MessageView, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return true;
	const haystack = [
		msg.subject,
		msg.bodyText,
		...msg.from.map((a) => `${a.name ?? ""} ${a.address}`),
		...msg.to.map((a) => `${a.name ?? ""} ${a.address}`),
	]
		.join(" ")
		.toLowerCase();
	return haystack.includes(q);
}
