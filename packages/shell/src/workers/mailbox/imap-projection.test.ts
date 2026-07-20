/**
 * Fixture-based tests for the pure IMAP projection layer: real RFC 822
 * sources parsed by the real `mailparser` (the library the driver injects by
 * default), then mapped through `rawMessageFromParsed` — so the fixtures
 * exercise the exact parse path production takes. Plus the cursor state
 * machine and the flags / special-use mappings.
 */

import { FolderRole, MailFlag } from "@brainstorm/sdk-types";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import {
	type ParsedSourceLike,
	folderRoleFromSpecialUse,
	formatImapCursor,
	imapFlagsToMailFlags,
	parseImapCursor,
	rawMessageFromParsed,
	selectNewestUids,
} from "./imap-projection";

const PLAIN_EML = [
	"Message-ID: <plain-1@example.com>",
	"Date: Mon, 02 Mar 2026 10:00:00 +0000",
	'From: "Dana Lee" <dana@example.com>',
	"To: me@example.com, Bob <bob@example.org>",
	"Cc: carol@example.net",
	"Subject: Quarterly numbers",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Numbers attached next week.",
	"-- Dana",
].join("\r\n");

const REPLY_HTML_EML = [
	"Message-ID: <reply-2@example.com>",
	"In-Reply-To: <plain-1@example.com>",
	"References: <root-0@example.com> <plain-1@example.com>",
	"Date: Tue, 03 Mar 2026 09:30:00 +0000",
	"From: bob@example.org",
	"To: dana@example.com",
	"Subject: =?UTF-8?B?UmU6IFF1YXJ0ZXJseSBudW1iZXJz?=",
	'Content-Type: multipart/alternative; boundary="b1"',
	"MIME-Version: 1.0",
	"",
	"--b1",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Looks good!",
	"--b1",
	"Content-Type: text/html; charset=utf-8",
	"",
	"<p>Looks <b>good</b>!</p><script>alert(1)</script>",
	"--b1--",
].join("\r\n");

const ATTACHMENT_EML = [
	"Message-ID: <att-3@example.com>",
	"Date: Wed, 04 Mar 2026 12:00:00 +0000",
	"From: dana@example.com",
	"To: me@example.com",
	"Subject: The deck",
	'Content-Type: multipart/mixed; boundary="m1"',
	"MIME-Version: 1.0",
	"",
	"--m1",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Deck attached.",
	"--m1",
	"Content-Type: application/pdf",
	'Content-Disposition: attachment; filename="deck.pdf"',
	"Content-Transfer-Encoding: base64",
	"",
	"JVBERi0xLjQ=",
	"--m1--",
].join("\r\n");

const meta = {
	folderPath: "INBOX",
	flags: [MailFlag.Unread],
	fallbackMessageId: "<imap-1-99@brainstorm.local>",
	receivedAtFallback: 1_700_000_000_000,
	uid: 99,
	uidValidity: "1",
};

async function parse(eml: string): Promise<ParsedSourceLike> {
	return (await simpleParser(Buffer.from(eml, "utf8"))) as unknown as ParsedSourceLike;
}

describe("rawMessageFromParsed (real mailparser fixtures)", () => {
	it("projects a plain-text message: headers, addresses, body, date", async () => {
		const raw = rawMessageFromParsed(await parse(PLAIN_EML), meta);
		expect(raw.messageId).toBe("<plain-1@example.com>");
		expect(raw.from).toContain("dana@example.com");
		expect(raw.from).toContain("Dana Lee");
		expect(raw.to).toContain("me@example.com");
		expect(raw.to).toContain("bob@example.org");
		expect(raw.cc).toContain("carol@example.net");
		expect(raw.subject).toBe("Quarterly numbers");
		expect(raw.receivedAt).toBe(Date.UTC(2026, 2, 2, 10, 0, 0));
		expect(raw.bodyText).toContain("Numbers attached next week.");
		expect(raw.bodyHtml).toBeUndefined();
		expect(raw.flags).toEqual([MailFlag.Unread]);
		expect(raw.folderPath).toBe("INBOX");
	});

	it("projects a multipart reply: threading headers, encoded subject, html body", async () => {
		const raw = rawMessageFromParsed(await parse(REPLY_HTML_EML), meta);
		expect(raw.inReplyTo).toBe("<plain-1@example.com>");
		expect(raw.references).toEqual(["<root-0@example.com>", "<plain-1@example.com>"]);
		expect(raw.subject).toBe("Re: Quarterly numbers");
		expect(raw.bodyText).toContain("Looks good!");
		// Unsanitised at this layer by contract — the shared mail-projection
		// sanitises downstream; the driver must hand HTML through raw.
		expect(raw.bodyHtml).toContain("<b>good</b>");
	});

	it("surfaces attachment metadata addressed by uid and keeps the body part", async () => {
		const raw = rawMessageFromParsed(await parse(ATTACHMENT_EML), meta);
		expect(raw.attachmentParts).toEqual([
			expect.objectContaining({ filename: "deck.pdf", partRef: "1:99:0" }),
		]);
		expect(raw.bodyText).toContain("Deck attached.");
	});

	it("falls back to the synthetic Message-ID and INTERNALDATE when headers are missing", async () => {
		const eml = ["From: x@example.com", "", "no id, no date"].join("\r\n");
		const raw = rawMessageFromParsed(await parse(eml), meta);
		expect(raw.messageId).toBe(meta.fallbackMessageId);
		expect(raw.receivedAt).toBe(meta.receivedAtFallback);
	});
});

describe("imapFlagsToMailFlags", () => {
	it("flips \\Seen polarity to unread and maps the rest", () => {
		expect(imapFlagsToMailFlags([])).toEqual([MailFlag.Unread]);
		expect(imapFlagsToMailFlags(["\\Seen"])).toEqual([]);
		expect(imapFlagsToMailFlags(new Set(["\\Seen", "\\Flagged", "\\Answered"]))).toEqual([
			MailFlag.Flagged,
			MailFlag.Answered,
		]);
		expect(imapFlagsToMailFlags(["\\Draft"])).toEqual([MailFlag.Unread, MailFlag.Draft]);
	});
});

describe("folderRoleFromSpecialUse", () => {
	it("maps RFC 6154 attributes case-insensitively", () => {
		expect(folderRoleFromSpecialUse("\\Sent")).toBe(FolderRole.Sent);
		expect(folderRoleFromSpecialUse("\\drafts")).toBe(FolderRole.Drafts);
		expect(folderRoleFromSpecialUse("\\Junk")).toBe(FolderRole.Spam);
		expect(folderRoleFromSpecialUse("\\Trash")).toBe(FolderRole.Trash);
		expect(folderRoleFromSpecialUse("\\All")).toBe(FolderRole.Archive);
		expect(folderRoleFromSpecialUse(undefined)).toBeUndefined();
		expect(folderRoleFromSpecialUse("\\Flagged")).toBeUndefined();
	});
});

describe("imap cursor state machine", () => {
	it("round-trips", () => {
		const cursor = { uidValidity: "123456789", lastUid: 4242 };
		expect(parseImapCursor(formatImapCursor(cursor))).toEqual(cursor);
	});

	it("fails closed on malformed input", () => {
		expect(parseImapCursor("")).toBeNull();
		expect(parseImapCursor("abc")).toBeNull();
		expect(parseImapCursor("1:2:3")).toBeNull();
		expect(parseImapCursor("x:1")).toBeNull();
		expect(parseImapCursor("1:")).toBeNull();
	});
});

describe("selectNewestUids", () => {
	it("walks newest-first and caps at the limit (OQ-MB-4)", () => {
		expect(selectNewestUids([3, 9, 1, 7], 2)).toEqual([9, 7]);
		expect(selectNewestUids([3], 5)).toEqual([3]);
		expect(selectNewestUids([], 5)).toEqual([]);
		expect(selectNewestUids([1, 2], 0)).toEqual([]);
	});
});
