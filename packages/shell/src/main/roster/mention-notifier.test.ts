/**
 * Mention-notifier tests (Collab-C6) — extraction of mention targets from a
 * Message/Comment + the self-suppressing should-notify decision.
 */

import { AttachmentKind, SenderKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	COMMENT_TYPE_URL,
	MESSAGE_TYPE_URL,
	mentionTargets,
	shouldNotify,
} from "./mention-notifier";

const SELF = "self-pubkey";
const OTHER = "other-pubkey";

describe("mentionTargets — Message/v1", () => {
	it("pulls Person attachment refs as mentions and the participant author", () => {
		const targets = mentionTargets(MESSAGE_TYPE_URL, {
			sender: { kind: SenderKind.Participant, personRef: OTHER, displayName: "Bob" },
			attachments: [
				{ kind: AttachmentKind.Person, ref: SELF, label: "Me" },
				{ kind: AttachmentKind.Media, ref: "blob://x" },
				{ kind: AttachmentKind.Person, ref: SELF }, // duplicate ignored
			],
		});
		expect(targets).toEqual({ mentioned: [SELF], author: OTHER, authorName: "Bob" });
	});

	it("treats an assistant sender as a null author (a mention of you still notifies)", () => {
		const targets = mentionTargets(MESSAGE_TYPE_URL, {
			sender: { kind: SenderKind.Assistant, displayName: "Assistant" },
			attachments: [{ kind: AttachmentKind.Person, ref: SELF }],
		});
		expect(targets).not.toBeNull();
		expect(targets?.author).toBeNull();
		expect(targets && shouldNotify(targets, SELF)).toBe(true);
	});

	it("has no mentions when there are no Person attachments", () => {
		const targets = mentionTargets(MESSAGE_TYPE_URL, {
			sender: { kind: SenderKind.Participant, personRef: SELF, displayName: "Me" },
		});
		expect(targets?.mentioned).toEqual([]);
	});
});

describe("mentionTargets — Comment/v1", () => {
	it("pulls the mentions array + author pubkey", () => {
		const targets = mentionTargets(COMMENT_TYPE_URL, {
			mentions: [SELF, OTHER, SELF],
			authorPubkey: OTHER,
			authorName: "Bob",
		});
		expect(targets).toEqual({ mentioned: [SELF, OTHER], author: OTHER, authorName: "Bob" });
	});
});

describe("mentionTargets — other types", () => {
	it("returns null for a non-message/comment type", () => {
		expect(mentionTargets("brainstorm/Note/v1", { mentions: [SELF] })).toBeNull();
	});
});

describe("shouldNotify", () => {
	const base = { mentioned: [SELF], authorName: "Bob" };

	it("notifies when self is mentioned by someone else", () => {
		expect(shouldNotify({ ...base, author: OTHER }, SELF)).toBe(true);
	});

	it("self-suppresses when you authored the mention", () => {
		expect(shouldNotify({ ...base, author: SELF }, SELF)).toBe(false);
	});

	it("does not notify when self is not mentioned", () => {
		expect(shouldNotify({ mentioned: [OTHER], author: OTHER, authorName: "Bob" }, SELF)).toBe(false);
	});

	it("does not notify on an empty self pubkey", () => {
		expect(shouldNotify({ ...base, author: OTHER }, "")).toBe(false);
	});
});
