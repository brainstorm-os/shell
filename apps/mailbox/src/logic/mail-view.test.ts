import { MailFlag } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import { EMAIL_TYPE_URL, FolderRole, MAIL_ACCOUNT_TYPE_URL } from "../types/mail-view";
import { demoEntities } from "./demo";
import {
	accountsFromEntities,
	foldersFromEntities,
	groupThreads,
	matchesQuery,
	messagesForSelection,
	messagesFromEntities,
	senderLabel,
	toMessageView,
	unifiedUnreadCount,
} from "./mail-view";

const entities = demoEntities();

describe("projection from entities", () => {
	it("projects accounts, folders, and messages", () => {
		expect(accountsFromEntities(entities)).toHaveLength(1);
		expect(foldersFromEntities(entities).map((f) => f.role)).toEqual([
			FolderRole.Inbox,
			FolderRole.Sent,
			FolderRole.Archive,
		]);
		expect(messagesFromEntities(entities).length).toBeGreaterThan(0);
	});

	it("hides disconnected accounts (enabled: false) but keeps enabled and legacy rows", () => {
		const account = entities.find((e) => e.type === MAIL_ACCOUNT_TYPE_URL);
		expect(account).toBeDefined();
		if (!account) return;
		const disabled = { ...account, properties: { ...account.properties, enabled: false } };
		expect(accountsFromEntities([disabled])).toHaveLength(0);
		// Rows created before the flag existed have no `enabled` — still shown.
		const { enabled: _dropped, ...legacyProps } = account.properties;
		const legacy = { ...account, properties: legacyProps };
		expect(accountsFromEntities([legacy])).toHaveLength(1);
	});

	it("projects the folder backfill state (Mailbox-12)", () => {
		const projected = foldersFromEntities([
			{
				id: "f1",
				type: "brainstorm/MailFolder/v1",
				properties: { accountRef: "a", path: "INBOX", role: "inbox", backfillDone: true },
			},
			{
				id: "f2",
				type: "brainstorm/MailFolder/v1",
				properties: { accountRef: "a", path: "Archive", role: "archive" },
			},
		]);
		expect(projected.map((f) => f.backfillDone)).toEqual([true, false]);
	});

	it("sorts messages newest-first", () => {
		const times = messagesFromEntities(entities).map((m) => m.receivedAt);
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	it("derives unread/flagged booleans from flags", () => {
		const m = toMessageView({
			id: "x",
			type: EMAIL_TYPE_URL,
			properties: {
				accountRef: "a",
				folderRefs: ["f"],
				messageId: "<m@x>",
				from: [{ address: "a@b.com" }],
				receivedAt: 1,
				flags: [MailFlag.Unread, MailFlag.Flagged],
			},
		});
		expect(m.unread).toBe(true);
		expect(m.flagged).toBe(true);
	});

	it("tolerates a malformed property bag without throwing", () => {
		const m = toMessageView({
			id: "x",
			type: EMAIL_TYPE_URL,
			properties: { from: "not-an-array", receivedAt: "nope", flags: ["bogus", MailFlag.Unread] },
		});
		expect(m.from).toEqual([]);
		expect(m.receivedAt).toBe(0);
		expect(m.flags).toEqual([MailFlag.Unread]);
	});
});

describe("folder selection", () => {
	const folders = foldersFromEntities(entities);
	const messages = messagesFromEntities(entities);

	it("unified inbox shows inbox-folder messages only", () => {
		const inbox = folders.find((f) => f.role === FolderRole.Inbox);
		expect(inbox).toBeDefined();
		const inboxId = inbox?.id ?? "";
		const result = messagesForSelection(messages, folders, { kind: "unified-inbox" });
		expect(result.length).toBeGreaterThan(0);
		expect(result.every((m) => m.folderRefs.includes(inboxId))).toBe(true);
	});

	it("flagged shows only flagged messages", () => {
		const result = messagesForSelection(messages, folders, { kind: "flagged" });
		expect(result.every((m) => m.flagged)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
	});

	it("a specific folder shows only its messages", () => {
		const sent = folders.find((f) => f.role === FolderRole.Sent);
		expect(sent).toBeDefined();
		const sentId = sent?.id ?? "";
		const result = messagesForSelection(messages, folders, { kind: "folder", folderId: sentId });
		expect(result.length).toBeGreaterThan(0);
		expect(result.every((m) => m.folderRefs.includes(sentId))).toBe(true);
	});

	it("counts unified-inbox unread", () => {
		expect(unifiedUnreadCount(messages, folders)).toBe(
			messagesForSelection(messages, folders, { kind: "unified-inbox" }).filter((m) => m.unread)
				.length,
		);
	});
});

describe("thread grouping", () => {
	const messages = messagesFromEntities(entities);

	function mk(
		id: string,
		threadKey: string,
		receivedAt: number,
		extra: Record<string, unknown> = {},
	) {
		return toMessageView({
			id,
			type: EMAIL_TYPE_URL,
			properties: {
				threadKey,
				messageId: `<${id}@x>`,
				from: [{ address: "a@b.com" }],
				receivedAt,
				flags: [],
				...extra,
			},
		});
	}

	it("collapses messages sharing a threadKey into one thread", () => {
		// The demo set has a 3-message Atlas thread + two singletons.
		const threads = groupThreads(messages);
		const atlas = threads.find((t) => t.threadKey === "atlas-kickoff@example.com");
		expect(atlas).toBeDefined();
		expect(atlas?.count).toBe(3);
		const totalMessages = threads.reduce((n, t) => n + t.count, 0);
		expect(totalMessages).toBe(messages.length);
	});

	it("orders threads by their latest message, newest thread first", () => {
		const threads = groupThreads([mk("a1", "A", 100), mk("a2", "A", 400), mk("b1", "B", 300)]);
		expect(threads.map((t) => t.threadKey)).toEqual(["A", "B"]);
		expect(threads[0]?.latest.id).toBe("a2");
	});

	it("orders messages within a thread oldest-first for top-to-bottom reading", () => {
		const threads = groupThreads([mk("a2", "A", 400), mk("a1", "A", 100), mk("a3", "A", 250)]);
		expect(threads[0]?.messages.map((m) => m.id)).toEqual(["a1", "a3", "a2"]);
	});

	it("rolls up unread / flagged / attachment state across the thread", () => {
		const threads = groupThreads([
			mk("a1", "A", 100, { flags: [MailFlag.Unread] }),
			mk("a2", "A", 200, { flags: [MailFlag.Flagged], attachments: ["file-1"] }),
		]);
		const a = threads[0];
		expect(a?.unreadCount).toBe(1);
		expect(a?.flagged).toBe(true);
		expect(a?.hasAttachments).toBe(true);
	});

	it("anchors the subject on the earliest message in the thread", () => {
		const threads = groupThreads([
			mk("a2", "A", 200, { subject: "Re: Hello" }),
			mk("a1", "A", 100, { subject: "Hello" }),
		]);
		expect(threads[0]?.subject).toBe("Hello");
	});

	it("treats a keyless message as its own singleton thread (never merged)", () => {
		// toMessageView falls back threadKey → messageId → id, so two keyless
		// messages must not collapse together.
		const threads = groupThreads([
			toMessageView({ id: "x", type: EMAIL_TYPE_URL, properties: { receivedAt: 1 } }),
			toMessageView({ id: "y", type: EMAIL_TYPE_URL, properties: { receivedAt: 2 } }),
		]);
		expect(threads).toHaveLength(2);
		expect(threads.every((t) => t.count === 1)).toBe(true);
	});
});

describe("search + labels", () => {
	const messages = messagesFromEntities(entities);

	it("matches across subject, sender, and body text", () => {
		expect(messages.some((m) => matchesQuery(m, "Atlas"))).toBe(true);
		expect(messages.filter((m) => matchesQuery(m, "Atlas")).length).toBeGreaterThan(1);
		expect(messages.every((m) => matchesQuery(m, ""))).toBe(true);
		expect(messages.some((m) => matchesQuery(m, "zzz-no-match"))).toBe(false);
	});

	it("senderLabel prefers display name then address", () => {
		const m = toMessageView({
			id: "x",
			type: EMAIL_TYPE_URL,
			properties: { from: [{ address: "a@b.com", name: "Dana" }], receivedAt: 1, flags: [] },
		});
		expect(senderLabel(m)).toBe("Dana");
	});
});
