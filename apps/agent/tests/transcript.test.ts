import { MessageRole } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import { formatCitationLine } from "../src/logic/citation-format";
import {
	AGENT_SYSTEM_PROMPT,
	type TranscriptMessage,
	buildAiMessages,
	deriveConversationTitle,
	linkifyEntityRefs,
	sortMessages,
} from "../src/logic/transcript";

const msg = (over: Partial<TranscriptMessage>): TranscriptMessage => ({
	id: "m",
	role: MessageRole.User,
	body: "",
	createdAt: "2026-06-07T00:00:00.000Z",
	...over,
});

describe("sortMessages", () => {
	it("orders by createdAt, then seq, then id", () => {
		const out = sortMessages([
			msg({ id: "b", createdAt: "2026-06-07T00:00:02.000Z" }),
			msg({ id: "a", createdAt: "2026-06-07T00:00:01.000Z" }),
			msg({ id: "c", createdAt: "2026-06-07T00:00:01.000Z", seq: 2 }),
			msg({ id: "d", createdAt: "2026-06-07T00:00:01.000Z", seq: 1 }),
		]);
		expect(out.map((m) => m.id)).toEqual(["a", "d", "c", "b"]);
	});
});

describe("buildAiMessages", () => {
	it("prepends the system prompt and keeps user/assistant turns in order", () => {
		const out = buildAiMessages([
			msg({ id: "1", role: MessageRole.User, body: "Hi", createdAt: "2026-06-07T00:00:01.000Z" }),
			msg({
				id: "2",
				role: MessageRole.Assistant,
				body: "Hello",
				createdAt: "2026-06-07T00:00:02.000Z",
			}),
		]);
		expect(out).toEqual([
			{ role: MessageRole.System, content: AGENT_SYSTEM_PROMPT },
			{ role: MessageRole.User, content: "Hi" },
			{ role: MessageRole.Assistant, content: "Hello" },
		]);
	});

	it("skips tool/system rows and coerces an unknown role to user", () => {
		const out = buildAiMessages([
			msg({ id: "1", role: "tool", body: "tool out", createdAt: "2026-06-07T00:00:01.000Z" }),
			msg({ id: "2", role: "weird", body: "kept", createdAt: "2026-06-07T00:00:02.000Z" }),
		]);
		expect(out).toEqual([
			{ role: MessageRole.System, content: AGENT_SYSTEM_PROMPT },
			{ role: MessageRole.User, content: "kept" },
		]);
	});
});

describe("deriveConversationTitle", () => {
	it("uses the first non-empty line", () => {
		expect(deriveConversationTitle("\n  Plan the launch  \nmore", "fallback")).toBe(
			"Plan the launch",
		);
	});

	it("truncates a long line with an ellipsis", () => {
		const long = "x".repeat(80);
		const out = deriveConversationTitle(long, "fallback");
		expect(out.length).toBe(60);
		expect(out.endsWith("…")).toBe(true);
	});

	it("falls back when the body is blank", () => {
		expect(deriveConversationTitle("   \n  ", "New conversation")).toBe("New conversation");
	});
});

describe("linkifyEntityRefs (F-319)", () => {
	it("rewrites the canonical `- [id] Title` list line to a `[Title](id)` markdown link", () => {
		expect(linkifyEntityRefs("- [n_mqz1aegg_2qmlcl] Northbound Q3 plan 32834")).toBe(
			"- [Northbound Q3 plan 32834](n_mqz1aegg_2qmlcl)",
		);
	});

	it("round-trips the retrieval emitter's citation line format", () => {
		const line = formatCitationLine("n_mqz1aegg_2qmlcl", "Northbound Q3 plan — a snippet");
		expect(linkifyEntityRefs(line)).toBe("- [Northbound Q3 plan — a snippet](n_mqz1aegg_2qmlcl)");
	});

	it("round-trips a digitless (seed-shaped) id when list-anchored", () => {
		const line = formatCitationLine("mkt_co_harbor", "Harbor & Co");
		expect(linkifyEntityRefs(line)).toBe("- [Harbor & Co](mkt_co_harbor)");
	});

	it("labels a bare `[id]` with the id itself (citationsToLinks fallback)", () => {
		expect(linkifyEntityRefs("see [ent_abc123].")).toBe("see [ent_abc123](ent_abc123).");
	});

	it("keeps prose after a mid-sentence citation intact (id-labelled link)", () => {
		expect(linkifyEntityRefs("see [n_abc_1] for details")).toBe("see [n_abc_1](n_abc_1) for details");
	});

	it("handles multiple refs on one line without absorbing the prose between them", () => {
		expect(linkifyEntityRefs("[n_a1] Foo and [n_b2] Bar")).toBe(
			"[n_a1](n_a1) Foo and [n_b2](n_b2) Bar",
		);
	});

	it("linkifies a title line after a colon lead-in", () => {
		expect(linkifyEntityRefs("Source: [n_a1] Quarterly Plan")).toBe("Source: [Quarterly Plan](n_a1)");
	});

	it("leaves bracketed snake_case prose tokens untouched", () => {
		const body = "set [max_retries] and [user_id] in the config\n[max_retries] controls attempts";
		expect(linkifyEntityRefs(body)).toBe(body);
	});

	it("leaves real markdown links, prose brackets, and headings untouched", () => {
		const body = "### Plan\n**bold** [label](n_x1) and [x] done, [TODO] later, [1] footnote";
		expect(linkifyEntityRefs(body)).toBe(body);
	});

	it("leaves fenced code blocks untouched", () => {
		const body = "```\n[n_abc_1] not a citation\n```\n[n_abc_1] Real Title";
		expect(linkifyEntityRefs(body)).toBe("```\n[n_abc_1] not a citation\n```\n[Real Title](n_abc_1)");
	});

	it("treats ~~~ fences like ``` fences", () => {
		const body = "~~~\n- [n_abc_1] not a citation\n~~~";
		expect(linkifyEntityRefs(body)).toBe(body);
	});

	it("leaves indented fences inside list items untouched", () => {
		const body = "- item\n  ```\n  [n_abc_1] code\n  ```\nafter [n_abc_1]";
		expect(linkifyEntityRefs(body)).toBe(
			"- item\n  ```\n  [n_abc_1] code\n  ```\nafter [n_abc_1](n_abc_1)",
		);
	});

	it("leaves indented (4-space) code lines untouched", () => {
		const body = "prose\n    [n_abc_1] indented code";
		expect(linkifyEntityRefs(body)).toBe(body);
	});

	it("leaves inline code spans untouched, still rewriting the prose around them", () => {
		expect(linkifyEntityRefs("use `retry([n_a1])` then see [n_b2] please")).toBe(
			"use `retry([n_a1])` then see [n_b2](n_b2) please",
		);
	});
});
