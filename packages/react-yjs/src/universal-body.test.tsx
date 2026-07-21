// @vitest-environment jsdom
import { UNIVERSAL_BODY_FRAGMENT_NAME } from "@brainstorm-os/sdk-types";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getUniversalBody, useUniversalBody } from "./universal-body";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("getUniversalBody", () => {
	it("returns the Y.XmlText named UNIVERSAL_BODY_FRAGMENT_NAME (Yjs caches by name → identity)", () => {
		const doc = new Y.Doc();
		const a = getUniversalBody(doc);
		const b = doc.get(UNIVERSAL_BODY_FRAGMENT_NAME, Y.XmlText);
		const c = getUniversalBody(doc);

		expect(a).toBe(b);
		expect(a).toBe(c);
	});

	it("is universal — callable on any fresh doc regardless of what other state is present", () => {
		for (let i = 0; i < 10; i++) {
			const doc = new Y.Doc();
			if (i % 2 === 0) doc.getMap("properties").set("title", `note-${i}`);
			if (i % 3 === 0) doc.getArray("tags").push(["x"]);

			const body = getUniversalBody(doc);
			expect(body).toBeDefined();
			expect(body).toBeInstanceOf(Y.XmlText);
		}
	});

	it("lazy semantics — an UNUSED universal body adds zero encoded bytes (the load-bearing storage claim)", () => {
		// Property: for every fresh doc, calling getUniversalBody (which
		// materialises the in-memory Yjs root handle) MUST NOT change the
		// encoded state. The unused body is zero on-disk cost — pinned by
		//  §Universal rich-text body. clientID is held fixed
		// across the pair so the VarUint encoding of the doc id is
		// byte-identical between baseline and observed. The type change
		// from XmlFragment to XmlText preserves the invariant — Yjs only
		// emits encoded state for a root once it carries content.
		for (let i = 0; i < 32; i++) {
			const baseline = new Y.Doc();
			baseline.clientID = i + 1;
			const baselineBytes = Y.encodeStateAsUpdate(baseline);

			const observed = new Y.Doc();
			observed.clientID = i + 1;
			getUniversalBody(observed);
			const observedBytes = Y.encodeStateAsUpdate(observed);

			expect(observedBytes.length).toBe(baselineBytes.length);
			expect(observedBytes).toEqual(baselineBytes);
		}
	});

	it("lazy semantics — only a real write to the body inflates the encoded state", () => {
		const doc = new Y.Doc();
		doc.clientID = 1;
		const beforeBody = Y.encodeStateAsUpdate(doc).length;
		doc.getMap("properties").set("title", "untouched-body");
		const afterPropertyWrite = Y.encodeStateAsUpdate(doc).length;
		expect(afterPropertyWrite).toBeGreaterThan(beforeBody);

		const body = getUniversalBody(doc);
		body.insert(0, "hello universal body");
		const afterBodyWrite = Y.encodeStateAsUpdate(doc).length;
		expect(afterBodyWrite).toBeGreaterThan(afterPropertyWrite);
	});

	it("roundtrip — writes to the body re-materialise verbatim on a fresh doc via Y.applyUpdate", () => {
		const writer = new Y.Doc();
		const body = getUniversalBody(writer);
		body.insert(0, "hello universal body");

		const update = Y.encodeStateAsUpdate(writer);

		const reader = new Y.Doc();
		Y.applyUpdate(reader, update);
		const readerBody = getUniversalBody(reader);

		expect(readerBody.toString()).toBe(body.toString());
		expect(readerBody.toString()).toBe("hello universal body");
	});
});

describe("useUniversalBody", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	async function render(node: ReactNode): Promise<void> {
		await act(async () => {
			root.render(node);
		});
	}
	async function step(fn: () => void): Promise<void> {
		await act(async () => {
			fn();
		});
	}

	it("returns the same XmlText as getUniversalBody and re-renders on body mutation", async () => {
		const doc = new Y.Doc();
		const seen: Y.XmlText[] = [];
		function View() {
			const body = useUniversalBody(doc);
			seen.push(body);
			return <span>{body.length}</span>;
		}

		await render(<View />);
		expect(seen.at(-1)).toBe(getUniversalBody(doc));
		expect(container.textContent).toBe("0");

		await step(() => {
			const body = getUniversalBody(doc);
			body.insert(0, "x");
		});
		expect(container.textContent).toBe("1");
		// All renders observed the same root instance.
		expect(new Set(seen).size).toBe(1);
	});
});
