/**
 * `MailSyncEngine` — the shell-side mail sync + send spine (Mailbox-2). The
 * analogue of `SyncRunner` (doc 56 / connectors): pure-ish, every IO injected
 * via ports, so the spine is unit-tested and the in-process pipeline test
 * drives it end-to-end without a real socket.
 *
 * Sync model (doc 53 / doc 20): list folders → upsert `MailFolder/v1`; fetch
 * each folder bounded by `syncWindow`; project + **idempotent upsert** of
 * `Email/v1` keyed on `Message-ID` (the cross-device dedupe key). Conflict
 * policy is disjoint-by-construction: the server is authoritative for message
 * existence + flags (a re-fetch overwrites flags only), the vault is
 * authoritative for tags + AI properties (never touched here).
 *
 * Send (doc 53 §Sending): idempotent on a client-stamped `submissionId` — a
 * resend after a crash finds the existing Sent `Email/v1` and never
 * double-submits.
 */

import {
	EMAIL_TYPE_URL,
	type EmailDef,
	FolderRole,
	MAIL_FOLDER_TYPE_URL,
	type MailFlag,
	SYNC_WINDOW_ALL_MAX_MESSAGES,
	type SyncWindow,
	syncWindowDays,
} from "@brainstorm/sdk-types";
import type { MailDriver, OutboundMessage } from "./mail-driver";
import { FetchWalk } from "./mail-driver";
import { projectFolder, projectMessage } from "./mail-projection";
import { resolvePersonRef } from "./person-resolver";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Single-page fetch cap for a bounded window (the engine pages until a
 *  folder is caught up; `all` is additionally capped by message count). */
const DEFAULT_PAGE_LIMIT = 500;
/** One backfill call is a user gesture — keep the page small enough to feel
 *  responsive (a page can be hundreds of per-message provider calls). */
const BACKFILL_PAGE_LIMIT = 200;

/** The account fields the engine needs (token-free — the secret was already
 *  injected into the driver by the caller). */
export type SyncAccount = {
	id: string;
	syncWindow: SyncWindow;
};

export type ExistingEmail = { id: string; flags: MailFlag[]; folderRefs: string[] };

/** A stored folder row + its persisted older-walk state (Mailbox-12). */
export type BackfillFolder = {
	id: string;
	path: string;
	backfillCursor?: string;
	backfillDone?: boolean;
};

export type MailBackfillResult = {
	accountRef: string;
	created: number;
	updated: number;
	/** Every folder's older-walk is exhausted — nothing left to load. */
	done: boolean;
	startedAt: string;
	finishedAt: string;
};

export type MailSyncPorts = {
	driver: MailDriver;
	/** Folder entity id for `(accountRef, path)`, or null. */
	findFolderByPath(accountRef: string, path: string): Promise<string | null>;
	/** Existing email for `(accountRef, messageId)` — the idempotency lookup. */
	findEmailByMessageId(accountRef: string, messageId: string): Promise<ExistingEmail | null>;
	/** Existing Sent email for a `submissionId` — the send-idempotency lookup. */
	findEmailBySubmissionId(accountRef: string, submissionId: string): Promise<string | null>;
	createEntity(type: string, properties: Record<string, unknown>): Promise<{ id: string }>;
	updateEntity(id: string, patch: Record<string, unknown>): Promise<void>;
	/** Optional address→`Person/v1` index for participant resolution
	 *  (Mailbox-7). Built once per sync; absent ⇒ no resolution. */
	loadPersonIndex?(): Promise<ReadonlyMap<string, string>>;
	/** Stored folder rows for an account, with the persisted backfill state
	 *  (Mailbox-12). Absent ⇒ backfill unsupported by the host. */
	listAccountFolders?(accountRef: string): Promise<BackfillFolder[]>;
	/** Test/tuning override for the per-folder backfill page (default 200). */
	backfillPageLimit?: number;
	now(): number;
};

export type MailSyncResult = {
	accountRef: string;
	folders: number;
	created: number;
	updated: number;
	startedAt: string;
	finishedAt: string;
};

export type SendResult = {
	emailId: string;
	/** True when an existing Sent email matched the submissionId (no send). */
	deduped: boolean;
};

export class MailSyncEngine {
	constructor(private readonly ports: MailSyncPorts) {}

	async syncAccount(account: SyncAccount): Promise<MailSyncResult> {
		const startedAt = new Date(this.ports.now()).toISOString();
		const sinceMs = this.windowFloor(account.syncWindow);
		const messageCap =
			syncWindowDays(account.syncWindow) === null
				? SYNC_WINDOW_ALL_MAX_MESSAGES
				: Number.POSITIVE_INFINITY;

		const personIndex = this.ports.loadPersonIndex ? await this.ports.loadPersonIndex() : null;
		const resolvePerson = personIndex
			? (address: string): string | undefined => resolvePersonRef(personIndex, address)
			: undefined;

		const rawFolders = await this.ports.driver.listFolders();
		const folderIds = new Map<string, string>();
		for (const raw of rawFolders) {
			const props = projectFolder(account.id, raw);
			const existing = await this.ports.findFolderByPath(account.id, raw.path);
			if (existing) {
				await this.ports.updateEntity(existing, { unreadCount: props.unreadCount });
				folderIds.set(raw.path, existing);
			} else {
				const { id } = await this.ports.createEntity(MAIL_FOLDER_TYPE_URL, { ...props });
				folderIds.set(raw.path, id);
			}
		}

		let created = 0;
		let updated = 0;
		let budget = messageCap;
		for (const raw of rawFolders) {
			if (budget <= 0) break;
			const folderRef = folderIds.get(raw.path);
			if (!folderRef) continue;
			const limit = Math.min(DEFAULT_PAGE_LIMIT, budget);
			const { messages } = await this.ports.driver.fetch({
				folderPath: raw.path,
				...(sinceMs !== null ? { sinceMs } : {}),
				limit,
			});
			const page = await this.upsertPage(account.id, messages, folderRef, resolvePerson, budget);
			created += page.created;
			updated += page.updated;
			budget -= page.created + page.updated;
		}

		return {
			accountRef: account.id,
			folders: folderIds.size,
			created,
			updated,
			startedAt,
			finishedAt: new Date(this.ports.now()).toISOString(),
		};
	}

	/** Shared idempotent message upsert (Message-ID keyed). Server is
	 *  authoritative for existence + flags; vault-owned tags/body untouched.
	 *  A message reachable from multiple folders/labels (Gmail) accumulates
	 *  every folderRef — `folderRefs` is count {1,∞}. */
	private async upsertPage(
		accountRef: string,
		messages: readonly Parameters<typeof projectMessage>[1][],
		folderRef: string,
		resolvePerson: ((address: string) => string | undefined) | undefined,
		budget: number,
	): Promise<{ created: number; updated: number }> {
		let created = 0;
		let updated = 0;
		for (const message of messages) {
			if (created + updated >= budget) break;
			const existing = await this.ports.findEmailByMessageId(accountRef, message.messageId);
			if (existing) {
				const nextFlags = message.flags ?? existing.flags;
				const patch: Record<string, unknown> = { flags: nextFlags };
				if (!existing.folderRefs.includes(folderRef)) {
					patch.folderRefs = [...existing.folderRefs, folderRef];
				}
				await this.ports.updateEntity(existing.id, patch);
				updated += 1;
			} else {
				const def = projectMessage(
					accountRef,
					message,
					folderRef,
					resolvePerson ? { resolvePerson } : undefined,
				);
				await this.ports.createEntity(EMAIL_TYPE_URL, this.toProps(def));
				created += 1;
			}
		}
		return { created, updated };
	}

	/** One user-initiated "load older" pass (Mailbox-12): one bounded page per
	 *  not-yet-exhausted folder, walking OLDER via the driver's opaque
	 *  backfill cursor; the cursor persists on the folder entity so the next
	 *  press resumes where this one stopped. `sinceMs` is deliberately absent
	 *  — the user asked for history beyond the account window. */
	async backfillAccount(account: SyncAccount): Promise<MailBackfillResult> {
		const startedAt = new Date(this.ports.now()).toISOString();
		if (!this.ports.listAccountFolders) {
			throw new Error("backfillAccount: host provides no listAccountFolders port");
		}
		const personIndex = this.ports.loadPersonIndex ? await this.ports.loadPersonIndex() : null;
		const resolvePerson = personIndex
			? (address: string): string | undefined => resolvePersonRef(personIndex, address)
			: undefined;

		const folders = await this.ports.listAccountFolders(account.id);
		let created = 0;
		let updated = 0;
		let done = true;
		for (const folder of folders) {
			if (folder.backfillDone === true) continue;
			const { messages, nextCursor } = await this.ports.driver.fetch({
				folderPath: folder.path,
				walk: FetchWalk.Backfill,
				...(folder.backfillCursor !== undefined ? { cursor: folder.backfillCursor } : {}),
				limit: this.ports.backfillPageLimit ?? BACKFILL_PAGE_LIMIT,
			});
			const page = await this.upsertPage(
				account.id,
				messages,
				folder.id,
				resolvePerson,
				Number.POSITIVE_INFINITY,
			);
			created += page.created;
			updated += page.updated;
			if (nextCursor !== undefined) {
				await this.ports.updateEntity(folder.id, { backfillCursor: nextCursor });
				done = false;
			} else {
				await this.ports.updateEntity(folder.id, { backfillDone: true });
			}
		}

		return {
			accountRef: account.id,
			created,
			updated,
			done,
			startedAt,
			finishedAt: new Date(this.ports.now()).toISOString(),
		};
	}

	/** Idempotent submit. A duplicate `submissionId` returns the existing Sent
	 *  email without re-submitting (resend-after-crash is safe). */
	async send(account: SyncAccount, outbound: OutboundMessage): Promise<SendResult> {
		const existing = await this.ports.findEmailBySubmissionId(account.id, outbound.submissionId);
		if (existing) return { emailId: existing, deduped: true };

		const submitted = await this.ports.driver.submit(outbound);
		const rawFolders = await this.ports.driver.listFolders();
		const sentRaw = rawFolders.find((f) => projectFolder(account.id, f).role === FolderRole.Sent);
		const sentPath = sentRaw?.path ?? "Sent";
		let sentRef = await this.ports.findFolderByPath(account.id, sentPath);
		if (!sentRef) {
			const { id } = await this.ports.createEntity(MAIL_FOLDER_TYPE_URL, {
				accountRef: account.id,
				path: sentPath,
				role: FolderRole.Sent,
				unreadCount: 0,
			});
			sentRef = id;
		}

		const def = projectMessage(
			account.id,
			{
				messageId: submitted.messageId,
				from: outbound.from,
				...(outbound.to.length > 0 ? { to: outbound.to.join(", ") } : {}),
				...(outbound.cc && outbound.cc.length > 0 ? { cc: outbound.cc.join(", ") } : {}),
				...(outbound.subject !== undefined ? { subject: outbound.subject } : {}),
				...(outbound.bodyText !== undefined ? { bodyText: outbound.bodyText } : {}),
				...(outbound.bodyHtml !== undefined ? { bodyHtml: outbound.bodyHtml } : {}),
				...(outbound.inReplyTo !== undefined ? { inReplyTo: outbound.inReplyTo } : {}),
				...(outbound.references !== undefined ? { references: outbound.references } : {}),
				receivedAt: submitted.receivedAt,
				flags: [],
				folderPath: sentPath,
			},
			sentRef,
			{ submissionId: outbound.submissionId },
		);
		const { id } = await this.ports.createEntity(EMAIL_TYPE_URL, this.toProps(def));
		return { emailId: id, deduped: false };
	}

	private windowFloor(window: SyncWindow): number | null {
		const days = syncWindowDays(window);
		if (days === null) return null;
		return this.ports.now() - days * DAY_MS;
	}

	private toProps(def: EmailDef): Record<string, unknown> {
		return { ...def } as Record<string, unknown>;
	}
}
