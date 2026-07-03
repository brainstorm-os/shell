/**
 * Chat dashboard widget — pure data-shaping coverage. `shapeRecentMessages`
 * is the widget's only non-presentational logic; the component shell mirrors
 * the real-shell-verified Contacts widget. The critical case here is the
 * channel cross-filter: `brainstorm/Message/v1` is shared with the Agent app,
 * so a message is a *chat* message only when its `conversation` resolves to a
 * live chat channel in the snapshot.
 */

import { describe, expect, it } from "vitest";
import { CHANNEL_TYPE, MESSAGE_TYPE } from "./logic/chat";
import { type WidgetChatEntity, messageSnippet, shapeRecentMessages } from "./widget-data";

function channel(id: string, name: string, deletedAt: number | null = null): WidgetChatEntity {
	return {
		id,
		type: CHANNEL_TYPE,
		properties: { name, createdAt: "2026-01-01T00:00:00Z" },
		deletedAt,
	};
}

function message(
	id: string,
	conversation: string,
	over: Partial<{ body: string; seq: number; createdAt: string; sender: unknown }> = {},
	deletedAt: number | null = null,
): WidgetChatEntity {
	return {
		id,
		type: MESSAGE_TYPE,
		properties: {
			conversation,
			body: over.body ?? "hello",
			seq: over.seq ?? 0,
			createdAt: over.createdAt ?? "2026-01-02T10:00:00Z",
			sender: over.sender ?? { kind: "participant", personRef: "p1", displayName: "Ada" },
		},
		deletedAt,
	};
}

describe("shapeRecentMessages", () => {
	it("keeps only messages whose conversation resolves to a chat channel — agent transcripts don't leak", () => {
		const entities: WidgetChatEntity[] = [
			channel("ch1", "general"),
			// The Agent app stores the SAME message type against a Conversation/v1.
			{
				id: "conv1",
				type: "brainstorm/Conversation/v1",
				properties: { title: "Agent session" },
				deletedAt: null,
			},
			message("m1", "ch1", { body: "chat message" }),
			message("m2", "conv1", { body: "agent transcript turn" }),
			message("m3", "missing", { body: "orphan" }),
		];
		const { rows, channelCount } = shapeRecentMessages(entities);
		expect(rows.map((r) => r.id)).toEqual(["m1"]);
		expect(channelCount).toBe(1);
	});

	it("orders newest first by seq, then createdAt (ISO string), then id", () => {
		const entities: WidgetChatEntity[] = [
			channel("ch1", "general"),
			message("a", "ch1", { seq: 0, createdAt: "2026-01-02T10:00:00Z" }),
			message("b", "ch1", { seq: 2, createdAt: "2026-01-02T10:01:00Z" }),
			message("c", "ch1", { seq: 1, createdAt: "2026-01-02T10:05:00Z" }),
			// Same seq as b — the ISO createdAt breaks the tie.
			message("d", "ch1", { seq: 2, createdAt: "2026-01-02T10:02:00Z" }),
		];
		const { rows } = shapeRecentMessages(entities);
		expect(rows.map((r) => r.id)).toEqual(["d", "b", "c", "a"]);
	});

	it("projects sender displayName, channel name, and a single-line snippet", () => {
		const entities: WidgetChatEntity[] = [
			channel("ch1", "design"),
			message("m1", "ch1", {
				body: "line one\nline two\t  spaced",
				sender: { kind: "participant", personRef: "p9", displayName: "Grace" },
			}),
		];
		const { rows } = shapeRecentMessages(entities);
		expect(rows[0]?.sender).toBe("Grace");
		expect(rows[0]?.channelName).toBe("design");
		expect(rows[0]?.channelId).toBe("ch1");
		expect(rows[0]?.snippet).toBe("line one line two spaced");
	});

	it("drops deleted messages, and every message of a deleted channel", () => {
		const entities: WidgetChatEntity[] = [
			channel("ch1", "general"),
			channel("ch2", "archived", 123),
			message("m1", "ch1"),
			message("m2", "ch1", {}, 456),
			message("m3", "ch2"),
		];
		const { rows, channelCount } = shapeRecentMessages(entities);
		expect(rows.map((r) => r.id)).toEqual(["m1"]);
		expect(channelCount).toBe(1);
	});

	it("caps the projection at the limit but counts every live channel", () => {
		const entities: WidgetChatEntity[] = [
			channel("ch1", "general"),
			channel("ch2", "quiet"),
			...Array.from({ length: 12 }, (_, i) =>
				message(`m${i}`, "ch1", {
					seq: i,
					createdAt: `2026-01-02T10:${String(i).padStart(2, "0")}:00Z`,
				}),
			),
		];
		const { rows, channelCount } = shapeRecentMessages(entities, 8);
		expect(rows).toHaveLength(8);
		expect(rows[0]?.id).toBe("m11");
		expect(channelCount).toBe(2);
	});

	it("returns no rows for an empty snapshot", () => {
		const { rows, channelCount } = shapeRecentMessages([]);
		expect(rows).toEqual([]);
		expect(channelCount).toBe(0);
	});
});

describe("messageSnippet", () => {
	it("collapses whitespace and trims", () => {
		expect(messageSnippet("  a\n\nb\tc  ")).toBe("a b c");
	});

	it("caps the snippet length", () => {
		expect(messageSnippet("x".repeat(500)).length).toBeLessThanOrEqual(160);
	});
});
