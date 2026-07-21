import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	detectMentionTrigger,
	entityDisplayName,
	filterEntities,
	mentionEntityTypeLabel,
} from "./mention-ops";

function entity(id: string, title: string): VaultEntity {
	return {
		id,
		type: "io.brainstorm.notes/Note/v1",
		properties: { title },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
		ownerAppId: "io.brainstorm.notes",
	};
}

describe("detectMentionTrigger", () => {
	it("returns null when the caret isn't preceded by an @", () => {
		expect(detectMentionTrigger("hello world", 5)).toBeNull();
	});

	it("returns the query when the caret sits inside a `@<query>` segment", () => {
		expect(detectMentionTrigger("@pro", 4)).toEqual({ triggerOffset: 0, query: "pro" });
	});

	it("treats `@` at the start of the paragraph as a boundary", () => {
		expect(detectMentionTrigger("@", 1)).toEqual({ triggerOffset: 0, query: "" });
	});

	it("requires `@` to follow whitespace or punctuation, not letters/digits", () => {
		expect(detectMentionTrigger("email@host", 10)).toBeNull();
		expect(detectMentionTrigger("v2@release", 10)).toBeNull();
	});

	it("defers `!@` to the transclusion trigger — never opens a mention too", () => {
		// `!@` is the transclusion trigger; a `@` immediately preceded by `!`
		// belongs to it, so the mention typeahead must NOT also fire (else `!@`
		// opens two stacked menus — the journal double-menu bug).
		expect(detectMentionTrigger("!@", 2)).toBeNull();
		expect(detectMentionTrigger("!@Clients", 9)).toBeNull();
		expect(detectMentionTrigger("see !@apo", 9)).toBeNull();
	});

	it("matches when `@` follows a space", () => {
		expect(detectMentionTrigger("see @apo", 8)).toEqual({ triggerOffset: 4, query: "apo" });
	});

	it("matches when `@` follows an opening bracket", () => {
		expect(detectMentionTrigger("[@pro", 5)).toEqual({ triggerOffset: 1, query: "pro" });
	});

	it("returns null when the query contains whitespace (typing has left the trigger)", () => {
		expect(detectMentionTrigger("@pro ject", 9)).toBeNull();
	});

	it("returns null when no @ is reachable before the caret", () => {
		expect(detectMentionTrigger("just text", 9)).toBeNull();
	});

	it("returns null when the @ is past a newline boundary", () => {
		expect(detectMentionTrigger("@first\nsecond", 13)).toBeNull();
	});

	it("returns null when the query exceeds the max length", () => {
		const long = `@${"a".repeat(65)}`;
		expect(detectMentionTrigger(long, long.length)).toBeNull();
	});

	it("returns null when the caret is out of range", () => {
		expect(detectMentionTrigger("hello", -1)).toBeNull();
		expect(detectMentionTrigger("hello", 99)).toBeNull();
	});
});

describe("filterEntities", () => {
	const entities: VaultEntity[] = [
		entity("n_a", "Apollo"),
		entity("n_b", "Project Apollo"),
		entity("n_c", "Banana split"),
		entity("n_d", "Berlin"),
		entity("n_e", "  "),
	];

	it("empty query returns every entity sorted by display name, rank 0", () => {
		const result = filterEntities(entities, "");
		// Apollo, Banana split, Berlin, n_e (fallback id from blank title), Project Apollo
		expect(result.map((r) => r.entity.id)).toEqual(["n_a", "n_c", "n_d", "n_e", "n_b"]);
		expect(result.every((r) => r.rank === 0)).toBe(true);
	});

	it("ranks prefix matches above word-start above anywhere", () => {
		const result = filterEntities(entities, "apo");
		// Apollo (prefix), Project Apollo (word-start)
		expect(result.map((r) => r.entity.id)).toEqual(["n_a", "n_b"]);
		expect(result.map((r) => r.rank)).toEqual([0, 1]);
	});

	it("is case-insensitive + trims query whitespace", () => {
		const result = filterEntities(entities, "  Apollo  ");
		expect(result.map((r) => r.entity.id)).toContain("n_a");
		expect(result.map((r) => r.entity.id)).toContain("n_b");
	});

	it("excludes ids in excludeIds (self-mention guard)", () => {
		const result = filterEntities(entities, "", new Set(["n_a"]));
		expect(result.map((r) => r.entity.id)).not.toContain("n_a");
	});

	it("returns nothing when nothing matches", () => {
		expect(filterEntities(entities, "zzz")).toEqual([]);
	});

	it("falls back to the entity id when no title is available", () => {
		const ent = entity("n_x", "");
		expect(entityDisplayName(ent)).toBe("n_x");
	});

	it("ranks `Banana split` by word-start when query is `split`", () => {
		const result = filterEntities(entities, "split");
		expect(result.map((r) => r.entity.id)).toEqual(["n_c"]);
		expect(result[0]?.rank).toBe(1);
	});
});

describe("entityDisplayName", () => {
	it("uses `title` when present", () => {
		expect(entityDisplayName(entity("n_a", "Hello"))).toBe("Hello");
	});

	it("falls back to `name` when title is blank", () => {
		const ent: VaultEntity = {
			id: "n_b",
			type: "T/v1",
			properties: { title: "  ", name: "Fallback" },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
			ownerAppId: "app",
		};
		expect(entityDisplayName(ent)).toBe("Fallback");
	});

	it("falls back to id when neither title nor name is present", () => {
		const ent: VaultEntity = {
			id: "n_c",
			type: "T/v1",
			properties: {},
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
			ownerAppId: "app",
		};
		expect(entityDisplayName(ent)).toBe("n_c");
	});
});

describe("mentionEntityTypeLabel", () => {
	it("extracts the TypeName from a namespaced versioned id", () => {
		expect(mentionEntityTypeLabel("io.brainstorm.notes/Note/v1")).toBe("Note");
		expect(mentionEntityTypeLabel("brainstorm/Person/v1")).toBe("Person");
		expect(mentionEntityTypeLabel("brainstorm/Company/v12")).toBe("Company");
	});

	it("keeps the last segment when there is no trailing version", () => {
		expect(mentionEntityTypeLabel("brainstorm/Task")).toBe("Task");
	});

	it("falls back to the raw type for an unparseable shape", () => {
		expect(mentionEntityTypeLabel("Note")).toBe("Note");
		expect(mentionEntityTypeLabel("")).toBe("");
	});
});
