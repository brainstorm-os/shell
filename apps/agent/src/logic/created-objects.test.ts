import { AGENT_PROVENANCE_PROPERTY_KEY } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { createdObjectsForConversation } from "./created-objects";

const AGENT = "io.brainstorm.agent";

function ent(
	id: string,
	type: string,
	props: Record<string, unknown>,
	prov?: { agent?: string; conversationId: string; createdAt: number },
	deletedAt?: number | null,
) {
	const properties = prov
		? {
				...props,
				[AGENT_PROVENANCE_PROPERTY_KEY]: {
					agent: prov.agent ?? AGENT,
					conversationId: prov.conversationId,
					createdAt: prov.createdAt,
				},
			}
		: props;
	return { id, type, properties, deletedAt: deletedAt ?? null };
}

describe("createdObjectsForConversation", () => {
	it("returns entities stamped for the conversation, newest-first, with a title/name label", () => {
		const entities = [
			ent("e1", "io.x/Note/v1", { title: "First" }, { conversationId: "c1", createdAt: 100 }),
			ent("e2", "brainstorm/Task/v1", { name: "Second" }, { conversationId: "c1", createdAt: 200 }),
			ent("e3", "io.x/Note/v1", { title: "Other chat" }, { conversationId: "c2", createdAt: 300 }),
			ent("e4", "io.x/Note/v1", { title: "No prov" }),
		];
		expect(createdObjectsForConversation(entities, "c1")).toEqual([
			{ id: "e2", type: "brainstorm/Task/v1", title: "Second" },
			{ id: "e1", type: "io.x/Note/v1", title: "First" },
		]);
	});

	it("drops soft-deleted rows", () => {
		const entities = [
			ent("e1", "io.x/Note/v1", { title: "Live" }, { conversationId: "c1", createdAt: 100 }),
			ent("e2", "io.x/Note/v1", { title: "Binned" }, { conversationId: "c1", createdAt: 200 }, 999),
		];
		expect(createdObjectsForConversation(entities, "c1").map((c) => c.id)).toEqual(["e1"]);
	});

	it("optionally requires the provenance agent to match this app", () => {
		const entities = [
			ent(
				"e1",
				"io.x/Note/v1",
				{ title: "Mine" },
				{ agent: AGENT, conversationId: "c1", createdAt: 100 },
			),
			ent(
				"e2",
				"io.x/Note/v1",
				{ title: "Other agent" },
				{ agent: "io.other.agent", conversationId: "c1", createdAt: 200 },
			),
		];
		expect(createdObjectsForConversation(entities, "c1", AGENT).map((c) => c.id)).toEqual(["e1"]);
		// Without the agent filter, both match.
		expect(createdObjectsForConversation(entities, "c1").length).toBe(2);
	});

	it("returns nothing for a blank conversation id", () => {
		const entities = [
			ent("e1", "io.x/Note/v1", { title: "First" }, { conversationId: "c1", createdAt: 100 }),
		];
		expect(createdObjectsForConversation(entities, "")).toEqual([]);
	});
});
