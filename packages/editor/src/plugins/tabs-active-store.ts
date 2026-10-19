/**
 * Which pane each tabs block is showing (B11.29) — renderer-local view
 * state, keyed by the tabs node's key, one store per editor. Never written
 * to the document: switching tabs on a locked or shared page is a view
 * change, not an edit.
 */

import type { LexicalEditor, NodeKey } from "lexical";

export class TabsActiveStore {
	private readonly active = new Map<NodeKey, NodeKey>();
	private readonly listeners = new Set<() => void>();
	private version = 0;

	get(tabsKey: NodeKey): NodeKey | undefined {
		return this.active.get(tabsKey);
	}

	set(tabsKey: NodeKey, paneKey: NodeKey): void {
		if (this.active.get(tabsKey) === paneKey) return;
		this.active.set(tabsKey, paneKey);
		this.version += 1;
		for (const l of this.listeners) l();
	}

	/** Forget a destroyed tabs block, so the map is bounded by the blocks that
	 *  exist rather than every block the editor ever held. No notify: a block
	 *  that is gone has nothing to repaint. */
	delete(tabsKey: NodeKey): void {
		this.active.delete(tabsKey);
	}

	get size(): number {
		return this.active.size;
	}

	snapshot(): number {
		return this.version;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

const stores = new WeakMap<LexicalEditor, TabsActiveStore>();

export function tabsActiveStore(editor: LexicalEditor): TabsActiveStore {
	let store = stores.get(editor);
	if (!store) {
		store = new TabsActiveStore();
		stores.set(editor, store);
	}
	return store;
}

/** The pane to show: the remembered one while it still exists, else the
 *  first. */
export function resolveActivePane(
	remembered: NodeKey | undefined,
	paneKeys: readonly NodeKey[],
): NodeKey | null {
	if (remembered !== undefined && paneKeys.includes(remembered)) return remembered;
	return paneKeys[0] ?? null;
}
