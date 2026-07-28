/**
 * Singleton pub-sub store driving the AddPropertyMenu overlay.
 *
 * Three EDITOR callers open the picker (each needs a Lexical mutation):
 *   - The `/property` slash command — wants to *replace* the current
 *     empty paragraph with a new `PropertyBlockNode`.
 *   - The block-action menu / right-click "Add property" entry — wants
 *     to *insert* a new `PropertyBlockNode` after the targeted block.
 *   - The "+ Add property" affordance inside a `PropertyListBlockNode`
 *     — wants to *append* a key to that list's `__propertyKeys`.
 *
 * All three converge on the same `AddPropertyMenu` UI; only the commit
 * handler differs. The discriminated `AddPropertyTarget` union encodes
 * which path the menu should take on selection. (The right-hand
 * Properties panel used to route its bind-to-note flow through here too;
 * since Props-4 the shared `<EntityPropertiesPanel>` mounts the same SDK
 * picker itself — no editor involvement, no store target.)
 *
 * Same shape as `mediaInspectorStore` — no context, no React deps;
 * consumers hook in via `useSyncExternalStore` from
 * `useAddPropertyTarget()`.
 */

import type { NodeKey } from "lexical";
import { useSyncExternalStore } from "react";

export enum AddPropertyTargetKind {
	ReplaceParagraph = "replace-paragraph",
	InsertAfter = "insert-after",
	AppendToList = "append-to-list",
}

export type AddPropertyTarget =
	| {
			kind: AddPropertyTargetKind.ReplaceParagraph;
			/** Key of the empty paragraph the picker should replace with a
			 *  `PropertyBlockNode`. Source: `/property` slash command. */
			paragraphKey: NodeKey;
			anchor: DOMRect;
	  }
	| {
			kind: AddPropertyTargetKind.InsertAfter;
			/** Key of the block the new `PropertyBlockNode` should land after.
			 *  Source: gutter / right-click "Add property". */
			blockKey: NodeKey;
			anchor: DOMRect;
	  }
	| {
			kind: AddPropertyTargetKind.AppendToList;
			/** Key of the `PropertyListBlockNode` to append the picked
			 *  property key into. Source: PropertyList's "+" affordance. */
			listKey: NodeKey;
			anchor: DOMRect;
	  };

type Listener = () => void;

class AddPropertyStore {
	private target: AddPropertyTarget | null = null;
	private listeners = new Set<Listener>();

	getSnapshot = (): AddPropertyTarget | null => this.target;

	subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	open(target: AddPropertyTarget): void {
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

export const addPropertyStore = new AddPropertyStore();

export function useAddPropertyTarget(): AddPropertyTarget | null {
	return useSyncExternalStore(
		addPropertyStore.subscribe,
		addPropertyStore.getSnapshot,
		addPropertyStore.getSnapshot,
	);
}
