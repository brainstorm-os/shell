// @vitest-environment jsdom
/**
 * MentionComposerPlugin — the `@`-mention bridge for CompactEditor surfaces.
 * These tests drive the imperative `trigger()` path (the "+ → Mention"
 * affordance): the typeahead opens over the host's candidates and committing a
 * row rewrites the `@token` per the configured commit mode. The fancy-menus
 * runtime is mocked — the plugin's contract with it is data (items + onSelect),
 * not DOM.
 */

import { AttachmentKind } from "@brainstorm/sdk-types";
import type { ContextCandidate } from "@brainstorm/sdk/composer-context";
import { createRef } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CompactEditor,
	type CompactEditorHandle,
	type CompactEditorPayload,
} from "./compact-editor";
import { type MentionComposerHandle, MentionComposerPlugin } from "./mention-composer-plugin";
import { MentionNode } from "./nodes/mention-node";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openTypeaheadMenu = vi.hoisted(() => vi.fn());
vi.mock("@brainstorm/sdk/menus", () => ({
	openTypeaheadMenu,
	closeTypeaheadMenu: vi.fn(),
	setTypeaheadActiveIndex: vi.fn(),
}));

const RAZOR: ContextCandidate = {
	id: "ed25519:abc",
	kind: AttachmentKind.Person,
	label: "Razor",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers();
	openTypeaheadMenu.mockClear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

function mount(opts: { insertNode?: boolean; onSelect?: (c: ContextCandidate) => void }): {
	mention: React.RefObject<MentionComposerHandle | null>;
	payload: () => CompactEditorPayload;
} {
	const mention = createRef<MentionComposerHandle>();
	let last: CompactEditorPayload = { state: "", text: "", html: "", isEmpty: true };
	act(() => {
		root.render(
			<CompactEditor
				additionalNodes={[MentionNode]}
				onChange={(p) => {
					last = p;
				}}
			>
				<MentionComposerPlugin
					ref={mention}
					host={{ searchCandidates: () => Promise.resolve([RAZOR]) }}
					onSelect={opts.onSelect ?? (() => {})}
					ariaLabel="People"
					emptyLabel="No matches"
					{...(opts.insertNode ? { insertNode: true } : {})}
				/>
			</CompactEditor>,
		);
	});
	return { mention, payload: () => last };
}

/** trigger() inserts the `@`, the debounce fires the host search, and the
 *  typeahead opens with the host's rows; committing a row goes through the
 *  captured `onSelect(id)`. */
async function triggerAndCommit(mention: React.RefObject<MentionComposerHandle | null>) {
	await act(async () => {
		mention.current?.trigger();
	});
	await act(async () => {
		vi.advanceTimersByTime(200);
		await Promise.resolve();
	});
	const call = openTypeaheadMenu.mock.calls.at(-1)?.[0] as
		| { items: { id: string }[]; onSelect: (id: string) => void }
		| undefined;
	expect(call).toBeDefined();
	expect(call?.items[0]?.id).toBe(RAZOR.id);
	await act(async () => {
		call?.onSelect(RAZOR.id);
	});
}

describe("MentionComposerPlugin — commit modes", () => {
	it("default mode excises the @token and reports the candidate", async () => {
		const onSelect = vi.fn();
		const { mention, payload } = mount({ onSelect });
		await triggerAndCommit(mention);
		expect(onSelect).toHaveBeenCalledWith(RAZOR);
		expect(payload().text).toBe("");
	});

	it("insertNode mode replaces the @token with an inline MentionNode + space", async () => {
		const { mention, payload } = mount({ insertNode: true });
		await triggerAndCommit(mention);
		const state = JSON.parse(payload().state) as {
			root: { children: { children?: { type: string; entityId?: string; label?: string }[] }[] };
		};
		const inline = state.root.children[0]?.children ?? [];
		const chip = inline.find((n) => n.type === "mention");
		expect(chip?.entityId).toBe(RAZOR.id);
		expect(chip?.label).toBe("Razor");
		// The plain-text flattening reads `@Razor ` — what agents/search see.
		expect(payload().text).toBe("@Razor ");
	});
});
