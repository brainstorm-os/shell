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

	it("REJECTS a body carrying bidi overrides or C1 controls instead of stripping them", () => {
		// A right-to-left override makes the RENDERED diff differ from the bytes
		// the caller applies — the same divergence the length cap refuses.
		const RLO = String.fromCharCode(0x202e);
		const LRI = String.fromCharCode(0x2066);
		const C1 = String.fromCharCode(0x85);
		const NUL = String.fromCharCode(0x00);
		expect(parseToolProposal({ changes: [change({ after: `transfer ${RLO}999` })] })).toBeNull();
		expect(parseToolProposal({ changes: [change({ before: `old ${LRI}words` })] })).toBeNull();
		expect(parseToolProposal({ changes: [change({ after: `new${C1}words` })] })).toBeNull();
		expect(parseToolProposal({ changes: [change({ after: `new${NUL}words` })] })).toBeNull();
	});

	it("keeps newlines, tabs and emoji joiners — a body is multi-line text", () => {
		const body = "para one\n\n\tindented\n👩‍👩‍👧";
		expect(parseToolProposal({ changes: [change({ after: body })] })?.changes[0]?.after).toBe(body);
	});

	it("rejects a prototype-slot key", () => {
		for (const key of ["__proto__", "constructor", "prototype"]) {
			expect(parseToolProposal({ changes: [{ key, after: "owned" }] })).toBeNull();
		}
	});

	it("snapshots the change list so an evil iterator cannot outrun the cap", () => {
		// `length` reads as 1, but iterating yields far more than the cap allows.
		const evil: unknown[] = [change()];
		Object.defineProperty(evil, Symbol.iterator, {
			value: function* () {
				for (let i = 0; i < TOOL_PROPOSAL_CHANGES_MAX + 50; i += 1) yield change();
			},
		});
		expect(parseToolProposal({ changes: evil })?.changes).toHaveLength(1);
	});

	it("reads the change list once — a re-reading getter cannot swap it after the cap check", () => {
		let reads = 0;
		const wire = {
			get changes() {
				reads += 1;
				return reads === 1
					? [change()]
					: Array.from({ length: TOOL_PROPOSAL_CHANGES_MAX + 50 }, () => change());
			},
		};
		expect(parseToolProposal(wire)?.changes).toHaveLength(1);
		expect(reads).toBe(1);
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
