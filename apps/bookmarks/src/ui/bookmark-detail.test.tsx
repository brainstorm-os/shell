// @vitest-environment happy-dom
import { YDocProvider, createYDocResolver, getUniversalBody } from "@brainstorm-os/react-yjs";
import type { SerializedBlock } from "@brainstorm-os/sdk-types";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Doc } from "yjs";
import { CaptureState } from "../logic/capture-state";
import type { Bookmark } from "../types/bookmark";
import { BookmarkDetail } from "./bookmark-detail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const para = (text: string): SerializedBlock => ({
	type: "paragraph",
	version: 1,
	direction: null,
	format: "",
	indent: 0,
	children: [{ type: "text", version: 1, text, format: 0, detail: 0, mode: "normal", style: "" }],
});

const heading = (text: string): SerializedBlock => ({
	type: "heading",
	version: 1,
	tag: "h1",
	direction: null,
	format: "",
	indent: 0,
	children: [{ type: "text", version: 1, text, format: 0, detail: 0, mode: "normal", style: "" }],
});

const baseBookmark = (id: string): Bookmark => ({
	id,
	url: "https://example.test/article",
	title: "An article",
	faviconUrl: null,
	coverImageUrl: null,
	tags: [],
	savedAt: 1,
	readAt: null,
	archivedAt: null,
	colorHint: null,
	createdAt: 1,
	updatedAt: 1,
});

const noop = () => {};
const settle = () =>
	act(async () => {
		await new Promise((r) => setTimeout(r, 30));
		await new Promise((r) => setTimeout(r, 30));
	});

// In-memory resolver (no transport persistence) that records the doc minted per
// entity id, so the test can introspect the UniversalBody the editor binds to.
// Two mounts on the same id share ONE doc via the resolver refcount — exactly
// the shell behaviour. Mirrors `apps/notes` editor.test.tsx `inMemoryResolver`.
function inMemoryResolver() {
	const docs = new Map<string, Doc>();
	const api = createYDocResolver({
		load: async () => null,
		persist: () => {},
		release: () => {},
	});
	const resolve: typeof api.resolve = (id) => {
		const handle = api.resolve(id);
		docs.set(id, handle.doc);
		return handle;
	};
	return { resolve, docs, dispose: api.dispose };
}

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let resolver: ReturnType<typeof inMemoryResolver>;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	resolver = inMemoryResolver();
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	resolver.dispose();
});

const detail = (
	bookmark: Bookmark,
	props: Partial<Parameters<typeof BookmarkDetail>[0]> = {},
): ReactNode => (
	<YDocProvider resolver={resolver.resolve}>
		<BookmarkDetail
			bookmark={bookmark}
			onPropertyChange={noop}
			covers={null}
			properties={null}
			showProperties={false}
			onToggleProperties={noop}
			captureState={CaptureState.Captured}
			onCapture={noop}
			{...props}
		/>
	</YDocProvider>
);

const renderDetail = async (node: ReactNode) => {
	await act(async () => {
		root.render(node);
	});
	await settle();
};

const editorBlockCount = () => host.querySelector(".bm-detail__editor")?.children.length ?? 0;
const bodyText = (id: string) => getUniversalBody(resolver.docs.get(id) as Doc).toString();

/** Drive a real user-style edit through the live Lexical editor. */
const driveEdit = async (text: string): Promise<void> => {
	const ce = host.querySelector(".bm-detail__editor") as
		| (HTMLElement & { __lexicalEditor?: { update: (fn: () => void) => void } })
		| null;
	const editor = ce?.__lexicalEditor;
	if (!editor) throw new Error("no live Lexical editor mounted");
	const { $getRoot, $createParagraphNode, $createTextNode } = await import("lexical");
	await act(async () => {
		editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode(text)));
		});
	});
};

describe("BookmarkDetail — UniversalBody editor (9.18.7)", () => {
	it("binds the editor to the bookmark's UniversalBody Y.Doc via the resolver", async () => {
		const bookmark = baseBookmark("bm-bind");
		await renderDetail(detail(bookmark));
		expect(resolver.docs.has("bm-bind")).toBe(true);
		expect(host.querySelector(".bm-detail__editor")).not.toBeNull();
	});

	it("seeds the body with every captured block, not one", async () => {
		const bookmark: Bookmark = {
			...baseBookmark("bm-seed"),
			contentBlocks: [heading("Title"), para("First"), para("Second")],
			contentFetchedAt: 1000,
		};
		await renderDetail(detail(bookmark));
		expect(editorBlockCount()).toBe(3);
		expect(bodyText("bm-seed")).toContain("First");
	});

	it("persists edits into the UniversalBody (round-trips through the doc)", async () => {
		const bookmark = baseBookmark("bm-edit");
		await renderDetail(detail(bookmark));
		await driveEdit("a user note");
		expect(bodyText("bm-edit")).toContain("a user note");
	});

	it("re-binds to a different doc when the open bookmark switches", async () => {
		const a = { ...baseBookmark("bm-a"), contentBlocks: [para("Alpha body")], contentFetchedAt: 1 };
		await renderDetail(detail(a));
		expect(host.querySelector(".bm-detail__editor")?.textContent).toContain("Alpha body");

		const b = { ...baseBookmark("bm-b"), contentBlocks: [para("Beta body")], contentFetchedAt: 1 };
		await renderDetail(detail(b));
		expect(resolver.docs.has("bm-a")).toBe(true);
		expect(resolver.docs.has("bm-b")).toBe(true);
		expect(host.querySelector(".bm-detail__editor")?.textContent).toContain("Beta body");
		expect(host.querySelector(".bm-detail__editor")?.textContent).not.toContain("Alpha body");
	});

	it("re-seeds when content is captured while the detail is open", async () => {
		const empty = baseBookmark("bm-recap");
		await renderDetail(detail(empty));
		expect(editorBlockCount()).toBe(1);

		const captured: Bookmark = {
			...empty,
			contentBlocks: [heading("Captured"), para("Body one"), para("Body two")],
			contentFetchedAt: 2000,
			updatedAt: 2000,
		};
		await renderDetail(detail(captured));
		await settle();

		expect(host.querySelector(".bm-detail__editor")?.textContent).toContain("Captured");
		expect(bodyText("bm-recap")).toContain("Captured");
	});

	it("clears the body when content is forgotten (epoch → 0)", async () => {
		const captured: Bookmark = {
			...baseBookmark("bm-forget"),
			contentBlocks: [para("Forget me")],
			contentFetchedAt: 3000,
		};
		await renderDetail(detail(captured));
		expect(host.querySelector(".bm-detail__editor")?.textContent).toContain("Forget me");

		const { contentBlocks: _b, contentFetchedAt: _f, ...rest } = captured;
		await renderDetail(detail(rest as Bookmark));
		await settle();
		expect(host.querySelector(".bm-detail__editor")?.textContent).not.toContain("Forget me");
	});

	it("renders the title as a link to the source URL", async () => {
		const bookmark = baseBookmark("bm-link");
		await renderDetail(detail(bookmark));
		const link = host.querySelector(".bm-detail__title-link") as HTMLAnchorElement | null;
		expect(link).not.toBeNull();
		expect(link?.getAttribute("href")).toBe(bookmark.url);
		expect(link?.textContent).toBe(bookmark.title);
	});
});
