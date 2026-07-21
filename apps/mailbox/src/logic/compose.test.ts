/** Composer seeding + send-payload shaping (Mailbox-4). */

import { MailFlag } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { MessageView } from "../types/mail-view";
import {
	emptySeed,
	forwardSeed,
	newSubmissionId,
	parseRecipients,
	quotedHtmlBody,
	replySeed,
	seedFromIntentPayload,
	sendPayloadFromSeed,
} from "./compose";

const QUOTE = "Dana Lee wrote:";

function message(overrides: Partial<MessageView> = {}): MessageView {
	return {
		id: "msg-1",
		accountRef: "acc-1",
		folderRefs: ["f-1"],
		messageId: "<orig@example.com>",
		threadKey: "<orig@example.com>",
		from: [{ address: "dana@example.com", name: "Dana Lee" }],
		to: [{ address: "me@example.com" }],
		cc: [],
		subject: "Quarterly numbers",
		receivedAt: 1_700_000_000_000,
		bodyText: "line one\nline two",
		bodyHtmlSafe: "",
		attachments: [],
		attachmentParts: [],
		flags: [MailFlag.Unread],
		tags: [],
		unread: true,
		flagged: false,
		...overrides,
	};
}

describe("replySeed", () => {
	it("targets the sender, prefixes Re:, quotes the body, threads on the original", () => {
		const seed = replySeed(message(), QUOTE);
		expect(seed.to).toBe("Dana Lee <dana@example.com>");
		expect(seed.subject).toBe("Re: Quarterly numbers");
		expect(seed.body).toContain(QUOTE);
		expect(seed.body).toContain("> line one");
		expect(seed.body).toContain("> line two");
		expect(seed.inReplyTo).toBe("<orig@example.com>");
		expect(seed.references).toEqual(["<orig@example.com>"]);
		expect(seed.accountRef).toBe("acc-1");
	});

	it("never stacks Re: prefixes", () => {
		const seed = replySeed(message({ subject: "RE: Quarterly numbers" }), QUOTE);
		expect(seed.subject).toBe("RE: Quarterly numbers");
	});
});

describe("forwardSeed", () => {
	it("leaves recipients empty, prefixes Fwd:, quotes, and does not thread", () => {
		const seed = forwardSeed(message(), QUOTE);
		expect(seed.to).toBe("");
		expect(seed.subject).toBe("Fwd: Quarterly numbers");
		expect(seed.body).toContain("> line one");
		expect(seed.inReplyTo).toBeUndefined();
		expect(seed.references).toBeUndefined();
	});
});

describe("HTML quoting (Mailbox-11 residue)", () => {
	const HTML = "<p>the <strong>plan</strong></p>";

	it("carries an HTML quote on reply when the original had HTML", () => {
		const seed = replySeed(message({ bodyHtmlSafe: HTML }), QUOTE);
		expect(seed.bodyHtml).toContain("<blockquote>");
		expect(seed.bodyHtml).toContain(HTML);
		expect(seed.bodyHtml).toContain(QUOTE);
		// The plain-text quote is still present as the multipart/alternative text.
		expect(seed.body).toContain("> line one");
	});

	it("carries an HTML quote on forward too", () => {
		const seed = forwardSeed(message({ bodyHtmlSafe: HTML }), QUOTE);
		expect(seed.bodyHtml).toContain("<blockquote>");
	});

	it("omits bodyHtml for a plain-text-only original", () => {
		expect(replySeed(message(), QUOTE).bodyHtml).toBeUndefined();
		expect(replySeed(message({ bodyHtmlSafe: "   " }), QUOTE).bodyHtml).toBeUndefined();
	});

	it("escapes the attribution line so a crafted sender name cannot inject markup", () => {
		const quoted = quotedHtmlBody("<p>body</p>", "On date, <img src=x onerror=alert(1)> wrote:");
		expect(quoted).not.toContain("<img");
		expect(quoted).toContain("&lt;img");
		// The already-sanitised original HTML is passed through unescaped.
		expect(quoted).toContain("<p>body</p>");
	});
});

describe("seedFromIntentPayload", () => {
	const find = (id: string) => (id === "msg-1" ? message() : null);

	it("reply with a resolvable entityId quotes the original", () => {
		const seed = seedFromIntentPayload("reply", { entityId: "msg-1" }, find, QUOTE);
		expect(seed.inReplyTo).toBe("<orig@example.com>");
	});

	it("compose pre-fills from the payload fields", () => {
		const seed = seedFromIntentPayload(
			"compose",
			{ to: ["a@x.com", "b@y.com"], subject: "Hi", body: "text", accountRef: "acc-9" },
			find,
			QUOTE,
		);
		expect(seed.to).toBe("a@x.com, b@y.com");
		expect(seed.subject).toBe("Hi");
		expect(seed.body).toBe("text");
		expect(seed.accountRef).toBe("acc-9");
	});

	it("reply with an unresolvable entityId degrades to a blank compose", () => {
		const seed = seedFromIntentPayload("reply", { entityId: "gone" }, find, QUOTE);
		expect(seed.to).toBe("");
		expect(seed.inReplyTo).toBeUndefined();
	});
});

describe("sendPayloadFromSeed", () => {
	it("parses recipients, trims the subject, and carries the stable submissionId", () => {
		const seed = {
			...emptySeed("acc-1"),
			to: "Dana <dana@example.com>, bob@example.org, junk-no-address",
			cc: "carol@example.net",
			subject: "  Hi  ",
			body: "hello",
		};
		const payload = sendPayloadFromSeed(seed, "acc-1");
		expect(payload).toMatchObject({
			accountRef: "acc-1",
			to: ["Dana <dana@example.com>", "bob@example.org"],
			cc: ["carol@example.net"],
			subject: "Hi",
			bodyText: "hello",
			submissionId: seed.submissionId,
		});
	});

	it("carries bodyHtml when the composer produced rich content (Mailbox-11)", () => {
		const seed = { ...emptySeed("acc-1"), to: "a@b.co", body: "hello bold" };
		const payload = sendPayloadFromSeed(seed, "acc-1", "<p>hello <strong>bold</strong></p>");
		expect(payload).toMatchObject({
			bodyText: "hello bold",
			bodyHtml: "<p>hello <strong>bold</strong></p>",
		});
		// No html (plain draft) ⇒ no bodyHtml key at all.
		expect(sendPayloadFromSeed(seed, "acc-1")).not.toHaveProperty("bodyHtml");
		expect(sendPayloadFromSeed(seed, "acc-1", "")).not.toHaveProperty("bodyHtml");
	});

	it("returns null without a valid recipient or account", () => {
		expect(sendPayloadFromSeed({ ...emptySeed(), to: "not-an-address" }, "acc-1")).toBeNull();
		expect(sendPayloadFromSeed({ ...emptySeed(), to: "a@b.co" }, "")).toBeNull();
	});

	it("threading fields survive into the payload", () => {
		const seed = { ...replySeed(message(), QUOTE) };
		const payload = sendPayloadFromSeed(seed, "acc-1");
		expect(payload).toMatchObject({
			inReplyTo: "<orig@example.com>",
			references: ["<orig@example.com>"],
		});
	});
});

describe("newSubmissionId / parseRecipients", () => {
	it("submission ids are unique and survive driver token sanitization", () => {
		const a = newSubmissionId();
		const b = newSubmissionId();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^sub-[a-z0-9-]+$/);
	});

	it("parseRecipients keeps quoted display names with commas intact", () => {
		expect(parseRecipients('"Lee, Dana" <dana@example.com>, bob@example.org')).toEqual([
			'"Lee, Dana" <dana@example.com>',
			"bob@example.org",
		]);
	});
});
