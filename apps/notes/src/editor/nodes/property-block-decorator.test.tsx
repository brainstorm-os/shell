// @vitest-environment jsdom
/**
 * Decorator render tests for PropertyBlockNode + PropertyListBlockNode.
 *
 * Mounts the React output of each node's `decorate()` inside a
 * hand-crafted `PropertiesContext` + `NoteContextProvider`. Verifies
 * the right cell from the B5.3 registry renders for the three shipped
 * (kind, view) pairs:
 *   - PillCell      — for `Text` + `Pill` view (and as the default for
 *     most text-family kinds).
 *   - PlainCell     — for `Text` + explicit `Plain` view.
 *   - CheckboxCell  — for `Boolean` + default `Checkbox` view.
 *
 * Plus the missing-property fallback (deleted from the vault) and the
 * unavailable-view fallback (e.g. `Toggle` view for Boolean — allowed
 * by the matrix but no cell yet in B5.3).
 *
 * Provides the `PropertiesContext` value directly so the test doesn't
 * have to stub the SDK runtime + drive its async `list()` boot.
 */

import { type PropertyDef, PropertyView, ValueType } from "@brainstorm-os/sdk-types";
import { DictionaryStore, PropertiesContext, PropertyStore } from "@brainstorm-os/sdk/property-ui";
import { CodeNode } from "@lexical/code";
import { createHeadlessEditor } from "@lexical/headless";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import type { LexicalEditor } from "lexical";
import type { JSX, ReactNode } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoteContextProvider, type NoteContextValue } from "../note-context";
import { $createPropertyBlockNode, PropertyBlockNode } from "./property-block-node";
import { $createPropertyListBlockNode, PropertyListBlockNode } from "./property-list-block-node";

type Harness = {
	container: HTMLDivElement;
	root: Root;
	cleanup: () => void;
};

const NOOP_PROP_BACKEND = {
	setProperty: async () => {},
	removeProperty: async () => {},
};
const NOOP_DICT_BACKEND = {
	setDictionary: async () => {},
	removeDictionary: async () => {},
};

function makeStores(props: PropertyDef[]): {
	propertyStore: PropertyStore;
	dictionaryStore: DictionaryStore;
} {
	const propertyStore = new PropertyStore({ backend: NOOP_PROP_BACKEND });
	const dictionaryStore = new DictionaryStore({ backend: NOOP_DICT_BACKEND });
	propertyStore.applySnapshot(Object.fromEntries(props.map((p) => [p.key, p])));
	dictionaryStore.applySnapshot({});
	return { propertyStore, dictionaryStore };
}

function makeNoteContext(values: Record<string, unknown>): NoteContextValue & {
	calls: { def: PropertyDef; next: unknown }[];
} {
	const calls: { def: PropertyDef; next: unknown }[] = [];
	return {
		noteId: "n_test",
		values,
		setValue: ((def: PropertyDef, next: unknown) => {
			calls.push({ def, next });
		}) as NoteContextValue["setValue"],
		calls,
	};
}

function mountHarness(): Harness {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	return {
		container,
		root,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

let harness: Harness;
let editor: LexicalEditor;
beforeEach(() => {
	harness = mountHarness();
	editor = createHeadlessEditor({
		nodes: [
			HeadingNode,
			QuoteNode,
			ListNode,
			ListItemNode,
			CodeNode,
			LinkNode,
			AutoLinkNode,
			PropertyBlockNode,
			PropertyListBlockNode,
		],
		onError(err) {
			throw err;
		},
	});
});
afterEach(() => {
	harness.cleanup();
});

/** Build a node inside an editor.update() and capture its decorate()
 *  output; render the captured React element outside the editor.
 *  Node construction needs an active editor for `$setNodeKey`, but the
 *  decorator's returned JSX has no Lexical dependency once captured. */
function decorate(factory: () => PropertyBlockNode | PropertyListBlockNode): JSX.Element {
	let captured: JSX.Element | null = null;
	editor.update(
		() => {
			captured = factory().decorate();
		},
		{ discrete: true },
	);
	if (!captured) throw new Error("factory failed to capture decorate output");
	return captured;
}

function render(
	props: PropertyDef[],
	values: Record<string, unknown>,
	body: ReactNode,
): NoteContextValue & { calls: { def: PropertyDef; next: unknown }[] } {
	const stores = makeStores(props);
	const note = makeNoteContext(values);
	act(() => {
		harness.root.render(
			<PropertiesContext.Provider
				value={{
					propertyStore: stores.propertyStore,
					dictionaryStore: stores.dictionaryStore,
					ready: true,
				}}
			>
				<NoteContextProvider noteId={note.noteId} values={note.values} setValue={note.setValue}>
					{body}
				</NoteContextProvider>
			</PropertiesContext.Provider>,
		);
	});
	return note;
}

const TEXT_DEF: PropertyDef = {
	key: "prop_text",
	name: "Title",
	icon: null,
	valueType: ValueType.Text,
};

const BOOL_DEF: PropertyDef = {
	key: "prop_bool",
	name: "Done",
	icon: null,
	valueType: ValueType.Boolean,
};

describe("PropertyBlockNode.decorate() — render", () => {
	it("renders PillCell when view is null (kind default = Pill for Text)", () => {
		const element = decorate(() => new PropertyBlockNode(TEXT_DEF.key));
		render([TEXT_DEF], { [TEXT_DEF.key]: "Hello" }, element);
		const pill = harness.container.querySelector(".bs-cell-pill");
		expect(pill).not.toBeNull();
		expect(pill?.textContent).toContain("Hello");
	});

	it("renders PlainCell when view is explicitly Plain", () => {
		const element = decorate(() => $createPropertyBlockNode(TEXT_DEF.key, PropertyView.Plain));
		render([TEXT_DEF], { [TEXT_DEF.key]: "Plain text" }, element);
		expect(harness.container.querySelector(".bs-cell-pill")).toBeNull();
		expect(harness.container.textContent).toContain("Plain text");
	});

	it("renders CheckboxCell for a Boolean property (default view)", () => {
		const element = decorate(() => $createPropertyBlockNode(BOOL_DEF.key));
		render([BOOL_DEF], { [BOOL_DEF.key]: true }, element);
		const input = harness.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(input).not.toBeNull();
		expect(input?.checked).toBe(true);
	});

	it("renders the missing-property fallback when the def isn't in the store", () => {
		const element = decorate(() => $createPropertyBlockNode("prop_does_not_exist"));
		render([TEXT_DEF], {}, element);
		expect(harness.container.querySelector(".notes__property-row--missing")).not.toBeNull();
		expect(harness.container.textContent).toContain("prop_does_not_exist");
	});

	it("renders the unavailable-view fallback when the (kind, view) cell isn't registered", () => {
		// Rating is a Number-only view — no `boolean::rating` cell is (or will
		// be) registered, so a Boolean pinned to it falls back. (Boolean→Toggle
		// used to be the example here, but B5.11 shipped the Toggle cell.)
		const element = decorate(() => $createPropertyBlockNode(BOOL_DEF.key, PropertyView.Rating));
		render([BOOL_DEF], { [BOOL_DEF.key]: false }, element);
		expect(harness.container.querySelector(".notes__property-row--missing")).not.toBeNull();
		expect(harness.container.querySelector('input[type="checkbox"]')).toBeNull();
	});
});

describe("PropertyListBlockNode.decorate() — render", () => {
	it("renders one row per propertyKey (mixed kinds)", () => {
		const element = decorate(() => $createPropertyListBlockNode([TEXT_DEF.key, BOOL_DEF.key]));
		render([TEXT_DEF, BOOL_DEF], { [TEXT_DEF.key]: "A", [BOOL_DEF.key]: true }, element);
		const rows = harness.container.querySelectorAll(".notes__property-row");
		expect(rows.length).toBe(2);
		const labels = Array.from(rows).map(
			(r) => r.querySelector(".notes__property-row-label")?.textContent,
		);
		expect(labels).toContain("Title");
		expect(labels).toContain("Done");
	});

	it("hides body when collapsed", () => {
		const element = decorate(() => $createPropertyListBlockNode([TEXT_DEF.key], "Props", true));
		render([TEXT_DEF], { [TEXT_DEF.key]: "Hidden" }, element);
		expect(harness.container.querySelector(".notes__property-list-body")).toBeNull();
		expect(harness.container.textContent).toContain("Props");
	});

	it("renders the empty-state when propertyKeys is empty", () => {
		const element = decorate(() => $createPropertyListBlockNode());
		render([TEXT_DEF, BOOL_DEF], {}, element);
		expect(harness.container.querySelector(".notes__property-list-empty")).not.toBeNull();
	});

	it("falls back to default title when none is set", () => {
		const element = decorate(() => $createPropertyListBlockNode([TEXT_DEF.key]));
		render([TEXT_DEF], { [TEXT_DEF.key]: "X" }, element);
		const title = harness.container.querySelector(".notes__property-list-title")?.textContent;
		expect(title).toBe("Properties");
	});
});
