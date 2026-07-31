// @vitest-environment happy-dom
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$getRoot,
	COMMAND_PRIORITY_CRITICAL,
	FORMAT_TEXT_COMMAND,
	type LexicalEditor,
	type TextFormatType,
} from "lexical";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Doc } from "yjs";
import { BlockType } from "../block-types";
import { BrainstormEditor } from "../editor";
import { STANDARD_ADDITIONAL_NODES } from "../standard-nodes";
import { StandardEditingPlugins } from "./standard-editing-plugins";
import { TURN_INTO_COMMAND } from "./turn-into-plugin";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function CaptureEditor({ onReady }: { onReady: (e: LexicalEditor) => void }) {
	const [editor] = useLexicalComposerContext();
	onReady(editor);
	return null;
}

async function mountEditor(): Promise<{ editor: LexicalEditor; cleanup: () => void }> {
	const doc = new Doc();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	let editor: LexicalEditor | null = null;
	await act(async () => {
		root.render(
			<BrainstormEditor doc={doc} namespace="test" additionalNodes={STANDARD_ADDITIONAL_NODES}>
				<StandardEditingPlugins />
				<CaptureEditor
					onReady={(e) => {
						editor = e;
					}}
				/>
			</BrainstormEditor>,
		);
	});
	await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
	const ed = editor as unknown as LexicalEditor;
	// A non-empty paragraph with a caret so the mark/turn-into paths have a
	// range selection to act on.
	await act(async () => {
		ed.update(() => {
			const r = $getRoot();
			r.clear();
			const p = $createParagraphNode();
			r.append(p);
			p.selectStart();
		});
	});
	return { editor: ed, cleanup: () => act(() => root.unmount()) };
}

function press(init: KeyboardEventInit): void {
	document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

describe("FormatChordsPlugin (shared)", () => {
	let env: { editor: LexicalEditor; cleanup: () => void };

	beforeEach(async () => {
		env = await mountEditor();
	});
	afterEach(() => {
		env.cleanup();
	});

	it("Mod+Alt+<digit> dispatches turn-into for the matching block type (via event.code)", async () => {
		const turned: BlockType[] = [];
		const unregister = env.editor.registerCommand(
			TURN_INTO_COMMAND,
			(payload: BlockType) => {
				turned.push(payload);
				return true; // consume — no TurnIntoPlugin mounted to apply it
			},
			COMMAND_PRIORITY_CRITICAL,
		);
		// Each physical digit → its block type. Option+digit is a dead key on
		// macOS, so the plugin matches `event.code`, not `event.key`.
		const cases: Array<[string, BlockType]> = [
			["Digit0", BlockType.Paragraph],
			["Digit1", BlockType.Heading1],
			["Digit3", BlockType.Heading3],
			["Digit6", BlockType.TodoList],
			["Digit9", BlockType.Callout],
		];
		for (const [code, expected] of cases) {
			await act(async () => {
				press({ code, key: "Dead", metaKey: true, altKey: true });
			});
			expect(turned.at(-1)).toBe(expected);
		}
		unregister();
	});

	it("ignores Mod+Alt+digit when the modifier set is wrong", async () => {
		const turned: BlockType[] = [];
		const unregister = env.editor.registerCommand(
			TURN_INTO_COMMAND,
			(p: BlockType) => {
				turned.push(p);
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);
		await act(async () => {
			press({ code: "Digit1", key: "1" }); // no modifiers
			press({ code: "Digit1", key: "1", altKey: true }); // Alt only
			press({ code: "Digit1", key: "1", metaKey: true, altKey: true, shiftKey: true }); // +Shift
		});
		expect(turned).toEqual([]);
		unregister();
	});

	it("Mod+Shift+S / Mod+Shift+E dispatch the strike + code marks", async () => {
		const marks: TextFormatType[] = [];
		const unregister = env.editor.registerCommand(
			FORMAT_TEXT_COMMAND,
			(payload: TextFormatType) => {
				marks.push(payload);
				return false; // observe, let RichTextPlugin still apply it
			},
			COMMAND_PRIORITY_CRITICAL,
		);
		// `Mod` is Cmd on mac, Ctrl elsewhere — mirror the matcher's resolution so
		// the test sends the modifier it expects in this environment.
		const isMac = /mac|iphone|ipad/i.test(navigator.platform ?? navigator.userAgent);
		const mod = isMac ? { metaKey: true } : { ctrlKey: true };
		await act(async () => {
			press({ key: "S", code: "KeyS", shiftKey: true, ...mod });
		});
		await act(async () => {
			press({ key: "E", code: "KeyE", shiftKey: true, ...mod });
		});
		expect(marks).toContain("strikethrough");
		expect(marks).toContain("code");
		unregister();
	});

	it("Mod+E (no Shift) dispatches the code mark — POLISH-ED-3", async () => {
		const marks: TextFormatType[] = [];
		const unregister = env.editor.registerCommand(
			FORMAT_TEXT_COMMAND,
			(payload: TextFormatType) => {
				marks.push(payload);
				return false;
			},
			COMMAND_PRIORITY_CRITICAL,
		);
		const isMac = /mac|iphone|ipad/i.test(navigator.platform ?? navigator.userAgent);
		const mod = isMac ? { metaKey: true } : { ctrlKey: true };
		await act(async () => {
			press({ key: "e", code: "KeyE", ...mod });
		});
		expect(marks).toEqual(["code"]);
		// A bare `e` (no modifier) must NOT format.
		await act(async () => {
			press({ key: "e", code: "KeyE" });
		});
		expect(marks).toEqual(["code"]);
		unregister();
	});
});
