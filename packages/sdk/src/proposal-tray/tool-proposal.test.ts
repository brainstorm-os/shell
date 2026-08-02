/**
 * Tool-8b — the `proposes-write` result parser.
 *
 * The contract pinned here: a proposal is provider-authored untrusted data,
 * so the parser copies known fields into a fresh object, screens every
 * single-line string, and REJECTS (never truncates) anything over its caps —
 * a human approves these exact bytes.
 */

import { describe, expect, it } from "vitest";
import {
	TOOL_PROPOSAL_CHANGES_MAX,
	TOOL_PROPOSAL_LABEL_MAX,
	TOOL_PROPOSAL_SUMMARY_MAX,
	TOOL_PROPOSAL_TEXT_MAX,
	parseToolProposal,
} from "./tool-proposal";

const change = (over: Record<string, unknown> = {}) => ({
	key: "text",
	before: "old words",
	after: "new words",
	...over,
});

describe("parseToolProposal", () => {
	it("parses a well-formed proposal into a fresh object", () => {
		const wire = { summary: "Rewrites the text", changes: [change()] };
		const parsed = parseToolProposal(wire);
		expect(parsed).not.toBeNull();
		expect(parsed?.summary).toBe("Rewrites the text");
		expect(parsed?.changes).toHaveLength(1);
		expect(parsed?.changes[0]).toEqual({ key: "text", before: "old words", after: "new words" });
		// A fresh object crosses into the UI — mutating the wire value later
		// must not reach what the user approves.
		expect(parsed?.changes[0]).not.toBe(wire.changes[0]);
	});

	it("accepts a change without before/label and without summary", () => {
		const parsed = parseToolProposal({ changes: [{ key: "body", after: "content" }] });
		expect(parsed).toEqual({ changes: [{ key: "body", after: "content" }] });
	});

	it("rejects non-objects, arrays, and missing/empty/oversized change lists", () => {
		expect(parseToolProposal(null)).toBeNull();
		expect(parseToolProposal("changes")).toBeNull();
		expect(parseToolProposal([change()])).toBeNull();
		expect(parseToolProposal({})).toBeNull();
		expect(parseToolProposal({ changes: [] })).toBeNull();
		expect(
			parseToolProposal({
				changes: Array.from({ length: TOOL_PROPOSAL_CHANGES_MAX + 1 }, () => change()),
			}),
		).toBeNull();
	});

	it("REJECTS an over-cap body instead of truncating it", () => {
		const over = "x".repeat(TOOL_PROPOSAL_TEXT_MAX + 1);
		expect(parseToolProposal({ changes: [change({ after: over })] })).toBeNull();
		expect(parseToolProposal({ changes: [change({ before: over })] })).toBeNull();
		// At the cap exactly is fine.
		const at = "x".repeat(TOOL_PROPOSAL_TEXT_MAX);
		expect(parseToolProposal({ changes: [change({ after: at })] })).not.toBeNull();
	});

	it("one malformed change poisons the whole proposal", () => {
		expect(parseToolProposal({ changes: [change(), { key: "", after: "ok" }] })).toBeNull();
		expect(parseToolProposal({ changes: [change(), { key: "k", after: 7 }] })).toBeNull();
	});

	it("screens the single-line fields and refuses ones that do not survive", () => {
		// Control/zero-width characters are stripped; a label that is ONLY those
		// is unusable and rejects the proposal rather than rendering blank chrome.
		const parsed = parseToolProposal({
			summary: "  spaced​ summary  ",
			changes: [change({ label: "Nice‮label" })],
		});
		expect(parsed?.summary).toBe("spaced summary");
		expect(parsed?.changes[0]?.label).toBe("Nicelabel");
		expect(parseToolProposal({ changes: [change({ label: "​​" })] })).toBeNull();
		expect(
			parseToolProposal({ summary: "s".repeat(TOOL_PROPOSAL_SUMMARY_MAX + 10), changes: [change()] }),
		).not.toBeNull(); // summary CLAMPS via sanitize (it is chrome, not approved bytes)
		expect(
			parseToolProposal({ changes: [change({ label: "l".repeat(TOOL_PROPOSAL_LABEL_MAX + 10) })] }),
		).not.toBeNull(); // label likewise clamps
	});

	it("ignores undeclared fields rather than ferrying them through", () => {
		const parsed = parseToolProposal({
			changes: [change({ html: "<script>x</script>" })],
			applyMode: "silent",
		});
		expect(parsed).not.toBeNull();
		expect(Object.keys(parsed?.changes[0] ?? {}).sort()).toEqual(["after", "before", "key"]);
		expect("applyMode" in (parsed ?? {})).toBe(false);
	});
});
