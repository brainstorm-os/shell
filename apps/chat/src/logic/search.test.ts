import { describe, expect, it } from "vitest";
import { CHANNEL_TYPE, type EntityLike, MESSAGE_TYPE } from "./chat";
import { SEARCH_RESULT_LIMIT, SearchScope, queryTerms, searchMessages, snippetFor } from "./search";

const channel = (id: string, name: string): EntityLike => ({
	id,
	type: CHANNEL_TYPE,
	properties: { name, createdAt: "2026-06-01T00:00:00.000Z" },
});

const message = (id: string, channelId: string, body: string, minute: number): EntityLike => ({
	id,
	type: MESSAGE_TYPE,
	properties: {
		conversation: channelId,
		body,
		seq: minute,
		createdAt: `2026-06-20T10:${String(minute).padStart(2, "0")}:00.000Z`,
		sender: { kind: "participant", personRef: "p-ada", displayName: "Ada" },
	},
});

const snapshot: EntityLike[] = [
	channel("c1", "general"),
	channel("c2", "design"),
	message("m1", "c1", "Ship the launch checklist today", 1),
	message("m2", "c2", "The launch banner needs a darker blue", 2),
	message("m3", "c1", "Lunch?", 3),
	message("orphan", "gone", "launch from a deleted channel", 4),
	{ id: "agent", type: MESSAGE_TYPE, properties: { conversation: "agent-convo", body: "launch" } },
];

describe("searchMessages (Chats-1)", () => {
	it("finds matches across every channel, newest first, with the channel name", () => {
		const hits = searchMessages(snapshot, "LAUNCH", { scope: SearchScope.All, channelId: null });
		expect(hits.map((h) => h.messageId)).toEqual(["m2", "m1"]);
		expect(hits[0]).toMatchObject({ channelId: "c2", channelName: "design", authorName: "Ada" });
	});

	it("scopes to the current channel", () => {
		const hits = searchMessages(snapshot, "launch", { scope: SearchScope.Channel, channelId: "c1" });
		expect(hits.map((h) => h.messageId)).toEqual(["m1"]);
	});

	it("requires every term to match", () => {
		expect(
			searchMessages(snapshot, "launch blue", { scope: SearchScope.All, channelId: null }).map(
				(h) => h.messageId,
			),
		).toEqual(["m2"]);
	});

	it("ignores messages outside a live chat channel (agent transcripts, deleted channels)", () => {
		const ids = searchMessages(snapshot, "launch", { scope: SearchScope.All, channelId: null }).map(
			(h) => h.messageId,
		);
		expect(ids).not.toContain("orphan");
		expect(ids).not.toContain("agent");
	});

	it("returns nothing for a one-character query or a channel scope with no channel", () => {
		expect(searchMessages(snapshot, "l", { scope: SearchScope.All, channelId: null })).toEqual([]);
		expect(
			searchMessages(snapshot, "launch", { scope: SearchScope.Channel, channelId: null }),
		).toEqual([]);
	});

	it("caps the result list", () => {
		const many: EntityLike[] = [channel("c1", "general")];
		for (let i = 0; i < SEARCH_RESULT_LIMIT + 10; i++)
			many.push(message(`m${i}`, "c1", "hello", i % 60));
		expect(searchMessages(many, "hello", { scope: SearchScope.All, channelId: null })).toHaveLength(
			SEARCH_RESULT_LIMIT,
		);
	});
});

describe("snippetFor", () => {
	it("keeps a short body whole and flattens whitespace", () => {
		expect(snippetFor("a\n\nlaunch  now", queryTerms("launch"))).toBe("a launch now");
	});

	it("windows a long body around the first match with ellipses", () => {
		const body = `${"x".repeat(200)} launch ${"y".repeat(200)}`;
		const snip = snippetFor(body, ["launch"]);
		expect(snip.startsWith("…")).toBe(true);
		expect(snip.endsWith("…")).toBe(true);
		expect(snip).toContain("launch");
		expect(snip.length).toBeLessThan(120);
	});
});
