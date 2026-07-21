import { AttachmentKind } from "@brainstorm-os/sdk-types";
// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ComposerContextState, useComposerContext } from "./use-composer-context";

let container: HTMLDivElement;
let root: Root;
let api: ComposerContextState;

function Harness() {
	api = useComposerContext();
	return null;
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => root.render(<Harness />));
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const entity = (ref: string) => ({ kind: AttachmentKind.Entity as const, ref, label: ref });

describe("useComposerContext", () => {
	it("starts empty", () => {
		expect(api.attachments).toEqual([]);
	});

	it("adds attachments in order and reports has()", () => {
		act(() => {
			api.add(entity("a"));
			api.add(entity("b"));
		});
		expect(api.attachments.map((a) => a.ref)).toEqual(["a", "b"]);
		expect(api.has("a")).toBe(true);
		expect(api.has("z")).toBe(false);
	});

	it("dedupes by ref (a second add of the same ref is a no-op)", () => {
		let firstAdd = true;
		act(() => {
			firstAdd = api.add(entity("a"));
		});
		let secondAdd = true;
		act(() => {
			secondAdd = api.add(entity("a"));
		});
		expect(firstAdd).toBe(true);
		expect(secondAdd).toBe(false);
		expect(api.attachments).toHaveLength(1);
	});

	it("removes by ref", () => {
		act(() => {
			api.add(entity("a"));
			api.add(entity("b"));
		});
		act(() => api.remove("a"));
		expect(api.attachments.map((a) => a.ref)).toEqual(["b"]);
	});

	it("clears all", () => {
		act(() => {
			api.add(entity("a"));
			api.add(entity("b"));
		});
		act(() => api.clear());
		expect(api.attachments).toEqual([]);
	});
});
