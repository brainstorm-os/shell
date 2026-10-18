/**
 * Tabs block model operations (B11.29) — pure Lexical mutations, so the
 * structure rules are exercised headless. Every `$`-function runs inside an
 * `editor.update()`.
 */

import {
	$createParagraphNode,
	$getNodeByKey,
	$getSelection,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
	type LexicalNode,
	type NodeKey,
} from "lexical";
import {
	$createTabPaneNode,
	$createTabsNode,
	$isTabPaneNode,
	$isTabsNode,
	type TabPaneNode,
	type TabsNode,
} from "../nodes/tabs-node";

export const DEFAULT_TAB_COUNT = 2;

/** Insert a tabs block at the caret's block: an empty block is replaced, a
 *  block with content moves into the first pane. Returns the first pane's
 *  key, or `null` with no usable caret. */
export function $insertTabs(titles: readonly string[]): NodeKey | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return null;
	const block = selection.anchor.getNode().getTopLevelElement();
	if (!block) return null;
	const tabs = $createTabsNode();
	const panes = titles.map((title) => $createTabPaneNode(title));
	for (const pane of panes) tabs.append(pane);
	const first = panes[0];
	if (!first) return null;
	block.insertBefore(tabs);
	const empty = $isParagraphNode(block) && block.getTextContentSize() === 0;
	if (empty) block.remove();
	else first.append(block);
	for (const pane of panes) if (pane.getChildrenSize() === 0) pane.append($createParagraphNode());
	first.selectStart();
	return first.getKey();
}

export function $tabPanes(tabs: TabsNode): TabPaneNode[] {
	return tabs.getChildren().filter($isTabPaneNode);
}

/** Append a pane (with an empty paragraph, caret in it). */
export function $addTab(tabsKey: NodeKey, title: string): NodeKey | null {
	const tabs = $getNodeByKey(tabsKey);
	if (!$isTabsNode(tabs)) return null;
	const pane = $createTabPaneNode(title);
	const paragraph = $createParagraphNode();
	pane.append(paragraph);
	tabs.append(pane);
	paragraph.select();
	return pane.getKey();
}

export function $renameTab(paneKey: NodeKey, title: string): void {
	const pane = $getNodeByKey(paneKey);
	if ($isTabPaneNode(pane)) pane.setTitle(title);
}

/** Move a pane `delta` positions among its siblings (clamped). */
export function $moveTab(paneKey: NodeKey, delta: number): void {
	const pane = $getNodeByKey(paneKey);
	if (!$isTabPaneNode(pane)) return;
	const tabs = pane.getParent();
	if (!$isTabsNode(tabs)) return;
	const panes = $tabPanes(tabs);
	const from = panes.indexOf(pane);
	const to = Math.max(0, Math.min(panes.length - 1, from + delta));
	if (to === from) return;
	const anchor = panes[to];
	if (!anchor) return;
	if (to > from) anchor.insertAfter(pane);
	else anchor.insertBefore(pane);
}

/** Delete a pane. The last pane takes the whole tabs block with it (an
 *  empty paragraph is left in its place). Returns the pane to show next. */
export function $deleteTab(paneKey: NodeKey): NodeKey | null {
	const pane = $getNodeByKey(paneKey);
	if (!$isTabPaneNode(pane)) return null;
	const tabs = pane.getParent();
	if (!$isTabsNode(tabs)) {
		pane.remove();
		return null;
	}
	const panes = $tabPanes(tabs);
	const index = panes.indexOf(pane);
	const next = panes[index + 1] ?? panes[index - 1] ?? null;
	if (!next) {
		const paragraph = $createParagraphNode();
		tabs.replace(paragraph);
		paragraph.select();
		return null;
	}
	pane.remove();
	next.selectStart();
	return next.getKey();
}

/** Structural invariants, applied as node transforms:
 *  - a tabs block holds only panes (a stray block joins the last pane, or a
 *    new one) and is removed when it has none;
 *  - a pane always holds at least one block;
 *  - a pane outside a tabs block dissolves into its blocks. */
export function $normalizeTabs(tabs: TabsNode): void {
	let lastPane: TabPaneNode | null = null;
	for (const child of tabs.getChildren()) {
		if ($isTabPaneNode(child)) {
			lastPane = child;
			continue;
		}
		if (!lastPane) {
			lastPane = $createTabPaneNode();
			child.insertBefore(lastPane);
		}
		lastPane.append(wrapInline(child));
	}
	if (tabs.getChildrenSize() === 0) tabs.remove();
}

export function $normalizeTabPane(pane: TabPaneNode): void {
	const parent = pane.getParent();
	if (!$isTabsNode(parent)) {
		for (const child of pane.getChildren()) pane.insertBefore(child);
		pane.remove();
		return;
	}
	if (pane.getChildrenSize() === 0) pane.append($createParagraphNode());
}

function wrapInline(node: LexicalNode): LexicalNode {
	if ($isElementNode(node) && !node.isInline()) return node;
	const paragraph = $createParagraphNode();
	node.replace(paragraph);
	paragraph.append(node);
	return paragraph;
}

/** The pane (and its tabs block) the selection's anchor sits in, if any. */
export function $selectionPane(): { tabsKey: NodeKey; paneKey: NodeKey } | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return null;
	for (let n: LexicalNode | null = selection.anchor.getNode(); n; n = n.getParent()) {
		if ($isTabPaneNode(n)) {
			const tabs = n.getParent();
			return $isTabsNode(tabs) ? { tabsKey: tabs.getKey(), paneKey: n.getKey() } : null;
		}
	}
	return null;
}
