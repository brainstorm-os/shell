// @vitest-environment jsdom

import { type CommentDef, CommentKind } from "@brainstorm-os/sdk-types";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorT } from "../i18n";
import type { AddCommentInput, CommentsAdapter } from "./comments-adapter";
import { CommentsProvider } from "./comments-context";
import { type CommentsFocusRequest, CommentsPanel, commentTimeLabel } from "./comments-panel";

/** In-memory adapter — synchronous mutations so jsdom assertions need no clock. */
function fakeAdapter(): CommentsAdapter {
	let rows: CommentDef[] = [];
	const listeners = new Set<() => void>();
	let seq = 0;
	const notify = (): void => {
		for (const l of listeners) l();
	};
	return {
		list: () => rows,
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		async add(input: AddCommentInput) {
			seq += 1;
			rows = [
				...rows,
				{
					id: `c${seq}`,
					kind: input.kind ?? CommentKind.Comment,
					anchor: input.anchor,
					body: input.body,
					parentId: input.parentId ?? null,
					createdAt: seq,
					updatedAt: seq,
					resolvedAt: null,
					...(input.authorName !== undefined ? { authorName: input.authorName } : {}),
					...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
				},
			];
			notify();
		},
		async resolve(id) {
			rows = rows.map((c) => (c.id === id ? { ...c, resolvedAt: 100 } : c));
			notify();
		},
		async reopen(id) {
			rows = rows.map((c) => (c.id === id ? { ...c, resolvedAt: null } : c));
			notify();
		},
		async remove(id) {
			rows = rows.filter((c) => c.id !== id && c.parentId !== id);
			notify();
		},
		dispose() {},
	};
}

let container: HTMLDivElement;
let root: Root;
let adapter: CommentsAdapter;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	adapter = fakeAdapter();
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function render(
	authorName?: string,
	focusRequest?: CommentsFocusRequest,
	extra?: {
		pendingAnchor?: import("@brainstorm-os/sdk-types").CommentAnchor;
		onApplySuggestion?: (comment: CommentDef) => boolean | Promise<boolean>;
	},
): void {
	act(() => {
		root.render(
			<CommentsProvider adapter={adapter} {...(authorName !== undefined ? { authorName } : {})}>
				<CommentsPanel
					documentId="ent_doc"
					{...(focusRequest ? { focusRequest } : {})}
					{...(extra?.pendingAnchor ? { pendingAnchor: extra.pendingAnchor } : {})}
					{...(extra?.onApplySuggestion ? { onApplySuggestion: extra.onApplySuggestion } : {})}
				/>
			</CommentsProvider>,
		);
	});
}

function q<E extends Element = Element>(sel: string): E | null {
	return container.querySelector<E>(sel);
}
function el<E extends Element = Element>(sel: string): E {
	const found = container.querySelector<E>(sel);
	if (found === null) throw new Error(`missing element: ${sel}`);
	return found;
}
function qa(sel: string): Element[] {
	return [...container.querySelectorAll(sel)];
}

function type(el: HTMLTextAreaElement, value: string): void {
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		setter?.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** Type into a rich CompactEditor surface. Reaches the Lexical editor stashed
 *  on its contenteditable root (`__lexicalEditor`) and replaces the body —
 *  jsdom can't simulate real `beforeinput` editing into a contenteditable. */
function typeRich(wrapperSel: string, value: string): void {
	const content = el<HTMLElement>(`${wrapperSel} .bs-compact-editor__content`);
	const editor = (content as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
	if (!editor) throw new Error(`no Lexical editor on ${wrapperSel}`);
	act(() => {
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode(value));
				root.append(p);
			},
			{ discrete: true },
		);
	});
}

function submit(form: HTMLFormElement): void {
	act(() => {
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}

describe("CommentsPanel", () => {
	it("renders the empty state with the region landmark", () => {
		render();
		expect(q('[aria-label="Comments"]')).not.toBeNull();
		expect(q(".bs-comments__empty")?.textContent).toBe("No comments yet");
	});

	it("disables the submit button until the composer has content", () => {
		render();
		const submitBtn = q<HTMLButtonElement>(".bs-comments__submit");
		expect(submitBtn?.disabled).toBe(true);
		typeRich(".bs-comments__input--rich", "great point");
		expect(q<HTMLButtonElement>(".bs-comments__submit")?.disabled).toBe(false);
	});

	it("adds a comment anchored to the document, stamping the author", () => {
		render("Mira");
		typeRich(".bs-comments__input--rich", "great point");
		submit(el<HTMLFormElement>(".bs-comments__composer"));
		const list = adapter.list();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ body: "great point", authorName: "Mira" });
		expect(list[0]?.anchor.blockId).toBe("__document");
		expect(q(".bs-comments__thread")?.querySelector(".bs-comments__text")?.textContent).toBe(
			"great point",
		);
		expect(q(".bs-comments__author")?.textContent).toBe("Mira");
	});

	it("replies to a thread, nesting under the root", () => {
		render();
		typeRich(".bs-comments__input--rich", "root");
		submit(el<HTMLFormElement>(".bs-comments__composer"));
		const replyForm = el<HTMLFormElement>(".bs-comments__reply");
		typeRich(".bs-comments__reply", "a reply");
		submit(replyForm);
		expect(adapter.list().map((c) => c.body)).toEqual(["root", "a reply"]);
		expect(q(".bs-comments__comment--reply")?.textContent).toContain("a reply");
	});

	it("resolves a thread (hiding the reply box) then reopens it", () => {
		render();
		typeRich(".bs-comments__input--rich", "root");
		submit(el<HTMLFormElement>(".bs-comments__composer"));
		// Resolve: the action toggles to Reopen and the reply composer disappears.
		const actions = qa(".bs-comments__action");
		const resolveBtn = actions.find((b) => b.textContent === "Resolve") as HTMLButtonElement;
		act(() => resolveBtn.click());
		expect(q(".bs-comments__thread")?.getAttribute("data-resolved")).toBe("true");
		expect(q(".bs-comments__reply")).toBeNull();
		expect(qa(".bs-comments__action").some((b) => b.textContent === "Reopen")).toBe(true);
		// Reopen restores the open state.
		act(() =>
			(
				qa(".bs-comments__action").find((b) => b.textContent === "Reopen") as HTMLButtonElement
			).click(),
		);
		expect(q(".bs-comments__thread")?.getAttribute("data-resolved")).toBeNull();
	});

	it("scrolls and pulses the focused block's thread on a focus request", async () => {
		await adapter.add({ anchor: { entityId: "ent_doc", blockId: "blk1" }, body: "on blk1" });
		await adapter.add({ anchor: { entityId: "ent_doc", blockId: "blk2" }, body: "on blk2" });
		const scrollSpy = vi.fn();
		Element.prototype.scrollIntoView = scrollSpy;
		render();
		render(undefined, { blockId: "blk2", nonce: 1 });
		const focused = q('[data-block-id="blk2"]');
		expect(focused?.getAttribute("data-pulse")).toBe("true");
		expect(q('[data-block-id="blk1"]')?.getAttribute("data-pulse")).toBeNull();
		expect(scrollSpy).toHaveBeenCalled();
	});

	it("deletes a thread", () => {
		render();
		typeRich(".bs-comments__input--rich", "root");
		submit(el<HTMLFormElement>(".bs-comments__composer"));
		const del = qa(".bs-comments__action").find(
			(b) => b.textContent === "Delete",
		) as HTMLButtonElement;
		act(() => del.click());
		expect(adapter.list()).toHaveLength(0);
		expect(q(".bs-comments__empty")).not.toBeNull();
	});

	const SELECTION_ANCHOR = { entityId: "ent_doc", blockId: "blk1", quote: "old text" };

	it("creates a suggestion from the selection composer's suggest toggle", () => {
		render(undefined, undefined, { pendingAnchor: SELECTION_ANCHOR });
		const toggle = el<HTMLInputElement>('.bs-comments__suggest-toggle input[type="checkbox"]');
		act(() => toggle.click());
		typeRich(".bs-comments__input--rich", "tighter phrasing");
		type(el<HTMLTextAreaElement>(".bs-comments__input--replacement"), "new text");
		submit(el<HTMLFormElement>(".bs-comments__composer"));
		const created = adapter.list()[0];
		expect(created).toMatchObject({
			kind: CommentKind.Suggestion,
			body: "tighter phrasing",
			suggestion: { replacement: "new text" },
		});
		expect(created?.anchor).toMatchObject(SELECTION_ANCHOR);
	});

	it("hides the suggest toggle on a document-level draft (no selection quote)", () => {
		render();
		expect(q(".bs-comments__suggest-toggle")).toBeNull();
	});

	async function seedSuggestion(): Promise<void> {
		await adapter.add({
			anchor: SELECTION_ANCHOR,
			body: "please tighten",
			kind: CommentKind.Suggestion,
			suggestion: { replacement: "new text" },
		});
	}

	it("Apply resolves the thread when the host confirms the edit landed", async () => {
		await seedSuggestion();
		let applied: CommentDef | null = null;
		render(undefined, undefined, {
			onApplySuggestion: (c) => {
				applied = c;
				return true;
			},
		});
		const apply = qa(".bs-comments__action").find(
			(b) => b.textContent === "Apply",
		) as HTMLButtonElement;
		await act(async () => {
			apply.click();
		});
		expect((applied as CommentDef | null)?.suggestion?.replacement).toBe("new text");
		expect(q(".bs-comments__thread")?.getAttribute("data-resolved")).toBe("true");
	});

	it("a failed Apply keeps the thread open and flags the stale anchor", async () => {
		await seedSuggestion();
		render(undefined, undefined, { onApplySuggestion: () => false });
		const apply = qa(".bs-comments__action").find(
			(b) => b.textContent === "Apply",
		) as HTMLButtonElement;
		await act(async () => {
			apply.click();
		});
		expect(q(".bs-comments__thread")?.getAttribute("data-resolved")).toBeNull();
		expect(q(".bs-comments__apply-failed")).not.toBeNull();
	});

	it("Reject resolves the thread without applying", async () => {
		await seedSuggestion();
		let applyCalled = false;
		render(undefined, undefined, {
			onApplySuggestion: () => {
				applyCalled = true;
				return true;
			},
		});
		const reject = qa(".bs-comments__action").find(
			(b) => b.textContent === "Reject",
		) as HTMLButtonElement;
		act(() => reject.click());
		expect(applyCalled).toBe(false);
		expect(q(".bs-comments__thread")?.getAttribute("data-resolved")).toBe("true");
	});

	it("offers Reject but no Apply when the host can't apply (no editor wired)", async () => {
		await seedSuggestion();
		render();
		const labels = qa(".bs-comments__action").map((b) => b.textContent);
		expect(labels).not.toContain("Apply");
		expect(labels).toContain("Reject");
	});
});

describe("commentTimeLabel", () => {
	const t = createEditorT();
	const now = Date.UTC(2026, 5, 9, 12, 0, 0);

	it("buckets ages into just-now / minutes / hours / days", () => {
		expect(commentTimeLabel(t, now - 30_000, now)).toBe("just now");
		expect(commentTimeLabel(t, now - 5 * 60_000, now)).toBe("5m");
		expect(commentTimeLabel(t, now - 3 * 3_600_000, now)).toBe("3h");
		expect(commentTimeLabel(t, now - 2 * 86_400_000, now)).toBe("2d");
	});

	it("falls back to an absolute date past a week, adding the year across years", () => {
		const eightDays = commentTimeLabel(t, now - 8 * 86_400_000, now);
		expect(eightDays).toMatch(/Jun/);
		expect(eightDays).not.toMatch(/2026/);
		const lastYear = commentTimeLabel(t, Date.UTC(2025, 0, 15), now);
		expect(lastYear).toMatch(/2025/);
	});

	it("clamps a future createdAt (clock skew) to just now", () => {
		expect(commentTimeLabel(t, now + 60_000, now)).toBe("just now");
	});
});
