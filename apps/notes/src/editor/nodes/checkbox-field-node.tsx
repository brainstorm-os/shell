/**
 * CheckboxFieldNode — an inline, checkable boolean field (B11.3). Unlike
 * the list-level checklist (`CheckListPlugin`, a whole list item), this is
 * an inline chip you can drop inside a table cell or a paragraph to make a
 * "type-specific" cell — the common case being a status/done column in a
 * Notes table.
 *
 * The checked state IS shared content (a collaborator should see the box
 * the way you left it), so it lives on the node (`__checked`) and syncs
 * through the @lexical/yjs binding like any other instance field — the
 * opposite of the toggle-collapse case (B11.5), which is per-device.
 *
 * Rendering reuses the shared property-ui cell registry: the Boolean ×
 * Checkbox cell (`getCell(Boolean, Checkbox)` → `CheckboxCell`) is rendered
 * with a synthesised Boolean `PropertyDef`, so the box looks and behaves
 * exactly like a property cell everywhere else in the product.
 *
 * Persisted shape is protocol — don't rename `type` / `checked`.
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

export const CHECKBOX_FIELD_NODE_TYPE = "checkbox-field";

const CHECKBOX_FIELD_NODE_VERSION = 1 as const;

/** Synthesised def so the Boolean checkbox cell renders without a real
 *  vault property — the field IS its own value, there is no `PropertyDef`
 *  behind it. */
const CHECKBOX_DEF: PropertyDef & { valueType: ValueType.Boolean } = {
	key: CHECKBOX_FIELD_NODE_TYPE,
	name: "",
	icon: null,
	valueType: ValueType.Boolean,
};

export type SerializedCheckboxFieldNode = SerializedLexicalNode & {
	type: typeof CHECKBOX_FIELD_NODE_TYPE;
	version: typeof CHECKBOX_FIELD_NODE_VERSION;
	checked: boolean;
};

export class CheckboxFieldNode extends DecoratorNode<JSX.Element> {
	__checked: boolean;

	static override getType(): string {
		return CHECKBOX_FIELD_NODE_TYPE;
	}

	static override clone(node: CheckboxFieldNode): CheckboxFieldNode {
		return new CheckboxFieldNode(node.__checked, node.__key);
	}

	constructor(checked = false, key?: NodeKey) {
		super(key);
		this.__checked = checked;
	}

	static override importJSON(serialized: SerializedCheckboxFieldNode): CheckboxFieldNode {
		return new CheckboxFieldNode(serialized.checked === true);
	}

	override exportJSON(): SerializedCheckboxFieldNode {
		return {
			type: CHECKBOX_FIELD_NODE_TYPE,
			version: CHECKBOX_FIELD_NODE_VERSION,
			checked: this.__checked,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const span = document.createElement("span");
		span.className = "notes__checkbox-field";
		span.setAttribute("data-checked", String(this.__checked));
		return span;
	}

	override updateDOM(): false {
		return false;
	}

	isChecked(): boolean {
		return this.getLatest().__checked;
	}

	setChecked(checked: boolean): void {
		this.getWritable().__checked = checked;
	}

	/** Plain-text view — used by copy/paste, Markdown export and screen
	 *  readers. `[x]` / `[ ]` mirrors GFM task-list syntax. */
	override getTextContent(): string {
		return this.__checked ? "[x]" : "[ ]";
	}

	override isInline(): true {
		return true;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return <CheckboxFieldView nodeKey={this.getKey()} checked={this.__checked} />;
	}
}

function CheckboxFieldView({ nodeKey, checked }: { nodeKey: NodeKey; checked: boolean }) {
	const [editor] = useLexicalComposerContext();
	// The Boolean cell value can be single or multi-valued; this field is always
	// single, so coerce (the array branch never fires for a lone checkbox).
	const onChange = useCallback<CellProps<ValueType.Boolean>["onChange"]>(
		(next) => {
			const checkedNext = typeof next === "boolean" ? next : next[0]?.value === true;
			editor.update(() => {
				const node = $getNodeByKey(nodeKey);
				if ($isCheckboxFieldNode(node)) node.setChecked(checkedNext);
			});
		},
		[editor, nodeKey],
	);

	// `getCell` returns the registry's generic cell component; narrow it to the
	// Boolean cell's prop shape so the synthesised def + boolean value/onChange
	// type-check (the registry is keyed by (valueType, view), so this lookup is
	// always the Boolean checkbox cell).
	const Cell = getCell(ValueType.Boolean, PropertyView.Checkbox) as
		| ((props: CellProps<ValueType.Boolean>) => JSX.Element)
		| undefined;
	if (!Cell) return <span className="notes__checkbox-field-fallback" />;
	return (
		<span className="notes__checkbox-field-host" contentEditable={false}>
			<Cell
				property={CHECKBOX_DEF}
				value={checked}
				onChange={onChange}
				readOnly={!editor.isEditable()}
				// The checkbox cell doesn't read noteId (only relation/file cells
				// do); this field has no backing note property, so it's empty.
				noteId=""
			/>
		</span>
	);
}

export function $createCheckboxFieldNode(checked = false): CheckboxFieldNode {
	return $applyNodeReplacement(new CheckboxFieldNode(checked));
}

export function $isCheckboxFieldNode(node?: LexicalNode | null): node is CheckboxFieldNode {
	return node instanceof CheckboxFieldNode;
}
