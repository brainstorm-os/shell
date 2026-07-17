/**
 * Singleton pub-sub driving the `BlockEmbedPickerPlugin` overlay.
 *
 * Opened by the shared `/embed` slash command (`createEntityEmbedCommand`)
 * and by host-app type-scoped commands (Notes' `/database`, `/graph`,
 * `/book` reuse the same picker with a narrowed list). The slash plugin
 * sets the target — the already-cleared paragraph it should replace, plus
 * an anchor rect to position the popover against. The picker plugin
 * listens via `useEmbedPickerTarget()`.
 *
 * Same shape as `mediaInspectorStore` — no React context; the picker
 * plugin remounts with the editor on entity change.
 */

import { $getSelection, $isRangeSelection, type LexicalEditor, type NodeKey } from "lexical";
import { useSyncExternalStore } from "react";

export type EmbedPickerTarget = {
	paragraphKey: NodeKey;
	/** Bounding rect of the empty paragraph the picker is anchored
	 *  against. The popover positions itself below this rect (flips
	 *  above when there isn't space). */
	anchor: { top: number; left: number; bottom: number };
	/** Scope the picker to one entity type — host type-scoped slash commands
	 *  (Notes' `/database` → `brainstorm/List/v1`, `/graph` →
	 *  `brainstorm/Graph/v1`) reuse the generic `/embed` picker with a
	 *  narrowed list. Absent → every entity. */
	typeFilter?: string;
};

type Listener = () => void;

class EmbedPickerStore {
	private target: EmbedPickerTarget | null = null;
	private listeners = new Set<Listener>();

	getSnapshot = (): EmbedPickerTarget | null => this.target;

	subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	open(target: EmbedPickerTarget): void {
		this.target = target;
		this.emit();
	}

	close(): void {
		if (this.target === null) return;
		this.target = null;
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export const embedPickerStore = new EmbedPickerStore();

export function useEmbedPickerTarget(): EmbedPickerTarget | null {
	return useSyncExternalStore(
		embedPickerStore.subscribe,
		embedPickerStore.getSnapshot,
		embedPickerStore.getSnapshot,
	);
}

/** Open the entity picker for the `/embed` slash command (and the host
 *  apps' type-scoped variants). The slash plugin has already cleared the
 *  host paragraph by the time the command's `run` fires, so the selection
 *  sits inside an empty top-level block — its key + bounding rect anchor
 *  the picker. */
export function openEntityEmbedPicker(editor: LexicalEditor, typeFilter?: string): void {
	let paragraphKey: NodeKey | null = null;
	editor.getEditorState().read(() => {
		const sel = $getSelection();
		if (!$isRangeSelection(sel)) return;
		try {
			paragraphKey = sel.anchor.getNode().getTopLevelElementOrThrow().getKey();
		} catch {
			paragraphKey = null;
		}
	});
	if (!paragraphKey) return;
	const el = editor.getElementByKey(paragraphKey);
	if (!el) return;
	const rect = el.getBoundingClientRect();
	embedPickerStore.open({
		paragraphKey,
		anchor: { top: rect.top, left: rect.left, bottom: rect.bottom },
		...(typeFilter !== undefined ? { typeFilter } : {}),
	});
}
