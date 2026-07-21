/**
 * Agent "recent-conversations" dashboard widget — pure data-shaping coverage.
 * The `shapeConversations` projection is the widget's only non-presentational
 * logic; the component shell is a faithful mirror of the Contacts / Journal
 * widgets.
 */

import { CONVERSATION_TYPE_URL } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { AGENT_I18N } from "./i18n";
import { type WidgetConversationEntity, shapeConversations, updatedLabel } from "./widget-data";

const NOW = Date.UTC(2026, 6, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function conversation(
	id: string,
	properties: Record<string, unknown>,
	updatedAt = 0,
	deletedAt: number | null = null,
): WidgetConversationEntity {
	return { id, type: CONVERSATION_TYPE_URL, properties, updatedAt, deletedAt };
}

describe("shapeConversations", () => {
	it("keeps only non-deleted Conversation/v1 rows", () => {
		const entities: WidgetConversationEntity[] = [
			conversation("c1", { title: "Planning" }),
			{ ...conversation("m1", { title: "A message" }), type: "brainstorm/Message/v1" },
			conversation("c2", { title: "Binned" }, 0, 123),
		];
		const { conversations, total } = shapeConversations(entities, NOW);
		expect(total).toBe(1);
		expect(conversations.map((c) => c.id)).toEqual(["c1"]);
	});

	it("sorts by most-recently-updated first", () => {
		const entities = [
			conversation("old", { title: "Old" }, NOW - 3 * DAY),
			conversation("new", { title: "New" }, NOW),
			conversation("mid", { title: "Mid" }, NOW - DAY),
		];
		const { conversations } = shapeConversations(entities, NOW);
		expect(conversations.map((c) => c.id)).toEqual(["new", "mid", "old"]);
	});

	it("falls back to the untitled label when a conversation has no title", () => {
		const entities = [
			conversation("blank", { title: "   " }),
			conversation("missing", {}),
			conversation("wrongType", { title: 42 }),
		];
		const { conversations } = shapeConversations(entities, NOW);
		for (const c of conversations) {
			expect(c.title).toBe(AGENT_I18N["chat.untitled"]);
		}
	});

	it("caps the projection at the limit but reports the full total", () => {
		const entities = Array.from({ length: 12 }, (_, i) =>
			conversation(`c${i}`, { title: `Conversation ${i}` }, i),
		);
		const { conversations, total } = shapeConversations(entities, NOW, 8);
		expect(total).toBe(12);
		expect(conversations).toHaveLength(8);
	});

	it("carries a relative updated stamp on each row", () => {
		const { conversations } = shapeConversations(
			[conversation("c1", { title: "Today's chat" }, NOW)],
			NOW,
		);
		expect(conversations[0]?.updated).toBe(updatedLabel(NOW, NOW));
	});
});

describe("updatedLabel", () => {
	it("renders today / yesterday through the catalog labels", () => {
		expect(updatedLabel(NOW, NOW)).toBe(
			AGENT_I18N["widget.updated"].replace("{date}", AGENT_I18N["widget.date.today"]),
		);
		expect(updatedLabel(NOW - DAY, NOW)).toBe(
			AGENT_I18N["widget.updated"].replace("{date}", AGENT_I18N["widget.date.yesterday"]),
		);
	});

	it("renders older stamps as a non-empty locale date", () => {
		const label = updatedLabel(NOW - 40 * DAY, NOW);
		expect(label.startsWith("Updated ")).toBe(true);
		expect(label.length).toBeGreaterThan("Updated ".length);
	});
});
