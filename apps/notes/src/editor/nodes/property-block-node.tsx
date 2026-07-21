/**
 * PropertyBlockNode — single inline property rendered as a Lexical
 * `DecoratorNode`. Ref-state only: `__blockId` (stable across reloads),
 * `__propertyKey` (key into the vault-scoped propertyStore), `__view`
 * (optional; falls back to the kind's default).
 *
 * The actual value lives on `StoredNote.values[propertyKey]` and is
 * read through `<NoteContextProvider>` inside the editor tree. The
 * PropertyDef comes from `<PropertiesProvider>` (`useProperty(key)`).
 *
 * Per ` §Block state`. Plays
 * with the existing block-level machinery for free:
 *   - Top-level → `BlockSelectionPlugin` Cmd-click / Shift-click work.
 *   - `exportJSON` / `importJSON` → clipboard + duplicate + move
 *     round-trip without extra wiring.
 *
 * Turn-into commands skip this node (Lexical's `$setBlocksType`
 * ignores decorators) — by design.
 */

import { type PropertyView, defaultViewFor } from "@brainstorm-os/sdk-types";
import { getCell, readValue, useProperty } from "@brainstorm-os/sdk/property-ui";
import {
	type DOMConversionMap,
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { JSX } from "react";
import { useNoteContextOptional } from "../note-context";
import { PropertyBlockFallback, PropertyBlockUnavailableView } from "./property-block-fallback";
import { newPropertyBlockId } from "./property-block-id";

export const PROPERTY_BLOCK_TYPE = "property-block";
const PROPERTY_BLOCK_VERSION = 1 as const;

export type SerializedPropertyBlockNode = SerializedLexicalNode & {
	type: typeof PROPERTY_BLOCK_TYPE;
	version: typeof PROPERTY_BLOCK_VERSION;
	blockId: string;
	propertyKey: string;
	view: PropertyView | null;
};

export class PropertyBlockNode extends DecoratorNode<JSX.Element> {
	__blockId: string;
	__propertyKey: string;
	__view: PropertyView | null;

	static override getType(): string {
		return PROPERTY_BLOCK_TYPE;
	}

	static override clone(node: PropertyBlockNode): PropertyBlockNode {
		return new PropertyBlockNode(node.__propertyKey, node.__view, node.__blockId, node.__key);
	}

	constructor(
		propertyKey: string,
		view: PropertyView | null = null,
		blockId?: string,
		key?: NodeKey,
	) {
		super(key);
		this.__propertyKey = propertyKey;
		this.__view = view;
		this.__blockId = blockId ?? newPropertyBlockId();
	}

	static override importJSON(serialized: SerializedPropertyBlockNode): PropertyBlockNode {
		return new PropertyBlockNode(
			serialized.propertyKey,
			serialized.view ?? null,
			typeof serialized.blockId === "string" && serialized.blockId.length > 0
				? serialized.blockId
				: undefined,
		);
	}

	override exportJSON(): SerializedPropertyBlockNode {
		return {
			type: PROPERTY_BLOCK_TYPE,
			version: PROPERTY_BLOCK_VERSION,
			blockId: this.__blockId,
			propertyKey: this.__propertyKey,
			view: this.__view,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		const themeClass = config.theme.propertyBlock;
		el.className = typeof themeClass === "string" ? themeClass : "notes__property-block";
		el.setAttribute("data-block-id", this.__blockId);
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	getBlockId(): string {
		return this.__blockId;
	}

	getPropertyKey(): string {
		return this.__propertyKey;
	}

	getView(): PropertyView | null {
		return this.__view;
	}

	setPropertyKey(key: string): void {
		this.getWritable().__propertyKey = key;
	}

	setView(view: PropertyView | null): void {
		this.getWritable().__view = view;
	}

	override decorate(): JSX.Element {
		return <PropertyBlockView propertyKey={this.__propertyKey} view={this.__view} />;
	}

	override isInline(): false {
		return false;
	}
}

function PropertyBlockView({
	propertyKey,
	view,
}: {
	propertyKey: string;
	view: PropertyView | null;
}): JSX.Element {
	const def = useProperty(propertyKey);
	const note = useNoteContextOptional();

	if (!def) {
		return <PropertyBlockFallback propertyKey={propertyKey} />;
	}

	const effectiveView = view ?? defaultViewFor(def);
	const Cell = getCell(def.valueType, effectiveView);
	if (!Cell) {
		return <PropertyBlockUnavailableView def={def} view={effectiveView} />;
	}

	const value = note ? readValue(note.values, def) : readValue(undefined, def);
	const readOnly = note === null;
	return (
		<div className="notes__property-row" data-property-key={propertyKey}>
			<span className="notes__property-row-label" title={def.description}>
				{def.name}
			</span>
			<span className="notes__property-row-value">
				<Cell
					property={def}
					value={value}
					onChange={(next) => {
						if (!note) return;
						// The cell registry erases the valueType in its prop shape;
						// the runtime guarantee is that `next` matches the shape
						// required by `def.valueType` because `Cell` was looked up
						// by `(def.valueType, effectiveView)`.
						(note.setValue as (d: typeof def, v: unknown) => void)(def, next);
					}}
					readOnly={readOnly}
					noteId={note?.noteId ?? ""}
				/>
			</span>
		</div>
	);
}

export function $createPropertyBlockNode(
	propertyKey: string,
	view: PropertyView | null = null,
	blockId?: string,
): PropertyBlockNode {
	return new PropertyBlockNode(propertyKey, view, blockId);
}

export function $isPropertyBlockNode(
	node: LexicalNode | null | undefined,
): node is PropertyBlockNode {
	return node instanceof PropertyBlockNode;
}
