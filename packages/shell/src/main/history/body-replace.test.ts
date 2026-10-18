import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { bodyPlainText, bodyRoot, cloneType, replaceBody } from "./body-replace";

/** A body shaped like `@lexical/yjs` writes it: block XmlTexts with `__type`
 *  attributes, a text-node property map before each run, a decorator element. */
function lexicalDoc(paragraphs: string[], extra?: (root: Y.XmlText) => void): Y.Doc {
	const doc = new Y.Doc();
	const root = bodyRoot(doc);
	doc.transact(() => {
		paragraphs.forEach((text, i) => {
			const p = new Y.XmlText();
			p.setAttribute("__type", "paragraph");
			p.setAttribute("__format", String(i));
			const props = new Y.Map<unknown>();
			props.set("__type", "text");
			props.set("__style", "");
			p.insertEmbed(0, props);
			p.insert(1, text, { bold: i === 0 ? true : null });
			root.insertEmbed(root.length, p);
		});
		const deco = new Y.XmlElement("decorator");
		deco.setAttribute("__type", "image");
		deco.setAttribute("src", "brainstorm://asset/a1");
		root.insertEmbed(root.length, deco);
		extra?.(root);
	});
	return doc;
}

function deep(value: unknown): unknown {
	if (value instanceof Y.XmlText) {
		return {
			xmlText: value.getAttributes(),
			delta: (value.toDelta() as Array<{ insert: unknown; attributes?: unknown }>).map((op) => ({
				insert: deep(op.insert),
				attributes: op.attributes ?? null,
			})),
		};
	}
	if (value instanceof Y.XmlElement) {
		return { el: value.nodeName, attrs: value.getAttributes(), kids: value.toArray().map(deep) };
	}
	if (value instanceof Y.Map) return { map: value.toJSON() };
	return value;
}

describe("replaceBody", () => {
	it("makes the live body equal the checkpoint body, attributes and embeds included", () => {
		const checkpoint = lexicalDoc(["First version", "second para"]);
		const live = lexicalDoc(["Totally different", "edited", "more"]);
		replaceBody(live, checkpoint);
		expect(deep(bodyRoot(live))).toEqual(deep(bodyRoot(checkpoint)));
	});

	it("emits ONE update that a third replica can apply to converge", () => {
		const checkpoint = lexicalDoc(["Old text"]);
		const live = lexicalDoc(["New text"]);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		const updates: Uint8Array[] = [];
		live.on("update", (u: Uint8Array) => updates.push(u));
		replaceBody(live, checkpoint);
		expect(updates).toHaveLength(1);
		Y.applyUpdate(peer, updates[0] as Uint8Array);
		expect(deep(bodyRoot(peer))).toEqual(deep(bodyRoot(checkpoint)));
	});

	it("is a forward edit: a concurrent edit on another replica merges instead of failing", () => {
		const checkpoint = lexicalDoc(["Old"]);
		const live = lexicalDoc(["Now"]);
		const peer = new Y.Doc();
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		peer.transact(() => bodyRoot(peer).insert(0, "peer-typed "));
		replaceBody(live, checkpoint);
		Y.applyUpdate(live, Y.encodeStateAsUpdate(peer));
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
		expect(deep(bodyRoot(live))).toEqual(deep(bodyRoot(peer)));
		expect(bodyPlainText(live)).toContain("Old");
	});

	it("empties the body when the checkpoint had none", () => {
		const live = lexicalDoc(["Something"]);
		replaceBody(live, new Y.Doc());
		expect(bodyRoot(live).length).toBe(0);
	});

	it("leaves the property / link roots alone", () => {
		const live = lexicalDoc(["x"]);
		live.getMap("brainstorm.props").set("title", "kept");
		replaceBody(live, lexicalDoc(["y"]));
		expect(live.getMap("brainstorm.props").get("title")).toBe("kept");
	});

	it("does not alias the source: editing the checkpoint after does not touch the live doc", () => {
		const checkpoint = lexicalDoc(["Old"]);
		const live = new Y.Doc();
		replaceBody(live, checkpoint);
		const before = JSON.stringify(deep(bodyRoot(live)));
		checkpoint.transact(() => bodyRoot(checkpoint).insert(0, "zzz"));
		expect(JSON.stringify(deep(bodyRoot(live)))).toBe(before);
	});
});

describe("cloneType", () => {
	it("deep-copies maps, arrays and texts", () => {
		const doc = new Y.Doc();
		const m = doc.getMap<unknown>("m");
		doc.transact(() => {
			const inner = new Y.Array<unknown>();
			inner.push([1, { a: 2 }]);
			m.set("arr", inner);
			const t = new Y.Text();
			t.insert(0, "hi", { italic: true });
			m.set("text", t);
			const frag = new Y.XmlFragment();
			frag.insert(0, [new Y.XmlElement("p")]);
			m.set("frag", frag);
		});
		const target = new Y.Doc();
		target.getMap<unknown>("m").set("copy", cloneType(m));
		expect((target.getMap<unknown>("m").get("copy") as Y.Map<unknown>).toJSON()).toEqual(m.toJSON());
	});
});

describe("bodyPlainText", () => {
	it("flattens blocks to lines and ignores property maps and decorators", () => {
		expect(bodyPlainText(lexicalDoc(["Hello", "World"]))).toBe("Hello\nWorld");
	});
	it("caps the preview", () => {
		expect(bodyPlainText(lexicalDoc(["a".repeat(500)]), 100).length).toBeLessThanOrEqual(100);
	});
	it("is empty for an empty doc", () => {
		expect(bodyPlainText(new Y.Doc())).toBe("");
	});
});
