import {
	EMAIL_TYPE_URL,
	FolderRole,
	MAIL_FOLDER_TYPE_URL,
	MailFlag,
	SyncWindow,
} from "@brainstorm-os/sdk-types";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeMailDriver, type FakeServerState } from "./fake-mail-driver";
import type { ExistingEmail, MailSyncPorts } from "./mail-sync-engine";
import { MailSyncEngine } from "./mail-sync-engine";

type Row = { id: string; type: string; properties: Record<string, unknown> };

const FIXED_NOW = 1_717_100_000_000;

function makePorts(state: FakeServerState): {
	ports: MailSyncPorts;
	rows: Map<string, Row>;
	emails: () => Row[];
	folders: () => Row[];
} {
	const rows = new Map<string, Row>();
	let seq = 0;
	const accountMatches = (row: Row, accountRef: string) => row.properties.accountRef === accountRef;

	const ports: MailSyncPorts = {
		driver: new FakeMailDriver(state, FIXED_NOW),
		async findFolderByPath(accountRef, path) {
			for (const row of rows.values()) {
				if (
					row.type === MAIL_FOLDER_TYPE_URL &&
					accountMatches(row, accountRef) &&
					row.properties.path === path
				) {
					return row.id;
				}
			}
			return null;
		},
		async findEmailByMessageId(accountRef, messageId): Promise<ExistingEmail | null> {
			for (const row of rows.values()) {
				if (
					row.type === EMAIL_TYPE_URL &&
					accountMatches(row, accountRef) &&
					row.properties.messageId === messageId
				) {
					return {
						id: row.id,
						flags: (row.properties.flags as MailFlag[]) ?? [],
						folderRefs: (row.properties.folderRefs as string[]) ?? [],
					};
				}
			}
			return null;
		},
		async findEmailBySubmissionId(accountRef, submissionId) {
			for (const row of rows.values()) {
				if (
					row.type === EMAIL_TYPE_URL &&
					accountMatches(row, accountRef) &&
					row.properties.submissionId === submissionId
				) {
					return row.id;
				}
			}
			return null;
		},
		async createEntity(type, properties) {
			seq += 1;
			const id = `ent-${seq}`;
			rows.set(id, { id, type, properties: { ...properties } });
			return { id };
		},
		async updateEntity(id, patch) {
			const row = rows.get(id);
			if (row) row.properties = { ...row.properties, ...patch };
		},
		async listAccountFolders(accountRef) {
			return [...rows.values()]
				.filter((r) => r.type === MAIL_FOLDER_TYPE_URL && accountMatches(r, accountRef))
				.map((r) => ({
					id: r.id,
					path: String(r.properties.path),
					...(typeof r.properties.backfillCursor === "string"
						? { backfillCursor: r.properties.backfillCursor }
						: {}),
					...(r.properties.backfillDone === true ? { backfillDone: true } : {}),
				}));
		},
		backfillPageLimit: 1,
		now: () => FIXED_NOW,
	};

	return {
		ports,
		rows,
		emails: () => [...rows.values()].filter((r) => r.type === EMAIL_TYPE_URL),
		folders: () => [...rows.values()].filter((r) => r.type === MAIL_FOLDER_TYPE_URL),
	};
}

function serverState(): FakeServerState {
	return {
		folders: [
			{ path: "INBOX", role: FolderRole.Inbox, unreadCount: 1 },
			{ path: "[Gmail]/Sent Mail", role: FolderRole.Sent, unreadCount: 0 },
		],
		messages: {
			INBOX: [
				{
					messageId: "<a@x>",
					from: "Dana <dana@x.com>",
					to: "you@x.com",
					subject: "First",
					receivedAt: FIXED_NOW - 1000,
					flags: [MailFlag.Unread],
					folderPath: "INBOX",
				},
				{
					messageId: "<b@x>",
					from: "Sam <sam@x.com>",
					to: "you@x.com",
					subject: "Second",
					receivedAt: FIXED_NOW - 500,
					flags: [],
					folderPath: "INBOX",
				},
			],
		},
	};
}

const account = { id: "acct-1", syncWindow: SyncWindow.Days90 };

describe("MailSyncEngine.syncAccount", () => {
	it("projects folders and messages on first sync", async () => {
		const { ports, emails, folders } = makePorts(serverState());
		const result = await new MailSyncEngine(ports).syncAccount(account);
		expect(result.folders).toBe(2);
		expect(result.created).toBe(2);
		expect(result.updated).toBe(0);
		expect(emails()).toHaveLength(2);
		expect(folders()).toHaveLength(2);
	});

	it("is idempotent on Message-ID — a re-sync creates nothing new", async () => {
		const { ports, emails } = makePorts(serverState());
		const engine = new MailSyncEngine(ports);
		await engine.syncAccount(account);
		const second = await engine.syncAccount(account);
		expect(second.created).toBe(0);
		expect(second.updated).toBe(2);
		expect(emails()).toHaveLength(2);
	});

	it("updates only flags on re-sync (server authoritative for flags)", async () => {
		const state = serverState();
		const { ports, emails } = makePorts(state);
		const engine = new MailSyncEngine(ports);
		await engine.syncAccount(account);
		// Server marks <a@x> read; re-sync should flip the stored flags.
		const inbox = state.messages.INBOX;
		if (inbox?.[0]) inbox[0].flags = [];
		await engine.syncAccount(account);
		const a = emails().find((e) => e.properties.messageId === "<a@x>");
		expect(a?.properties.flags).toEqual([]);
	});

	it("resolves participant addresses to Person/v1 refs when a person index is supplied", async () => {
		const { ports, emails } = makePorts(serverState());
		const withIndex: MailSyncPorts = {
			...ports,
			loadPersonIndex: async () => new Map([["dana@x.com", "person-dana"]]),
		};
		await new MailSyncEngine(withIndex).syncAccount(account);
		const a = emails().find((e) => e.properties.messageId === "<a@x>");
		const from = a?.properties.from as Array<{ address: string; personRef?: string }>;
		expect(from[0]?.personRef).toBe("person-dana");
		// An unmatched sender is left without a personRef (no auto-create).
		const b = emails().find((e) => e.properties.messageId === "<b@x>");
		const fromB = b?.properties.from as Array<{ address: string; personRef?: string }>;
		expect(fromB[0]?.personRef).toBeUndefined();
	});

	it("accumulates folderRefs for a message reachable from multiple folders (Gmail labels)", async () => {
		const state = serverState();
		// Same Message-ID <a@x> also appears under a label folder.
		state.folders.push({ path: "Label/Atlas", role: FolderRole.Custom, unreadCount: 0 });
		state.messages["Label/Atlas"] = [
			{
				messageId: "<a@x>",
				from: "Dana <dana@x.com>",
				receivedAt: FIXED_NOW - 1000,
				flags: [MailFlag.Unread],
				folderPath: "Label/Atlas",
			},
		];
		const { ports, emails, folders } = makePorts(state);
		await new MailSyncEngine(ports).syncAccount(account);
		const a = emails().find((e) => e.properties.messageId === "<a@x>");
		const refs = a?.properties.folderRefs as string[];
		const inboxId = folders().find((f) => f.properties.path === "INBOX")?.id;
		const labelId = folders().find((f) => f.properties.path === "Label/Atlas")?.id;
		expect(refs).toContain(inboxId);
		expect(refs).toContain(labelId);
		expect(refs).toHaveLength(2);
	});

	it("bounds the backfill by the sync window", async () => {
		const state = serverState();
		// An ancient message outside a 30-day window.
		state.messages.INBOX?.push({
			messageId: "<old@x>",
			from: "old@x.com",
			receivedAt: FIXED_NOW - 60 * 24 * 60 * 60 * 1000,
			flags: [],
			folderPath: "INBOX",
		});
		const { ports, emails } = makePorts(state);
		await new MailSyncEngine(ports).syncAccount({ id: "acct-1", syncWindow: SyncWindow.Days30 });
		expect(emails().some((e) => e.properties.messageId === "<old@x>")).toBe(false);
	});
});

describe("MailSyncEngine.backfillAccount (Mailbox-12)", () => {
	it("walks older pages per press, persists the cursor, and flags exhaustion", async () => {
		const { ports, emails, folders } = makePorts(serverState());
		const engine = new MailSyncEngine(ports);
		await engine.syncAccount(account); // folders + both messages exist

		// Page 1 (limit 1): newest again — dedupes to updated, cursor persists.
		const first = await engine.backfillAccount(account);
		expect(first.created).toBe(0);
		expect(first.updated).toBe(1);
		expect(first.done).toBe(false);
		const inbox = folders().find((f) => f.properties.path === "INBOX");
		expect(inbox?.properties.backfillCursor).toBe("1");
		expect(inbox?.properties.backfillDone).toBeUndefined();

		// Page 2: the older message — walk exhausts, done persisted.
		const second = await engine.backfillAccount(account);
		expect(second.done).toBe(true);
		expect(folders().every((f) => f.properties.backfillDone === true)).toBe(true);
		expect(emails().length).toBe(2);

		// Page 3: nothing left — every folder skipped, still done.
		const third = await engine.backfillAccount(account);
		expect(third.created + third.updated).toBe(0);
		expect(third.done).toBe(true);
	});

	it("creates genuinely older mail the windowed sync never fetched", async () => {
		const state = serverState();
		state.messages.INBOX?.push({
			messageId: "<ancient@x>",
			from: "Old <old@x.com>",
			to: "you@x.com",
			subject: "Ancient",
			receivedAt: FIXED_NOW - 365 * 24 * 60 * 60 * 1000,
			flags: [],
			folderPath: "INBOX",
		});
		const { ports, emails } = makePorts(state);
		const engine = new MailSyncEngine(ports);
		await engine.syncAccount({ id: account.id, syncWindow: SyncWindow.Days30 });
		expect(emails().some((e) => e.properties.messageId === "<ancient@x>")).toBe(false);

		let result = await engine.backfillAccount(account);
		while (!result.done) result = await engine.backfillAccount(account);
		expect(emails().some((e) => e.properties.messageId === "<ancient@x>")).toBe(true);
	});
});

describe("MailSyncEngine.send", () => {
	it("submits, projects a Sent email, and stamps the submissionId", async () => {
		const { ports, emails } = makePorts(serverState());
		const result = await new MailSyncEngine(ports).send(account, {
			from: "you@x.com",
			to: ["dana@x.com"],
			subject: "Re: First",
			bodyText: "On it.",
			submissionId: "sub-1",
		});
		expect(result.deduped).toBe(false);
		const sent = emails().find((e) => e.properties.submissionId === "sub-1");
		expect(sent).toBeDefined();
		expect(sent?.properties.subject).toBe("Re: First");
	});

	it("is idempotent on submissionId — a resend never double-sends", async () => {
		const { ports, emails } = makePorts(serverState());
		const engine = new MailSyncEngine(ports);
		const first = await engine.send(account, {
			from: "you@x.com",
			to: ["dana@x.com"],
			submissionId: "sub-1",
		});
		const again = await engine.send(account, {
			from: "you@x.com",
			to: ["dana@x.com"],
			submissionId: "sub-1",
		});
		expect(again.deduped).toBe(true);
		expect(again.emailId).toBe(first.emailId);
		expect(emails().filter((e) => e.properties.submissionId === "sub-1")).toHaveLength(1);
	});
});
