import type { SerializedEditorState } from "lexical";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BASELINE_NODES } from "./nodes";
import { plantSerializedStateIntoDoc } from "./plant-state";
import { SEED_STANDIN_NODES } from "./seed-nodes";
import { serializedStateToMarkdown } from "./serialize-markdown";
import { serializedStateFromDoc } from "./serialized-state-from-doc";

const text = (t: string, format = 0) => ({
	type: "text",
	version: 1,
	detail: 0,
	format,
	mode: "normal",
	style: "",
	text: t,
});
const element = (type: string, children: unknown[], extra: Record<string, unknown> = {}) => ({
	type,
	version: 1,
	direction: "ltr",
	format: "",
	indent: 0,
	children,
	...extra,
});

function state(children: unknown[]): SerializedEditorState {
	return { root: element("root", children) } as unknown as SerializedEditorState;
}

/** Plant, ship as an update, and re-hydrate a fresh doc — the shape main
 *  process export sees after `ydocStore.load`. */
function hydrated(children: unknown[]): Y.Doc {
	const src = new Y.Doc();
	plantSerializedStateIntoDoc(src, state(children), {
		nodes: [...BASELINE_NODES, ...SEED_STANDIN_NODES],
	});
	const out = new Y.Doc();
	Y.applyUpdate(out, Y.encodeStateAsUpdate(src));
	src.destroy();
	return out;
}

describe("serializedStateFromDoc", () => {
	it("returns null for a doc with no body", () => {
		expect(serializedStateFromDoc(new Y.Doc())).toBeNull();
	});

	it("reads headings, inline marks, links, line breaks and lists back out", () => {
		const doc = hydrated([
			element("heading", [text("Plan")], { tag: "h2" }),
			element("paragraph", [
				text("Ship "),
				text("now", 1),
				{ type: "linebreak", version: 1 },
				element("link", [text("docs")], { url: "https://example.com", rel: null, target: null }),
			]),
			element(
				"list",
				[
					element("listitem", [text("one")], { value: 1 }),
					element("listitem", [text("two")], { value: 2 }),
				],
				{ listType: "bullet", start: 1, tag: "ul" },
			),
		]);
		const read = serializedStateFromDoc(doc);
		expect(read?.root?.type).toBe("root");
		expect(serializedStateToMarkdown(read)).toBe(
			"## Plan\n\nShip **now**  \n[docs](https://example.com)\n\n- one\n- two",
		);
	});

	it("keeps unknown decorator nodes with their properties (mentions survive)", () => {
		const doc = hydrated([
			element("paragraph", [
				text("see "),
				{ type: "mention", version: 1, entityId: "ent_9", entityType: "x/Note/v1", label: "Roadmap" },
			]),
			{ type: "horizontalrule", version: 1 },
		]);
		const read = serializedStateFromDoc(doc);
		const blocks = read?.root?.children as Array<Record<string, unknown>>;
		const paragraph = blocks[0]?.children as Array<Record<string, unknown>>;
		expect(paragraph[1]).toMatchObject({ type: "mention", entityId: "ent_9", label: "Roadmap" });
		expect(blocks[1]?.type).toBe("horizontalrule");
	});
});
