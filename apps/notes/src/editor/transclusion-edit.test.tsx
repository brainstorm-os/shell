// @vitest-environment jsdom

/**
 * B11.22 — editing a transclusion in place. The nested body mounts a real
 * Yjs-bound `<BrainstormEditor>` over the SOURCE's doc; the explicit
 * "Edit here" mode flips it editable only when the host is editable, Notes
 * holds the source, and the source isn't locked.
 */

import { isEventInNestedEditor } from "@brainstorm-os/editor";
import { YDocProvider, createYDocResolver } from "@brainstorm-os/react-yjs";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "yjs";
import {
	TransclusionEditState,
	renderTransclusionBody,
	resolveTransclusionEditState,
} from "./transclusion-body";
import { type TransclusionEditHost, TransclusionEditProvider } from "./transclusion-edit-host";
import { TransclusionRenderProvider } from "./transclusion-render-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = "n_source";
const HOST = "n_host";

describe("resolveTransclusionEditState", () => {
	const base = { hostEditable: true, canEdit: true, locked: false, requested: false };
	it("is unavailable under a read-only host or a source Notes doesn't hold", () => {
		expect(resolveTransclusionEditState({ ...base, hostEditable: false })).toBe(
			TransclusionEditState.Unavailable,
		);
		expect(resolveTransclusionEditState({ ...base, canEdit: false, requested: true })).toBe(
			TransclusionEditState.Unavailable,
		);
	});
	it("is locked (never editing) when the source is locked, even if requested", () => {
		expect(resolveTransclusionEditState({ ...base, locked: true, requested: true })).toBe(
			TransclusionEditState.Locked,
		);
	});
	it("edits only on request", () => {
		expect(resolveTransclusionEditState(base)).toBe(TransclusionEditState.ReadOnly);
		expect(resolveTransclusionEditState({ ...base, requested: true })).toBe(
			TransclusionEditState.Editing,
		);
	});
});

describe("isEventInNestedEditor", () => {
	it("flags events from a Lexical root nested inside the host root only", () => {
		const host = document.createElement("div");
		host.setAttribute("data-lexical-editor", "true");
		const nested = document.createElement("div");
		nested.setAttribute("data-lexical-editor", "true");
		const text = document.createElement("span");
		nested.append(text);
		const own = document.createElement("span");
		host.append(nested, own);
		const fire = (target: Element) => {
			const event = new KeyboardEvent("keydown");
			Object.defineProperty(event, "target", { value: target });
			return event;
		};
		expect(isEventInNestedEditor(fire(text), host)).toBe(true);
		expect(isEventInNestedEditor(fire(own), host)).toBe(false);
		expect(isEventInNestedEditor(fire(text), nested)).toBe(false);
		expect(isEventInNestedEditor(fire(document.body), host)).toBe(false);
		expect(isEventInNestedEditor(fire(text), null)).toBe(false);
	});
});

describe("transclusion body edit mode", () => {
	let container: HTMLDivElement;
	let root: Root;
	let docs: Map<string, Doc>;
	let resolver: ReturnType<typeof createYDocResolver>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		docs = new Map();
		resolver = createYDocResolver({ load: async () => null, persist: () => {}, release: () => {} });
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		resolver.dispose();
	});

	function host(overrides: Partial<TransclusionEditHost> = {}): TransclusionEditHost {
		return {
			canEdit: (id) => id === SOURCE,
			isLocked: () => false,
			onSourceChange: vi.fn(),
			...overrides,
		};
	}

	async function render(
		editHost: TransclusionEditHost | null,
		hostEditable: boolean,
	): Promise<void> {
		const resolve: typeof resolver.resolve = (id) => {
			const handle = resolver.resolve(id);
			docs.set(id, handle.doc);
			return handle;
		};
		const tree: ReactNode = (
			<YDocProvider resolver={resolve}>
				<TransclusionEditProvider value={editHost}>
					<TransclusionRenderProvider
						ancestorChain={[HOST]}
						renderBody={renderTransclusionBody}
						editable={hostEditable}
					>
						{renderTransclusionBody({ entityId: SOURCE, entityType: "", chain: [HOST] })}
					</TransclusionRenderProvider>
				</TransclusionEditProvider>
			</YDocProvider>
		);
		await act(async () => root.render(tree));
		await act(async () => {
			await Promise.resolve();
		});
	}

	const toggle = () =>
		container.querySelector<HTMLButtonElement>(".notes__transclusion-edit-toggle");
	const state = () =>
		container.querySelector(".notes__transclusion-edit")?.getAttribute("data-edit-state");
	const editableRoot = () =>
		container.querySelector(".notes__transclusion-body-content")?.getAttribute("contenteditable");

	it("binds the nested editor to the SOURCE's doc, read-only until asked", async () => {
		await render(host(), true);
		expect(docs.has(SOURCE)).toBe(true);
		expect(docs.has(HOST)).toBe(false);
		expect(state()).toBe(TransclusionEditState.ReadOnly);
		expect(editableRoot()).toBe("false");
		expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
	});

	it("'Edit here' makes the body editable with a visible boundary; 'Done' ends it", async () => {
		await render(host(), true);
		await act(async () => toggle()?.click());
		expect(state()).toBe(TransclusionEditState.Editing);
		expect(editableRoot()).toBe("true");
		expect(container.querySelector(".notes__transclusion-edit--active")).not.toBeNull();
		expect(container.querySelector(".notes__transclusion-edit-badge")).not.toBeNull();
		expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
		await act(async () => toggle()?.click());
		expect(editableRoot()).toBe("false");
	});

	it("keeps a locked source read-only, with a disabled toggle that says why", async () => {
		await render(host({ isLocked: () => true }), true);
		expect(state()).toBe(TransclusionEditState.Locked);
		expect(toggle()?.disabled).toBe(true);
		expect(toggle()?.title).toMatch(/locked/i);
		expect(editableRoot()).toBe("false");
	});

	it("drops back to read-only when the source is locked mid-edit", async () => {
		let locked = false;
		const editHost = host({ isLocked: () => locked });
		await render(editHost, true);
		await act(async () => toggle()?.click());
		expect(editableRoot()).toBe("true");
		locked = true;
		await render({ ...editHost }, true);
		expect(state()).toBe(TransclusionEditState.Locked);
		expect(editableRoot()).toBe("false");
	});

	it("offers no edit mode under a read-only host or without an edit host", async () => {
		await render(host(), false);
		expect(toggle()).toBeNull();
		expect(editableRoot()).toBe("false");
		await render(null, true);
		expect(toggle()).toBeNull();
	});
});
