/**
 * NumberFieldNode — an inline, editable number field (B11.3). The Number-
 * typed sibling of `CheckboxFieldNode` / `DateFieldNode`: drop it inside a
 * table cell (or any paragraph) to make a "type-specific" cell — the common
 * case being a quantity / price / score column in a Notes table.
 *
 * The value IS shared content (a collaborator sees the number you set), so it
 * lives on the node (`__value`) and syncs through the @lexical/yjs binding —
 * like `CheckboxFieldNode.__checked`, the opposite of the per-device toggle
 * case.
 *
 * Rendering reuses the shared property-ui cell registry: the Number × Plain
 * cell (`getCell(Number, Plain)` → `PlainCell`) is rendered with a synthesised
 * single-valued Number `PropertyDef`, so the field is click-to-edit through
 * the same `<input type="number">` inline editor every property cell uses.
 *
 * Persisted shape is protocol — don't rename `type` / `value`.
 */

import {
	type CellProps,
	type PropertyDef,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { getCell } from "@brainstorm-os/sdk/property-ui";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$applyNodeReplacement,
	$getNodeByKey,
	type DOMConversionMap,
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { JSX } from "react";
import { useCallback } from "react";

export const NUMBER_FIELD_NODE_TYPE = "number-field";

const NUMBER_FIELD_NODE_VERSION = 1 as const;

/** A finite number, else `null` — defangs `NaN` / `Infinity` / non-number
 *  payloads from an imported or hand-edited body. */
function clampNumber(raw: unknown): number | null {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Synthesised def so the Number plain cell renders without a real vault
 *  property — the field IS its own value. No `count` → single-valued, so
 *  `coerceValue` returns a scalar `number | null`. */
const NUMBER_DEF: PropertyDef & { valueType: ValueType.Number } = {
	key: NUMBER_FIELD_NODE_TYPE,
	name: "",
	icon: null,
	valueType: ValueType.Number,
};

export type SerializedNumberFieldNode = SerializedLexicalNode & {
	type: typeof NUMBER_FIELD_NODE_TYPE;
	version: typeof NUMBER_FIELD_NODE_VERSION;
	value: number | null;
};

export class NumberFieldNode extends DecoratorNode<JSX.Element> {
	__value: number | null;

	static override getType(): string {
		return NUMBER_FIELD_NODE_TYPE;
	}

	static override clone(node: NumberFieldNode): NumberFieldNode {
		return new NumberFieldNode(node.__value, node.__key);
	}

	constructor(value: number | null = null, key?: NodeKey) {
		super(key);
		this.__value = value;
	}

	static override importJSON(serialized: SerializedNumberFieldNode): NumberFieldNode {
		return new NumberFieldNode(clampNumber(serialized.value));
	}

	override exportJSON(): SerializedNumberFieldNode {
		return {
			type: NUMBER_FIELD_NODE_TYPE,
			version: NUMBER_FIELD_NODE_VERSION,
			value: this.__value,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const span = document.createElement("span");
		span.className = "notes__number-field";
		span.setAttribute("data-empty", String(this.__value === null));
		return span;
	}

	override updateDOM(): false {
		return false;
	}

	getValue(): number | null {
		return this.getLatest().__value;
	}

	setValue(value: number | null): void {
		this.getWritable().__value = value;
	}

	/** Plain-text view — used by copy/paste, Markdown export and screen
	 *  readers. The raw number, empty value → empty string. */
	override getTextContent(): string {
		return this.__value === null ? "" : String(this.__value);
	}

	override isInline(): true {
		return true;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return <NumberFieldView nodeKey={this.getKey()} value={this.__value} />;
	}
}

function NumberFieldView({ nodeKey, value }: { nodeKey: NodeKey; value: number | null }) {
	const [editor] = useLexicalComposerContext();
	// The Number cell value can be single or multi-valued; this field is always
	// single, so coerce (the array branch never fires for a lone field).
	const onChange = useCallback<CellProps<ValueType.Number>["onChange"]>(
		(next) => {
			const nextValue = Array.isArray(next) ? (next[0]?.value ?? null) : next;
			editor.update(() => {
				const node = $getNodeByKey(nodeKey);
				if ($isNumberFieldNode(node)) node.setValue(nextValue);
			});
		},
		[editor, nodeKey],
	);

	// `getCell` returns the registry's generic cell component; narrow it to the
	// Number cell's prop shape so the synthesised def + value/onChange
	// type-check (the registry is keyed by (valueType, view), so this lookup is
	// the Number plain cell).
	const Cell = getCell(ValueType.Number, PropertyView.Plain) as
		| ((props: CellProps<ValueType.Number>) => JSX.Element)
		| undefined;
	if (!Cell) return <span className="notes__number-field-fallback" />;
	return (
		<span className="notes__number-field-host" contentEditable={false}>
			<Cell
				property={NUMBER_DEF}
				value={value}
				onChange={onChange}
				readOnly={!editor.isEditable()}
				// The number cell doesn't read noteId (only relation/file cells do);
				// this field has no backing note property, so it's empty.
				noteId=""
			/>
		</span>
	);
}

export function $createNumberFieldNode(value: number | null = null): NumberFieldNode {
	return $applyNodeReplacement(new NumberFieldNode(value));
}

export function $isNumberFieldNode(node?: LexicalNode | null): node is NumberFieldNode {
	return node instanceof NumberFieldNode;
}
