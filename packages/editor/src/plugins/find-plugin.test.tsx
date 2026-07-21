import { isAnyShortcutSuppressed } from "@brainstorm-os/sdk/shortcut";
// @vitest-environment jsdom
/**
 * B9.1c integration: FindPlugin wires the shared controller +
 * `<FindBar>` + chords onto a real Lexical editor end-to-end. Proves
 * the composition (controller ⇄ Notes Lexical adapter ⇄ bar ⇄ chord
 * binder), not the units (each is covered in isolation).
 */
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { useEffect } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FindPlugin } from "./find-plugin";

function Seed({ text }: { text: string }) {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				root.append($createParagraphNode().append($createTextNode(text)));
			},
			{ discrete: true },
		);
	}, [editor, text]);
	return null;
}

describe("FindPlugin (B9.1c end-to-end)", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const mount = (text: string) =>
		act(() =>
			root.render(
				<LexicalComposer
					initialConfig={{
						namespace: "find-plugin-test",
						onError: (e) => {
							throw e;
						},
					}}
				>
					<Seed text={text} />
					<FindPlugin />
				</LexicalComposer>,
			),
		);

	const bar = () => container.querySelector('[role="search"]');
	const el = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	const setTerm = (value: string) => {
		const input = el("find-term") as HTMLInputElement;
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};

	it("mounts hidden, opens on the find chord, searches the model live", () => {
		mount("hello brave hello world");
		expect(bar()).toBeNull(); // closed → FindBar renders nothing

		// The bound global chord (Cmd/Ctrl+F) opens the bar.
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
		expect(bar()).not.toBeNull();

		act(() => setTerm("hello"));
		expect(el("find-count")?.textContent).toBe("1 of 2");

		// Stepping walks the real model matches.
		act(() => el("find-next")?.click());
		expect(el("find-count")?.textContent).toBe("2 of 2");

		// Escape (Cmd/Ctrl-less, the input handler) closes it.
		act(() =>
			(el("find-term") as HTMLInputElement).dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
		);
		expect(bar()).toBeNull();
	});

	it("unmounting after open() releases the controller's suppression source (regression)", () => {
		// Before this fix FindPlugin had no useEffect calling controller.close()
		// on unmount, so the `() => open` closure registered by controller.open()
		// stayed in the module-level Set forever. Switching notes with the bar
		// open would leak a source per note-switch and permanently suppress
		// every single-key chord app-wide.
		const before = isAnyShortcutSuppressed();
		expect(before).toBe(false);

		mount("hello world");
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
		// Source is registered while the bar is open.
		expect(isAnyShortcutSuppressed()).toBe(true);

		// Simulate a note-switch by unmounting the composer; FindPlugin's
		// useEffect cleanup must call controller.close().
		act(() => root.unmount());
		// Recreate root so afterEach's unmount call is a no-op rather than throwing.
		root = createRoot(container);

		expect(isAnyShortcutSuppressed()).toBe(false);
	});

	it("replace edits the document through the editor (one undo step)", () => {
		mount("cat cat cat");
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
		act(() => setTerm("cat"));
		expect(el("find-count")?.textContent).toBe("1 of 3");
		const repl = el("find-replacement") as HTMLInputElement;
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		setter?.call(repl, "dog");
		act(() => repl.dispatchEvent(new Event("input", { bubbles: true })));
		act(() => el("find-replace-all")?.click());
		expect(el("find-count")?.textContent).toBe("No results"); // all replaced
	});
});
