// @vitest-environment jsdom

/**
 * The turn-into / mark chords answer only in the editor that owns the
 * keystroke: the host skips keys typed inside a nested "Edit here" body.
 */

import { BlockSelectionPlugin, TURN_INTO_COMMAND } from "@brainstorm-os/editor";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_CRITICAL } from "lexical";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormatChordsPlugin } from "./format-chords-plugin";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IS_MAC = /Mac/i.test(navigator.platform);

function Harness({ onTurn }: { onTurn: () => void }) {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		const root = document.getElementById("host-root");
		editor.setRootElement(root);
		const off = editor.registerCommand(
			TURN_INTO_COMMAND,
			() => {
				onTurn();
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);
		return () => {
			off();
			editor.setRootElement(null);
		};
	}, [editor, onTurn]);
	return null;
}

function chord(target: Element): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		key: "1",
		code: "Digit1",
		altKey: true,
		metaKey: IS_MAC,
		ctrlKey: !IS_MAC,
		bubbles: true,
		cancelable: true,
	});
	target.dispatchEvent(event);
	return event;
}

describe("FormatChordsPlugin ownership", () => {
	let container: HTMLDivElement;
	let root: Root;
	let hostRoot: HTMLDivElement;
	let nestedRoot: HTMLDivElement;

	beforeEach(() => {
		hostRoot = document.createElement("div");
		hostRoot.id = "host-root";
		nestedRoot = document.createElement("div");
		nestedRoot.setAttribute("data-lexical-editor", "true");
		nestedRoot.contentEditable = "true";
		document.body.append(hostRoot);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		hostRoot.remove();
	});

	async function mount(onTurn: () => void): Promise<void> {
		await act(async () =>
			root.render(
				<LexicalComposer
					initialConfig={{
						namespace: "t",
						onError: (e) => {
							throw e;
						},
					}}
				>
					<BlockSelectionPlugin>
						<Harness onTurn={onTurn} />
						<FormatChordsPlugin />
					</BlockSelectionPlugin>
				</LexicalComposer>,
			),
		);
	}

	it("turns the host block on a host keystroke", async () => {
		const onTurn = vi.fn();
		await mount(onTurn);
		const event = chord(hostRoot);
		expect(onTurn).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("leaves a keystroke from a nested editor to that editor", async () => {
		const onTurn = vi.fn();
		await mount(onTurn);
		// Appended after mount: binding the host root resets its children.
		hostRoot.append(nestedRoot);
		const event = chord(nestedRoot);
		expect(onTurn).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});
});
