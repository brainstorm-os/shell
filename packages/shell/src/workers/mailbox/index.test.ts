import { FolderRole, MailFlag } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope, EnvelopeReplyOk } from "../../ipc/envelope";
import { FakeMailDriver, type FakeServerState } from "../../main/mailbox/fake-mail-driver";
import { __resetMailboxWorker, __setMailDriverFactory, handleMailboxEnvelope } from "./index";

function envelope(method: string, args: unknown[], app = "_shell"): Envelope {
	return { v: 1, msg: `m-${method}`, app, service: "mailbox", method, args, caps: [] };
}

function state(): FakeServerState {
	return {
		folders: [{ path: "INBOX", role: FolderRole.Inbox, unreadCount: 1 }],
		messages: {
			INBOX: [
				{
					messageId: "<a@x>",
					from: "dana@x.com",
					receivedAt: 1000,
					flags: [MailFlag.Unread],
					folderPath: "INBOX",
				},
			],
		},
	};
}

afterEach(async () => {
	await __resetMailboxWorker();
});

describe("mailbox worker envelope handling", () => {
	it("answers ping", async () => {
		const reply = await handleMailboxEnvelope(envelope("ping", ["hi"]));
		expect(reply.ok).toBe(true);
		expect((reply as EnvelopeReplyOk).value).toEqual({ pong: "hi" });
	});

	it("rejects renderer-originated envelopes (not the _shell sentinel)", async () => {
		const reply = await handleMailboxEnvelope(envelope("connect", [{}], "io.brainstorm.mailbox"));
		expect(reply.ok).toBe(false);
		if (!reply.ok) expect(reply.error.kind).toBe("Invalid");
	});

	it("connects via the injected factory, then lists folders and fetches", async () => {
		__setMailDriverFactory(() => new FakeMailDriver(state()));
		const connect = await handleMailboxEnvelope(
			envelope("connect", [{ accountId: "acct-1", protocol: "imap", credentials: { secret: "x" } }]),
		);
		expect(connect.ok).toBe(true);

		const folders = (await handleMailboxEnvelope(
			envelope("listFolders", [{ accountId: "acct-1" }]),
		)) as EnvelopeReplyOk;
		expect(folders.ok).toBe(true);
		expect((folders.value as { folders: unknown[] }).folders).toHaveLength(1);

		const fetched = (await handleMailboxEnvelope(
			envelope("fetch", [{ accountId: "acct-1", spec: { folderPath: "INBOX", limit: 10 } }]),
		)) as EnvelopeReplyOk;
		expect((fetched.value as { messages: unknown[] }).messages).toHaveLength(1);
	});

	it("fails fetch for an unconnected account", async () => {
		const reply = await handleMailboxEnvelope(
			envelope("fetch", [{ accountId: "nope", spec: { folderPath: "INBOX", limit: 1 } }]),
		);
		expect(reply.ok).toBe(false);
		if (!reply.ok) expect(reply.error.kind).toBe("Unavailable");
	});

	it("the default factory rejects an imap connect without host config", async () => {
		const reply = await handleMailboxEnvelope(
			envelope("connect", [{ accountId: "acct-1", protocol: "imap", credentials: { secret: "x" } }]),
		);
		expect(reply.ok).toBe(false);
		if (!reply.ok) expect(reply.error.kind).toBe("Invalid");
	});

	it("the default factory reports JMAP as unimplemented residue", async () => {
		const reply = await handleMailboxEnvelope(
			envelope("connect", [{ accountId: "acct-1", protocol: "jmap", credentials: { secret: "x" } }]),
		);
		expect(reply.ok).toBe(false);
		if (!reply.ok) expect(reply.error.kind).toBe("Unavailable");
	});
});
