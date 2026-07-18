/**
 * IMAP/SMTP driver flow tests — fake wire clients injected through
 * `ImapDriverIo` (the parse/mapping layer is fixture-tested in
 * `imap-projection.test.ts`; live-socket verification is the real-shell
 * residue). Covers: lazy connect, folder/special-use listing, the bounded
 * newest-first fetch, the UIDVALIDITY cursor reset, idempotent Message-ID
 * stamping on submit, the STARTTLS-mandatory SMTP config, header-injection
 * fail-close, and close() idempotence.
 */

import { FolderRole, MailFlag, MailProtocol } from "@brainstorm/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	type ImapClientLike,
	type ImapDriverInput,
	type SmtpTransportLike,
	makeImapSmtpDriver,
} from "./imap-driver";
import type { ParsedSourceLike } from "./imap-projection";

const INCOMING = { host: "imap.example.com", port: 993, tls: true };
const OUTGOING = { host: "smtp.example.com", port: 587, tls: false };

type FakeMessage = {
	uid: number;
	source: string;
	flags?: string[];
	internalDate?: Date;
};

function makeFakeImap(options?: {
	uidValidity?: bigint;
	folders?: { path: string; specialUse?: string }[];
	messages?: Record<string, FakeMessage[]>;
	unseen?: number;
}) {
	const messages = options?.messages ?? {};
	const calls = { connect: 0, logout: 0, searches: [] as Record<string, unknown>[] };
	const client: ImapClientLike = {
		connect: async () => {
			calls.connect += 1;
		},
		logout: async () => {
			calls.logout += 1;
		},
		list: async () => options?.folders ?? [{ path: "INBOX" }],
		status: async () => ({ unseen: options?.unseen ?? 0 }),
		getMailboxLock: async (path: string) => {
			client.mailbox = { uidValidity: options?.uidValidity ?? 1n };
			void path;
			return { release: () => {} };
		},
		search: async (query) => {
			calls.searches.push(query);
			const all = Object.values(messages).flat();
			if (typeof query.uid === "string") {
				const start = Number(String(query.uid).split(":")[0]);
				const matched = all.filter((m) => m.uid >= start).map((m) => m.uid);
				// RFC 3501 §6.4.8 — `n:*` always matches the newest message.
				const newest = all.reduce((max, m) => Math.max(max, m.uid), 0);
				if (newest > 0 && !matched.includes(newest)) matched.push(newest);
				return matched;
			}
			return all.map((m) => m.uid);
		},
		fetchOne: async (uid) => {
			const found = Object.values(messages)
				.flat()
				.find((m) => m.uid === uid);
			if (!found) return false;
			return {
				uid,
				source: new TextEncoder().encode(found.source),
				flags: new Set(found.flags ?? []),
				...(found.internalDate ? { internalDate: found.internalDate } : {}),
			};
		},
	};
	return { client, calls };
}

/** Parses the tiny test sources without pulling mailparser into this suite —
 *  the real-parser path is covered by the projection fixtures. */
async function fakeParse(source: Uint8Array): Promise<ParsedSourceLike> {
	const text = new TextDecoder().decode(source);
	const id = text.match(/^Message-ID: (.*)$/m)?.[1];
	return {
		...(id !== undefined ? { messageId: id } : {}),
		from: { text: "dana@example.com" },
		subject: "fixture",
		text,
	};
}

function makeDriver(overrides?: {
	imap?: ImapClientLike;
	smtp?: SmtpTransportLike;
	input?: Partial<ImapDriverInput>;
	smtpConfigSpy?: (config: Record<string, unknown>) => void;
}) {
	const fake = makeFakeImap();
	const imap = overrides?.imap ?? fake.client;
	const sendMail = vi.fn().mockResolvedValue({});
	const close = vi.fn();
	const smtp: SmtpTransportLike = overrides?.smtp ?? { sendMail, close };
	const driver = makeImapSmtpDriver({
		incoming: INCOMING,
		outgoing: OUTGOING,
		credentials: { secret: "app-password", username: "me@example.com" },
		io: {
			makeImapClient: () => imap,
			makeSmtpTransport: (config) => {
				overrides?.smtpConfigSpy?.(config as unknown as Record<string, unknown>);
				return smtp;
			},
			parseSource: fakeParse,
			now: () => 1_700_000_000_000,
		},
		...overrides?.input,
	});
	return { driver, sendMail, close };
}

const msg = (uid: number, id: string, flags?: string[]): FakeMessage => ({
	uid,
	source: `Message-ID: <${id}@example.com>\r\n\r\nbody-${id}`,
	...(flags ? { flags } : {}),
});

describe("makeImapSmtpDriver", () => {
	it("survives a post-connect socket 'error' event and reconnects on the next call (F-434)", async () => {
		const fake = makeFakeImap();
		let errorHandler: ((error: Error) => void) | undefined;
		const client: ImapClientLike = {
			...fake.client,
			on: (_event, handler) => {
				errorHandler = handler;
			},
		};
		const { driver } = makeDriver({ imap: client });
		await driver.listFolders();
		expect(errorHandler).toBeDefined();
		expect(fake.calls.connect).toBe(1);
		// The idle socket times out — imapflow emits 'error' with no command
		// in flight (the uncaughtException that killed the worker). Must not
		// throw; must drop the cached connection so the next call redials.
		errorHandler?.(new Error("Socket timeout"));
		await driver.listFolders();
		expect(fake.calls.connect).toBe(2);
	});

	it("requires a username", () => {
		expect(() =>
			makeImapSmtpDriver({
				incoming: INCOMING,
				outgoing: OUTGOING,
				credentials: { secret: "pw" },
			}),
		).toThrowError(/username/);
	});

	it("lists folders with special-use roles and the inbox unread count", async () => {
		const fake = makeFakeImap({
			folders: [
				{ path: "INBOX" },
				{ path: "Sent Items", specialUse: "\\Sent" },
				{ path: "Junk", specialUse: "\\Junk" },
				{ path: "Projects/Atlas" },
			],
			unseen: 7,
		});
		const { driver } = makeDriver({ imap: fake.client });
		const folders = await driver.listFolders();
		expect(driver.protocol).toBe(MailProtocol.Imap);
		expect(folders).toEqual([
			{ path: "INBOX", unreadCount: 7 },
			{ path: "Sent Items", role: FolderRole.Sent },
			{ path: "Junk", role: FolderRole.Spam },
			{ path: "Projects/Atlas" },
		]);
		// Lazy connect happened exactly once.
		expect(fake.calls.connect).toBe(1);
		await driver.listFolders();
		expect(fake.calls.connect).toBe(1);
	});

	it("fetches newest-first bounded by limit and returns a resume cursor", async () => {
		const fake = makeFakeImap({
			uidValidity: 77n,
			messages: { INBOX: [msg(1, "a"), msg(2, "b", ["\\Seen"]), msg(3, "c")] },
		});
		const { driver } = makeDriver({ imap: fake.client });
		const result = await driver.fetch({ folderPath: "INBOX", sinceMs: 0, limit: 2 });
		expect(result.messages.map((m) => m.messageId)).toEqual(["<c@example.com>", "<b@example.com>"]);
		expect(result.messages[1]?.flags).toEqual([]);
		expect(result.messages[0]?.flags).toEqual([MailFlag.Unread]);
		expect(result.nextCursor).toBe("77:3");
	});

	it("resumes incrementally from a matching cursor (uids after lastUid only)", async () => {
		const fake = makeFakeImap({
			uidValidity: 77n,
			messages: { INBOX: [msg(2, "b"), msg(3, "c"), msg(5, "e")] },
		});
		const { driver } = makeDriver({ imap: fake.client });
		const result = await driver.fetch({ folderPath: "INBOX", cursor: "77:3", limit: 50 });
		expect(result.messages.map((m) => m.messageId)).toEqual(["<e@example.com>"]);
		expect(result.nextCursor).toBe("77:5");
		expect(fake.calls.searches[0]).toEqual({ uid: "4:*" });
	});

	it("discards the cursor on a UIDVALIDITY change and re-walks the window", async () => {
		const fake = makeFakeImap({
			uidValidity: 99n,
			messages: { INBOX: [msg(2, "b")] },
		});
		const { driver } = makeDriver({ imap: fake.client });
		const result = await driver.fetch({
			folderPath: "INBOX",
			cursor: "77:3",
			sinceMs: 1_600_000_000_000,
			limit: 50,
		});
		expect(result.messages.map((m) => m.messageId)).toEqual(["<b@example.com>"]);
		expect(result.nextCursor).toBe("99:2");
		expect(fake.calls.searches[0]).toEqual({ since: new Date(1_600_000_000_000) });
	});

	it("submits over SMTP with the submissionId-derived Message-ID (idempotency key)", async () => {
		const { driver, sendMail } = makeDriver();
		const result = await driver.submit({
			from: "Razor <me@example.com>",
			to: ["dana@example.com"],
			subject: "hi",
			bodyText: "hello",
			submissionId: "sub-123",
			inReplyTo: "<plain-1@example.com>",
			references: ["<plain-1@example.com>"],
		});
		expect(result.messageId).toBe("<sub-123@brainstorm.local>");
		expect(result.receivedAt).toBe(1_700_000_000_000);
		const sent = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(sent.messageId).toBe("<sub-123@brainstorm.local>");
		expect(sent.to).toEqual(["dana@example.com"]);
		expect(sent.inReplyTo).toBe("<plain-1@example.com>");
		expect(sent.text).toBe("hello");
	});

	it("forces STARTTLS on a cleartext SMTP port — plain cleartext is never an option", async () => {
		const configs: Record<string, unknown>[] = [];
		const { driver } = makeDriver({ smtpConfigSpy: (c) => configs.push(c) });
		await driver.submit({
			from: "me@example.com",
			to: ["dana@example.com"],
			submissionId: "s1",
			bodyText: "x",
		});
		expect(configs[0]).toMatchObject({ secure: false, requireTLS: true, port: 587 });
	});

	it("fails closed on header injection", async () => {
		const { driver, sendMail } = makeDriver();
		await expect(
			driver.submit({
				from: "me@example.com",
				to: ["dana@example.com\r\nBcc: evil@example.com"],
				submissionId: "s2",
			}),
		).rejects.toMatchObject({ name: "Invalid" });
		expect(sendMail).not.toHaveBeenCalled();
	});

	it("maps an authentication failure to Denied", async () => {
		const failing: ImapClientLike = {
			...makeFakeImap().client,
			connect: async () => {
				const err = new Error("LOGIN failed") as Error & { authenticationFailed?: boolean };
				err.authenticationFailed = true;
				throw err;
			},
		};
		const { driver } = makeDriver({ imap: failing });
		await expect(driver.listFolders()).rejects.toMatchObject({ name: "Denied" });
	});

	it("close() logs out, closes SMTP, and is idempotent", async () => {
		const fake = makeFakeImap();
		const { driver, close } = makeDriver({ imap: fake.client });
		await driver.listFolders();
		await driver.submit({
			from: "me@example.com",
			to: ["dana@example.com"],
			submissionId: "s3",
		});
		await driver.close();
		await driver.close();
		expect(fake.calls.logout).toBe(1);
		expect(close).toHaveBeenCalledTimes(1);
	});
});
