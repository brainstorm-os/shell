/**
 * TabsNode / TabPaneNode (B11.29) — a block that shows one of several panes
 * of blocks at a time behind a tab strip.
 *
 *   TabsNode     → the top-level container. Its DOM is a wrapper holding a
 *                  non-content tab-strip host (mounted by `TabsPlugin`) and
 *                  a panes slot; `getDOMSlot` points Lexical's reconciler at
 *                  the slot so the strip is never treated as content.
 *   TabPaneNode  → one pane: a title + arbitrary blocks (paragraphs, lists,
 *                  an embedded database view …). A shadow root, so editing
 *                  commands that act on "the top-level block" scope to the
 *                  pane instead of swallowing the whole tabs block.
 *
 * Which pane is showing is per-device view state (like a toggle's collapsed
 * state), never synced content: switching tabs on a locked or shared page
 * must not write the document. `TabsPlugin` owns it.
 */

import {
	type EditorConfig,
	type ElementDOMSlot,
	ElementNode,
	type LexicalNode,
	type NodeKey,
	type SerializedElementNode,
	setDOMUnmanaged,
} from "lexical";

export const TABS_NODE_TYPE = "tabs";
export const TAB_PANE_NODE_TYPE = "tab-pane";
const VERSION = 1 as const;

export const TAB_STRIP_HOST_CLASS = "bs-tabs__strip";
const PANES_CLASS = "bs-tabs__panes";
export const MAX_TAB_TITLE_LENGTH = 80;

export type SerializedTabsNode = SerializedElementNode & {
	type: typeof TABS_NODE_TYPE;
	version: typeof VERSION;
};

export type SerializedTabPaneNode = SerializedElementNode & {
	type: typeof TAB_PANE_NODE_TYPE;
	version: typeof VERSION;
	title: string;
};

/** Events the strip's own controls own. Lexical's root listeners skip an
 *  event already flagged as handled, so a keystroke in a tab button or the
 *  rename input never reaches the editor's key / input / selection pipeline;
 *  native propagation continues, so React's delegated handlers still run. */
const STRIP_SHIELDED_EVENTS = [
	"keydown",
	"keyup",
	"keypress",
	"beforeinput",
	"input",
	"compositionstart",
	"compositionend",
	"paste",
	"cut",
	"copy",
	"mousedown",
	"pointerdown",
	"click",
	"dragstart",
	"drop",
] as const;

function shieldFromLexical(el: HTMLElement): void {
	for (const type of STRIP_SHIELDED_EVENTS) {
		el.addEventListener(type, (event) => {
			(event as Event & { _lexicalHandled?: boolean })._lexicalHandled = true;
		});
	}
}

export function normalizeTabTitle(raw: unknown): string {
	const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
	return s.slice(0, MAX_TAB_TITLE_LENGTH);
}

/** Stable DOM ids wiring each tab to its panel (`aria-controls` /
 *  `aria-labelledby`), derived from the pane's node key. */
export function tabDomId(paneKey: NodeKey): string {
	return `bs-tab-${paneKey}`;
}

export function tabPanelDomId(paneKey: NodeKey): string {
	return `bs-tabpanel-${paneKey}`;
}

export class TabsNode extends ElementNode {
	static override getType(): string {
		return TABS_NODE_TYPE;
	}

	static override clone(node: TabsNode): TabsNode {
		return new TabsNode(node.__key);
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		el.className = "bs-tabs";
		const strip = document.createElement("div");
		strip.className = TAB_STRIP_HOST_CLASS;
		strip.contentEditable = "false";
		setDOMUnmanaged(strip);
		shieldFromLexical(strip);
		const panes = document.createElement("div");
		panes.className = PANES_CLASS;
		el.append(strip, panes);
		return el;
	}

	override getDOMSlot(element: HTMLElement): ElementDOMSlot {
		const panes = element.querySelector<HTMLElement>(`:scope > .${PANES_CLASS}`);
		const slot = super.getDOMSlot(element);
		if (!panes) return slot;
		const paneSlot = slot.withElement(panes);
		const inherited = paneSlot.resolveChildIndex.bind(paneSlot);
		// Lexical 0.21's `resolveChildIndex` walks the DOM lineage of a point
		// outside the slot element with a loop that never advances (`indexPath`
		// re-reads `child.parentNode`), so a DOM selection in the strip — a
		// focused tab, the rename input — pushes until the renderer throws
		// `RangeError: Invalid array length` and Lexical resets the editor.
		// Such a point belongs to the pane being shown: resolving there keeps
		// `$selectionPane` from switching tabs under a rename, and Lexical's
		// own descent lands the caret inside that pane.
		paneSlot.resolveChildIndex = (node, elementDOM, initialDOM, initialOffset) => {
			if (initialDOM === panes) return inherited(node, elementDOM, initialDOM, initialOffset);
			const shown = [...panes.children].findIndex((pane) => !pane.hasAttribute("hidden"));
			return [node, Math.max(0, shown)];
		};
		return paneSlot;
	}

	override updateDOM(): false {
		return false;
	}

	static override importJSON(_s: SerializedTabsNode): TabsNode {
		return new TabsNode();
	}

	override exportJSON(): SerializedTabsNode {
		return { ...super.exportJSON(), type: TABS_NODE_TYPE, version: VERSION };
	}

	override canBeEmpty(): false {
		return false;
	}

	override canIndent(): false {
		return false;
	}

	override isShadowRoot(): false {
		return false;
	}
}

export class TabPaneNode extends ElementNode {
	__title: string;

	static override getType(): string {
		return TAB_PANE_NODE_TYPE;
	}

	static override clone(node: TabPaneNode): TabPaneNode {
		return new TabPaneNode(node.__title, node.__key);
	}

	constructor(title = "", key?: NodeKey) {
		super(key);
		this.__title = normalizeTabTitle(title);
	}

	getTitle(): string {
		return this.getLatest().__title;
	}

	setTitle(title: string): void {
		this.getWritable().__title = normalizeTabTitle(title);
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		el.className = "bs-tabs__pane";
		el.id = tabPanelDomId(this.__key);
		el.setAttribute("role", "tabpanel");
		el.setAttribute("aria-labelledby", tabDomId(this.__key));
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	static override importJSON(s: SerializedTabPaneNode): TabPaneNode {
		return new TabPaneNode(normalizeTabTitle(s.title));
	}

	override exportJSON(): SerializedTabPaneNode {
		return {
			...super.exportJSON(),
			type: TAB_PANE_NODE_TYPE,
			version: VERSION,
			title: this.getTitle(),
		};
	}

	override canBeEmpty(): false {
		return false;
	}

	override canIndent(): false {
		return false;
	}

	override isShadowRoot(): true {
		return true;
	}
}

export function $createTabsNode(): TabsNode {
	return new TabsNode();
}

export function $createTabPaneNode(title = ""): TabPaneNode {
	return new TabPaneNode(title);
}

export function $isTabsNode(node: LexicalNode | null | undefined): node is TabsNode {
	return node instanceof TabsNode;
}

export function $isTabPaneNode(node: LexicalNode | null | undefined): node is TabPaneNode {
	return node instanceof TabPaneNode;
}
