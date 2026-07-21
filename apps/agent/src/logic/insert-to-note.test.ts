import { INSERT_MARKDOWN_MAX, InsertPosition } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	AddToNoteMode,
	NOTE_ENTITY_TYPE,
	buildAddToNoteMarkdown,
	buildInsertIntentEnvelope,
	noteCandidates,
	rewriteCitationLinksForNote,
} from "./insert-to-note";

const note = (id: string, title: string) => ({
	id,
	type: NOTE_ENTITY_TYPE,
	properties: { title },
});
const task = (id: string) => ({
	id,
	type: "io.brainstorm.tasks/Task/v1",
	properties: { title: "A task" },
});

describe("noteCandidates", () => {
	it("filters to titled notes only", () => {
		const rows = noteCandidates(
			[note("n_1a", "Meeting notes"), task("task_1"), note("n_2b", ""), note("n_3c", "Plans")],
			"",
		);
		expect(rows.map((r) => r.id)).toEqual(["n_1a", "n_3c"]);
	});

	it("matches case-insensitive title substrings", () => {
		const rows = noteCandidates([note("n_1a", "Meeting notes"), note("n_2b", "Plans")], "MEET");
		expect(rows.map((r) => r.title)).toEqual(["Meeting notes"]);
	});

	it("caps the list", () => {
		const many = Array.from({ length: 20 }, (_, i) => note(`n_${i}x`, `Note ${i}`));
		expect(noteCandidates(many, "").length).toBe(8);
	});
});

describe("rewriteCitationLinksForNote", () => {
	it("rewrites bare-entity-id link targets to brainstorm://entity URIs", () => {
		const out = rewriteCitationLinksForNote("See [Standup](ent_m3k9a1b2) for details.");
		expect(out).toBe("See [Standup](brainstorm://entity/ent_m3k9a1b2) for details.");
	});

	it("leaves scheme-carrying and prose links untouched", () => {
		const md = "A [site](https://example.com) and [config](max_retries).";
		expect(rewriteCitationLinksForNote(md)).toBe(md);
	});
});

describe("buildAddToNoteMarkdown", () => {
	const base = {
		replyMarkdown: "The answer, per [Standup](ent_m3k9a1b2).",
		conversationId: "conv_9z8y7",
		conversationTitle: "Planning chat",
	};

	it("insert mode: rewritten reply + provenance link to the conversation", () => {
		const out = buildAddToNoteMarkdown({ ...base, mode: AddToNoteMode.InsertReply });
		expect(out).toContain("(brainstorm://entity/ent_m3k9a1b2)");
		expect(out).toContain("\n\n— [Planning chat](brainstorm://entity/conv_9z8y7)");
	});

	it("link mode: just the conversation link", () => {
		const out = buildAddToNoteMarkdown({ ...base, mode: AddToNoteMode.LinkChat });
		expect(out).toBe("[Planning chat](brainstorm://entity/conv_9z8y7)");
	});

	it("strips bracket characters from the title label (no link breakout)", () => {
		const out = buildAddToNoteMarkdown({
			...base,
			mode: AddToNoteMode.LinkChat,
			conversationTitle: "Bad [x](y) title",
		});
		expect(out).toBe("[Bad xy title](brainstorm://entity/conv_9z8y7)");
	});

	it("clamps an oversized reply under the wire bound (payload never throws)", () => {
		const out = buildAddToNoteMarkdown({
			...base,
			mode: AddToNoteMode.InsertReply,
			replyMarkdown: "a".repeat(INSERT_MARKDOWN_MAX * 2),
		});
		expect(out.length).toBeLessThanOrEqual(INSERT_MARKDOWN_MAX);
		expect(out.endsWith("— [Planning chat](brainstorm://entity/conv_9z8y7)")).toBe(true);
	});
});

describe("buildInsertIntentEnvelope", () => {
	it("builds the target-addressed insert envelope", () => {
		const envelope = buildInsertIntentEnvelope("n_1a", "content");
		expect(envelope.verb).toBe("insert");
		expect(envelope.payload).toEqual({
			entityId: "n_1a",
			entityType: NOTE_ENTITY_TYPE,
			position: InsertPosition.End,
			markdown: "content",
		});
	});

	it("throws on a blank note id (caller misuse, fail-closed)", () => {
		expect(() => buildInsertIntentEnvelope("  ", "content")).toThrow();
	});
});
