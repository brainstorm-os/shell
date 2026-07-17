import { describe, expect, it } from "vitest";
import { rewriteEntityRefs } from "./merge-refs";

const LOSER = "ent_loser1";
const LOSER2 = "ent_loser2";
const SURVIVOR = "ent_survivor";
const OTHER = "ent_other";
const losers = new Set([LOSER, LOSER2]);

describe("rewriteEntityRefs", () => {
	it("returns null when nothing references a loser", () => {
		const props = { name: "Task", assignee: OTHER, tags: ["a", "b"] };
		expect(rewriteEntityRefs(props, losers, SURVIVOR, "ent_task")).toBeNull();
	});

	it("rewrites a bare scalar ref and leaves other keys out of the patch", () => {
		const props = { name: "Task", assignee: LOSER, project: OTHER };
		const patch = rewriteEntityRefs(props, losers, SURVIVOR, "ent_task");
		expect(patch).toEqual({ assignee: SURVIVOR });
	});

	it("rewrites ids inside a plain string array", () => {
		const patch = rewriteEntityRefs(
			{ members: [OTHER, LOSER, LOSER2] },
			losers,
			SURVIVOR,
			"ent_folder",
		);
		expect(patch).toEqual({ members: [OTHER, SURVIVOR] });
	});

	it("rewrites `{value,label}` / `{id}` / `{entityId}` envelopes, preserving labels", () => {
		const patch = rewriteEntityRefs(
			{
				rel: [{ value: LOSER, label: "Dana" }],
				single: { id: LOSER2 },
				alt: { entityId: LOSER },
			},
			losers,
			SURVIVOR,
			"ent_row",
		);
		expect(patch).toEqual({
			rel: [{ value: SURVIVOR, label: "Dana" }],
			single: { id: SURVIVOR },
			alt: { entityId: SURVIVOR },
		});
	});

	it("collapses a rewritten loser onto an existing survivor entry (no duplicate)", () => {
		const patch = rewriteEntityRefs({ links: [SURVIVOR, LOSER] }, losers, SURVIVOR, "ent_x");
		expect(patch).toEqual({ links: [SURVIVOR] });
	});

	it("collapses two losers in one array to a single survivor entry", () => {
		const patch = rewriteEntityRefs({ links: [LOSER, LOSER2, OTHER] }, losers, SURVIVOR, "ent_x");
		expect(patch).toEqual({ links: [SURVIVOR, OTHER] });
	});

	it("drops a ref that would become a self-reference on the survivor itself", () => {
		const patch = rewriteEntityRefs(
			{ links: [LOSER, OTHER], mentor: LOSER2 },
			losers,
			SURVIVOR,
			SURVIVOR,
		);
		expect(patch).toEqual({ links: [OTHER], mentor: null });
	});

	it("never rewrites a string that merely CONTAINS a loser id", () => {
		const props = { bio: `met via ${LOSER} import`, name: LOSER.slice(0, 5) };
		expect(rewriteEntityRefs(props, losers, SURVIVOR, "ent_x")).toBeNull();
	});

	it("leaves non-string leaves (numbers, booleans, null) untouched", () => {
		const props = { birthday: 123, active: true, note: null, assignee: LOSER };
		const patch = rewriteEntityRefs(props, losers, SURVIVOR, "ent_x");
		expect(patch).toEqual({ assignee: SURVIVOR });
	});

	it("is idempotent — rewriting the patched bag again is a no-op", () => {
		const props = { links: [LOSER, OTHER], company: LOSER2 };
		const patch = rewriteEntityRefs(props, losers, SURVIVOR, "ent_x");
		expect(patch).not.toBeNull();
		const applied = { ...props, ...patch };
		expect(rewriteEntityRefs(applied, losers, SURVIVOR, "ent_x")).toBeNull();
	});
});
