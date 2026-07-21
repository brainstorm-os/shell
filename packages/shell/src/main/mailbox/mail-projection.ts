/**
 * Pure projection: a driver's `RawFolder`/`RawMessage` → `MailFolder/v1` /
 * `Email/v1` property bags (doc 53). One audited path every driver shares:
 * header strings parsed via the shared `parseAddressList`, `threadKey` via the
 * shared `deriveThreadKey` (OQ-MB-3), HTML via `sanitizeMailHtml`. No IO —
 * unit-tested directly, and the sync engine calls it for both real and fake
 * drivers.
 */

import {
	type EmailDef,
	FolderRole,
	type MailAddress,
	type MailFolderDef,
	deriveThreadKey,
	parseAddressList,
} from "@brainstorm-os/sdk-types";
import type { RawFolder, RawMessage } from "./mail-driver";
import { sanitizeMailHtml } from "./mail-sanitize";

/** Map a server folder path to a canonical role when the driver didn't supply
 *  one. Recognises the common IMAP / Gmail names; everything else is custom. */
export function folderRoleForPath(path: string, provided?: FolderRole): FolderRole {
	if (provided) return provided;
	const p = path.trim().toLowerCase();
	const leaf = p.split("/").pop() ?? p;
	if (leaf === "inbox") return FolderRole.Inbox;
	if (leaf.includes("sent")) return FolderRole.Sent;
	if (leaf.includes("draft")) return FolderRole.Drafts;
	if (leaf.includes("archive") || leaf === "all mail") return FolderRole.Archive;
	if (leaf.includes("trash") || leaf.includes("deleted") || leaf.includes("bin")) {
		return FolderRole.Trash;
	}
	if (leaf.includes("spam") || leaf.includes("junk")) return FolderRole.Spam;
	return FolderRole.Custom;
}

export function projectFolder(accountRef: string, raw: RawFolder): MailFolderDef {
	return {
		accountRef,
		path: raw.path,
		role: folderRoleForPath(raw.path, raw.role),
		unreadCount: typeof raw.unreadCount === "number" ? raw.unreadCount : 0,
	};
}

/** Optional address→`Person/v1` resolver (Mailbox-7). When supplied, a
 *  matched participant gets a `personRef`; unmatched addresses are untouched
 *  (link-to-existing, never auto-create — OQ-MB-6). */
export type PersonResolver = (address: string) => string | undefined;

function addressesFromHeader(header: string | undefined, resolve?: PersonResolver): MailAddress[] {
	if (!header || header.trim().length === 0) return [];
	const parsed = parseAddressList(header);
	if (!resolve) return parsed;
	return parsed.map((addr) => {
		const ref = resolve(addr.address);
		return ref ? { ...addr, personRef: ref } : addr;
	});
}

/** Project a raw message into `Email/v1` properties. `folderRef` is the
 *  resolved entity id of the message's folder; `extra` carries fields the
 *  sync engine owns (e.g. a `submissionId` for an outbound projection). */
export function projectMessage(
	accountRef: string,
	raw: RawMessage,
	folderRef: string,
	extra?: Partial<Pick<EmailDef, "submissionId" | "flags">> & { resolvePerson?: PersonResolver },
): EmailDef {
	const resolve = extra?.resolvePerson;
	const cc = addressesFromHeader(raw.cc, resolve);
	const def: EmailDef = {
		accountRef,
		folderRefs: [folderRef],
		messageId: raw.messageId,
		threadKey: deriveThreadKey({
			messageId: raw.messageId,
			...(raw.providerThreadId !== undefined ? { providerThreadId: raw.providerThreadId } : {}),
			...(raw.inReplyTo !== undefined ? { inReplyTo: raw.inReplyTo } : {}),
			...(raw.references !== undefined ? { references: raw.references } : {}),
		}),
		from: addressesFromHeader(raw.from, resolve),
		to: addressesFromHeader(raw.to, resolve),
		receivedAt: raw.receivedAt,
		flags: extra?.flags ?? raw.flags ?? [],
	};
	if (cc.length > 0) def.cc = cc;
	if (raw.subject !== undefined) def.subject = raw.subject;
	if (raw.bodyText !== undefined) def.bodyText = raw.bodyText;
	if (raw.bodyHtml !== undefined) {
		const safe = sanitizeMailHtml(raw.bodyHtml);
		if (safe.length > 0) def.bodyHtmlSafe = safe;
	}
	if (raw.attachmentParts && raw.attachmentParts.length > 0) {
		def.attachmentParts = raw.attachmentParts;
	}
	if (extra?.submissionId) def.submissionId = extra.submissionId;
	return def;
}
