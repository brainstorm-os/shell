/**
 * DateFieldNode — an inline, editable date field (B11.3). The Date-typed
 * counterpart to `CheckboxFieldNode`: drop it inside a table cell (or any
 * paragraph) to make a "type-specific" cell — the common case being a due-
 * date / scheduled column in a Notes table.
 *
 * Distinct from the `@date` typeahead chip (`DateMentionNode`), which is a
 * read-only reference to a fixed calendar day written in prose. A
 * `DateFieldNode` is *editable* — clicking it opens the same natural-
 * language date popover every property cell uses, and the picked value is
 * shared content (a collaborator sees the date you set), so it lives on the
 * node (`__value`) and syncs through the @lexical/yjs binding — like
 * `CheckboxFieldNode.__checked`, the opposite of the per-device toggle case.
 *
 * Rendering reuses the shared property-ui cell registry: the Date × Plain
 * cell (`getCell(Date, Plain)` → `DateCell`) is rendered with a synthesised
 * single-valued Date `PropertyDef`, so the field looks and behaves exactly
 * like a date property cell everywhere else in the product.
 *
 * Persisted shape is protocol — don't rename `type` / `at` / `granularity`.
 */

import {
	type CellProps,
	DateGranularity,
	type DateValue,
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

export const DATE_FIELD_NODE_TYPE = "date-field";

const DATE_FIELD_NODE_VERSION = 1 as const;

/** Granularity values we accept off the wire; anything else clamps to
 *  `Date`. Hostile / legacy imports can carry an arbitrary string here. */
const GRANULARITIES: ReadonlySet<string> = new Set([
	DateGranularity.Date,
	DateGranularity.DateTime,
	DateGranularity.Time,
]);

function clampGranularity(raw: unknown): DateGranularity {
	return typeof raw === "string" && GRANULARITIES.has(raw)
		? (raw as DateGranularity)
		: DateGranularity.Date;
}

/** A finite epoch-millis number, else `null` — defangs `NaN` / `Infinity`
 *  / non-number payloads from an imported or hand-edited body. */
function clampAt(raw: unknown): number | null {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export type SerializedDateFieldNode = SerializedLexicalNode & {
	type: typeof DATE_FIELD_NODE_TYPE;
	version: typeof DATE_FIELD_NODE_VERSION;
	at: number | null;
	granularity: DateGranularity;
};

/** Build the synthesised def for the Date cell. `granularity` tracks the
 *  node's own value so the popover edits at the right precision; no `count`
 *  → single-valued, so `coerceValue` returns a scalar `DateValue | null`. */
function dateDef(granularity: DateGranularity): PropertyDef & { valueType: ValueType.Date } {
	return {
		key: DATE_FIELD_NODE_TYPE,
		name: "",
		icon: null,
		valueType: ValueType.Date,
		granularity,
	};
}

/** Plain-text view of a date value — used by copy/paste, Markdown export
 *  and screen readers. ISO-ish so it round-trips legibly outside the app;
 *  precision follows the granularity. Empty value → empty string. */
export function dateFieldText(value: DateValue | null): string {
	if (!value) return "";
	const d = new Date(value.at);
	if (Number.isNaN(d.getTime())) return "";
	const iso = d.toISOString();
	switch (value.granularity) {
		case DateGranularity.Time:
			return iso.slice(11, 16);
		case DateGranularity.DateTime:
			return iso.slice(0, 16).replace("T", " ");
		default:
			return iso.slice(0, 10);
	}
}

export class DateFieldNode extends DecoratorNode<JSX.Element> {
	__value: DateValue | null;

	static override getType(): string {
		return DATE_FIELD_NODE_TYPE;
	}

	static override clone(node: DateFieldNode): DateFieldNode {
		return new DateFieldNode(node.__value, node.__key);
	}

	constructor(value: DateValue | null = null, key?: NodeKey) {
		super(key);
		this.__value = value;
	}

	static override importJSON(serialized: SerializedDateFieldNode): DateFieldNode {
		const at = clampAt(serialized.at);
		const value = at === null ? null : { at, granularity: clampGranularity(serialized.granularity) };
		return new DateFieldNode(value);
	}

	override exportJSON(): SerializedDateFieldNode {
		return {
			type: DATE_FIELD_NODE_TYPE,
			version: DATE_FIELD_NODE_VERSION,
			at: this.__value ? this.__value.at : null,
			granularity: this.__value ? this.__value.granularity : DateGranularity.Date,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const span = document.createElement("span");
		span.className = "notes__date-field";
		span.setAttribute("data-empty", String(this.__value === null));
		return span;
	}

	override updateDOM(): false {
		return false;
	}

	getValue(): DateValue | null {
		return this.getLatest().__value;
	}

	setValue(value: DateValue | null): void {
		this.getWritable().__value = value;
	}

	override getTextContent(): string {
		return dateFieldText(this.__value);
	}

	override isInline(): true {
		return true;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return <DateFieldView nodeKey={this.getKey()} value={this.__value} />;
	}
}

function DateFieldView({ nodeKey, value }: { nodeKey: NodeKey; value: DateValue | null }) {
	const [editor] = useLexicalComposerContext();
	// The Date cell value can be single or multi-valued; this field is always
	// single, so coerce (the array branch never fires for a lone field).
	const onChange = useCallback<CellProps<ValueType.Date>["onChange"]>(
		(next) => {
			const nextValue = Array.isArray(next) ? (next[0]?.value ?? null) : next;
			editor.update(() => {
				const node = $getNodeByKey(nodeKey);
				if ($isDateFieldNode(node)) node.setValue(nextValue);
			});
		},
		[editor, nodeKey],
	);

	// `getCell` returns the registry's generic cell component; narrow it to the
	// Date cell's prop shape so the synthesised def + value/onChange type-check
	// (the registry is keyed by (valueType, view), so this lookup is the Date
	// cell).
	const Cell = getCell(ValueType.Date, PropertyView.Plain) as
		| ((props: CellProps<ValueType.Date>) => JSX.Element)
		| undefined;
	if (!Cell) return <span className="notes__date-field-fallback" />;
	const granularity = value?.granularity ?? DateGranularity.Date;
	return (
		<span className="notes__date-field-host" contentEditable={false}>
			<Cell
				property={dateDef(granularity)}
				value={value}
				onChange={onChange}
				readOnly={!editor.isEditable()}
				// The date cell doesn't read noteId (only relation/file cells do);
				// this field has no backing note property, so it's empty.
				noteId=""
			/>
		</span>
	);
}

export function $createDateFieldNode(value: DateValue | null = null): DateFieldNode {
	return $applyNodeReplacement(new DateFieldNode(value));
}

export function $isDateFieldNode(node?: LexicalNode | null): node is DateFieldNode {
	return node instanceof DateFieldNode;
}
