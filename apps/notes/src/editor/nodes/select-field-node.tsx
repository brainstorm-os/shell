/**
 * SelectFieldNode — an inline, editable single-select field (B11.3). The
 * Select-typed sibling of `CheckboxFieldNode` / `DateFieldNode` /
 * `NumberFieldNode`: drop it inside a table cell (or any paragraph) to make a
 * "status" / "category" cell — pick one option from a small inline set.
 *
 * Unlike the Database grid's Select/Tag cell (which is dictionary-backed via a
 * vault `DictionaryStore`), this field is **self-contained**: the option set
 * AND the chosen value both live on the node and sync through the @lexical/yjs
 * binding — like `CheckboxFieldNode.__checked`. A standalone note cell has no
 * backing vault dictionary, so it carries its own tiny vocabulary. (The
 * dictionary-backed grid model stays at `9.12.23`.)
 *
 * Persisted shape is protocol — don't rename `type` / `options` / `value`.
 */

import {
	BodyKind,
	DimmerMode,
	FooterKind,
	Horizontal,
	KeyboardNavigation,
	type MenuCtx,
	MenuKind,
	PanelKind,
	RowKind,
	SourceKind,
	Vertical,
	defineMenu,
	getActiveMenuStore,
} from "@brainstorm/sdk/menus";
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
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";

export const SELECT_FIELD_NODE_TYPE = "select-field";

const SELECT_FIELD_NODE_VERSION = 1 as const;

/** Bound the inline vocabulary so a hand-edited / imported body can't carry a
 *  runaway option set or labels with control / bidi-override / zero-width
 *  characters (Trojan-Source). */
const MAX_OPTIONS = 100;
const MAX_LABEL_LEN = 64;

/** C0/C1 controls + zero-width + bidi-override (Trojan-Source) — the same set
 *  the persisted note-reference nodes strip. */
const STRIP_CONTROLS_RE = new RegExp(
	`[${"\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069"}]`,
	"g",
);

function clampLabel(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const cleaned = raw.replace(STRIP_CONTROLS_RE, "").trim().slice(0, MAX_LABEL_LEN);
	return cleaned.length > 0 ? cleaned : null;
}

/** Non-empty, de-duped, length-bounded option labels. */
function clampOptions(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const label = clampLabel(item);
		if (!label || seen.has(label)) continue;
		seen.add(label);
		out.push(label);
		if (out.length >= MAX_OPTIONS) break;
	}
	return out;
}

/** The value must be one of the (clamped) options, else cleared. */
function clampValue(raw: unknown, options: readonly string[]): string | null {
	const label = clampLabel(raw);
	return label && options.includes(label) ? label : null;
}

export type SerializedSelectFieldNode = SerializedLexicalNode & {
	type: typeof SELECT_FIELD_NODE_TYPE;
	version: typeof SELECT_FIELD_NODE_VERSION;
	options: string[];
	value: string | null;
};

export class SelectFieldNode extends DecoratorNode<JSX.Element> {
	__options: readonly string[];
	__value: string | null;

	static override getType(): string {
		return SELECT_FIELD_NODE_TYPE;
	}

	static override clone(node: SelectFieldNode): SelectFieldNode {
		return new SelectFieldNode([...node.__options], node.__value, node.__key);
	}

	constructor(options: readonly string[] = [], value: string | null = null, key?: NodeKey) {
		super(key);
		this.__options = options;
		this.__value = value;
	}

	static override importJSON(serialized: SerializedSelectFieldNode): SelectFieldNode {
		const options = clampOptions(serialized.options);
		return new SelectFieldNode(options, clampValue(serialized.value, options));
	}

	override exportJSON(): SerializedSelectFieldNode {
		return {
			type: SELECT_FIELD_NODE_TYPE,
			version: SELECT_FIELD_NODE_VERSION,
			options: [...this.__options],
			value: this.__value,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const span = document.createElement("span");
		span.className = "notes__select-field";
		span.setAttribute("data-empty", String(this.__value === null));
		return span;
	}

	override updateDOM(): false {
		return false;
	}

	getOptions(): readonly string[] {
		return this.getLatest().__options;
	}

	getValue(): string | null {
		return this.getLatest().__value;
	}

	setValue(value: string | null): void {
		const self = this.getWritable();
		self.__value = value !== null && self.__options.includes(value) ? value : null;
	}

	/** Append a new option (clamped + de-duped) and return its stored label, or
	 *  null if the label was empty / already present at the option cap. */
	addOption(rawLabel: string): string | null {
		const label = clampLabel(rawLabel);
		if (!label) return null;
		const self = this.getWritable();
		if (self.__options.includes(label)) return label;
		if (self.__options.length >= MAX_OPTIONS) return null;
		self.__options = [...self.__options, label];
		return label;
	}

	removeOption(label: string): void {
		const self = this.getWritable();
		self.__options = self.__options.filter((o) => o !== label);
		if (self.__value === label) self.__value = null;
	}

	/** Plain-text view — used by copy/paste, Markdown export and screen
	 *  readers. The selected label, empty value → empty string. */
	override getTextContent(): string {
		return this.__value ?? "";
	}

	override isInline(): true {
		return true;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return <SelectFieldView nodeKey={this.getKey()} options={this.__options} value={this.__value} />;
	}
}

/**
 * The picker is rendered through the shared fancy-menus runtime (anchored to
 * the chip), not a hand-rolled portal: a list of option rows — each a pick
 * button + an inline × remove — over a custom footer that adds a new option.
 * `CustomRow` carries the per-row pick/remove buttons (no shared menu primitive
 * has an inline secondary action), the custom footer the add input. One field's
 * picker is open at a time, so the row/footer handlers read module-level refs
 * set on open. The runtime owns positioning, dismissal (outside-click + Escape),
 * and the glass chrome; this owns the option mutations.
 */

const SELECT_FIELD_MENU_ID = "bs/notes-select-field";

type SelectFieldMenuData = { options: readonly string[]; value: string | null };

let onPickRef: ((label: string) => void) | null = null;
let onRemoveRef: ((label: string) => void) | null = null;
let onAddRef: ((label: string) => void) | null = null;
let onCloseRef: (() => void) | null = null;

function SelectFieldOptionRow({ label, active }: { label: string; active: boolean }) {
	return (
		<span className="notes__select-field-row">
			{/* Act on mousedown + preventDefault: a plain click would steal the
			    editor selection (re-decorating the node) before it commits. */}
			<button
				type="button"
				role="option"
				aria-selected={active}
				className={`notes__select-field-option${active ? " notes__select-field-option--active" : ""}`}
				onMouseDown={(e) => {
					e.preventDefault();
					onPickRef?.(label);
				}}
			>
				{label}
			</button>
			<button
				type="button"
				className="notes__select-field-remove"
				aria-label={t("notes.select.remove")}
				onMouseDown={(e) => {
					e.preventDefault();
					onRemoveRef?.(label);
				}}
			>
				×
			</button>
		</span>
	);
}

function SelectFieldAddRow() {
	const [draft, setDraft] = useState("");
	return (
		<div className="notes__select-field-add">
			<input
				className="bs-input bs-input--sm notes__select-field-input"
				value={draft}
				placeholder={t("notes.select.addOption")}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					// keyboard-exempt: an inline add affordance, not a registered chord.
					if (e.key === "Enter" && draft.trim().length > 0) {
						e.preventDefault();
						onAddRef?.(draft);
						setDraft("");
					}
				}}
			/>
		</div>
	);
}

const selectFieldMenuConfig = defineMenu<SelectFieldMenuData>({
	id: SELECT_FIELD_MENU_ID,
	kind: MenuKind.Context,
	chrome: {
		role: "listbox",
		dimmer: DimmerMode.None,
		footer: { kind: FooterKind.Custom, render: () => <SelectFieldAddRow /> },
	},
	body: {
		kind: BodyKind.List,
		source: {
			kind: SourceKind.Composite,
			sources: [{ kind: SourceKind.Prop, getItems: (data) => [...data.options] }],
		},
		rows: [
			{
				kind: RowKind.Custom,
				match: () => true,
				render: (label: string, ctx: MenuCtx<SelectFieldMenuData>) => (
					<SelectFieldOptionRow label={label} active={ctx.data.value === label} />
				),
			},
		],
		emptyState: { kind: PanelKind.EmptyState, message: t("notes.select.noOptions") },
		// A field's option set is small + bounded (MAX_OPTIONS); skip the
		// virtualizer so every row paints (it also needs a measured height the
		// menu doesn't give a short list).
		virtualized: false,
		// The host chip / footer input own focus; the list never grabs it.
		focusOnMount: false,
	},
	position: {
		vertical: Vertical.Bottom,
		horizontal: Horizontal.Left,
		offsetY: 4,
		minWidth: 220,
		followAnchor: true,
	},
	// Click-driven (the original had no arrow nav); the runtime still closes on
	// Escape + outside-click.
	keyboard: { navigation: KeyboardNavigation.None, defaults: { selectOnEnter: false } },
	lifecycle: {
		onClose: () => {
			const cb = onCloseRef;
			onPickRef = null;
			onRemoveRef = null;
			onAddRef = null;
			onCloseRef = null;
			cb?.();
		},
	},
});

function openSelectFieldMenu(opts: {
	anchor: Element;
	options: readonly string[];
	value: string | null;
	onPick: (label: string) => void;
	onRemove: (label: string) => void;
	onAdd: (label: string) => void;
	onClose: () => void;
}): boolean {
	const store = getActiveMenuStore();
	if (!store) return false;
	if (!store.getConfig(SELECT_FIELD_MENU_ID)) store.register(selectFieldMenuConfig);
	onPickRef = opts.onPick;
	onRemoveRef = opts.onRemove;
	onAddRef = opts.onAdd;
	onCloseRef = opts.onClose;
	const param = {
		data: { options: opts.options, value: opts.value },
		element: opts.anchor,
		ariaLabel: t("notes.select.menuRegion"),
	};
	if (store.isOpen(SELECT_FIELD_MENU_ID)) store.update(SELECT_FIELD_MENU_ID, param);
	else store.open(SELECT_FIELD_MENU_ID, param);
	return true;
}

/** Push the latest options/value into the open picker (e.g. after a remove,
 *  which keeps the picker open). */
function updateSelectFieldMenu(options: readonly string[], value: string | null): void {
	const store = getActiveMenuStore();
	if (store?.isOpen(SELECT_FIELD_MENU_ID)) {
		store.update(SELECT_FIELD_MENU_ID, { data: { options, value } });
	}
}

function closeSelectFieldMenu(): void {
	getActiveMenuStore()?.close(SELECT_FIELD_MENU_ID);
}

export function SelectFieldView({
	nodeKey,
	options,
	value,
}: {
	nodeKey: NodeKey;
	options: readonly string[];
	value: string | null;
}) {
	const [editor] = useLexicalComposerContext();
	const [open, setOpen] = useState(false);
	const hostRef = useRef<HTMLSpanElement | null>(null);
	const readOnly = !editor.isEditable();

	const pick = useCallback(
		(label: string) => {
			editor.update(() => {
				const node = $getNodeByKey(nodeKey);
				if ($isSelectFieldNode(node)) node.setValue(node.getValue() === label ? null : label);
			});
			closeSelectFieldMenu();
		},
		[editor, nodeKey],
	);

	const remove = useCallback(
		(label: string) => {
			// Keeps the picker open (the synced data drops the row).
			editor.update(() => {
				const node = $getNodeByKey(nodeKey);
				if ($isSelectFieldNode(node)) node.removeOption(label);
			});
		},
		[editor, nodeKey],
	);

	const add = useCallback(
		(rawLabel: string) => {
			editor.update(() => {
				const node = $getNodeByKey(nodeKey);
				if (!$isSelectFieldNode(node)) return;
				const label = node.addOption(rawLabel);
				if (label) node.setValue(label);
			});
			closeSelectFieldMenu();
		},
		[editor, nodeKey],
	);

	const openMenu = useCallback(() => {
		if (!hostRef.current) return;
		const opened = openSelectFieldMenu({
			anchor: hostRef.current,
			options,
			value,
			onPick: pick,
			onRemove: remove,
			onAdd: add,
			onClose: () => setOpen(false),
		});
		if (opened) setOpen(true);
	}, [options, value, pick, remove, add]);

	// Keep the open picker's rows + check in sync as the node's options/value
	// change (a remove keeps it open; a sync arrives on the next decorate).
	useEffect(() => {
		if (open) updateSelectFieldMenu(options, value);
	}, [open, options, value]);

	// Close the picker if the node unmounts while it's open.
	useEffect(() => () => closeSelectFieldMenu(), []);

	return (
		<span className="notes__select-field-host" contentEditable={false} ref={hostRef}>
			<button
				type="button"
				className={`notes__select-field-chip${value === null ? " notes__select-field-chip--empty" : ""}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={readOnly}
				onClick={() => (open ? closeSelectFieldMenu() : openMenu())}
			>
				{value ?? t("notes.select.placeholder")}
			</button>
		</span>
	);
}

export function $createSelectFieldNode(
	options: readonly string[] = [],
	value: string | null = null,
): SelectFieldNode {
	return $applyNodeReplacement(new SelectFieldNode(options, value));
}

export function $isSelectFieldNode(node?: LexicalNode | null): node is SelectFieldNode {
	return node instanceof SelectFieldNode;
}
