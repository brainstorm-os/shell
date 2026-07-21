/**
 * PropertyListBlockNode — N properties rendered together as a card
 * (`__propertyKeys[]`, optional `__title`, optional `__collapsed`).
 * Each row falls back to the kind's default view; switching a single
 * row's view requires extracting it into a standalone PropertyBlock.
 *
 * Same Lexical / selection / serialization contract as
 * `PropertyBlockNode` — see that file for the rationale and for the
 * NoteContext / PropertiesProvider data wiring. The list-block view
 * delegates each row's render to `<PropertyBlockView>`-equivalent
 * logic, sharing the cell registry + fallbacks.
 */

import { defaultViewFor } from "@brainstorm-os/sdk-types";
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
import { t } from "../../i18n/t";
import { AddPropertyTargetKind, addPropertyStore } from "../add-property-store";
import { useNoteContextOptional } from "../note-context";
import { PropertyBlockFallback, PropertyBlockUnavailableView } from "./property-block-fallback";
import { newPropertyListBlockId } from "./property-block-id";

export const PROPERTY_LIST_BLOCK_TYPE = "property-list-block";
const PROPERTY_LIST_BLOCK_VERSION = 1 as const;

export type SerializedPropertyListBlockNode = SerializedLexicalNode & {
	type: typeof PROPERTY_LIST_BLOCK_TYPE;
	version: typeof PROPERTY_LIST_BLOCK_VERSION;
	blockId: string;
	propertyKeys: string[];
	collapsed: boolean;
	title: string | null;
};

export class PropertyListBlockNode extends DecoratorNode<JSX.Element> {
	__blockId: string;
	__propertyKeys: string[];
	__collapsed: boolean;
	__title: string | null;

	static override getType(): string {
		return PROPERTY_LIST_BLOCK_TYPE;
	}

	static override clone(node: PropertyListBlockNode): PropertyListBlockNode {
		return new PropertyListBlockNode(
			[...node.__propertyKeys],
			node.__title,
			node.__collapsed,
			node.__blockId,
			node.__key,
		);
	}

	constructor(
		propertyKeys: readonly string[] = [],
		title: string | null = null,
		collapsed = false,
		blockId?: string,
		key?: NodeKey,
	) {
		super(key);
		this.__propertyKeys = [...propertyKeys];
		this.__title = title;
		this.__collapsed = collapsed;
		this.__blockId = blockId ?? newPropertyListBlockId();
	}

	static override importJSON(serialized: SerializedPropertyListBlockNode): PropertyListBlockNode {
		const keys = Array.isArray(serialized.propertyKeys)
			? serialized.propertyKeys.filter((k): k is string => typeof k === "string")
			: [];
		const title =
			typeof serialized.title === "string" && serialized.title.length > 0 ? serialized.title : null;
		const collapsed = serialized.collapsed === true;
		const blockId =
			typeof serialized.blockId === "string" && serialized.blockId.length > 0
				? serialized.blockId
				: undefined;
		return new PropertyListBlockNode(keys, title, collapsed, blockId);
	}

	override exportJSON(): SerializedPropertyListBlockNode {
		return {
			type: PROPERTY_LIST_BLOCK_TYPE,
			version: PROPERTY_LIST_BLOCK_VERSION,
			blockId: this.__blockId,
			propertyKeys: [...this.__propertyKeys],
			collapsed: this.__collapsed,
			title: this.__title,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		const themeClass = config.theme.propertyListBlock;
		el.className = typeof themeClass === "string" ? themeClass : "notes__property-list-block";
		el.setAttribute("data-block-id", this.__blockId);
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	getBlockId(): string {
		return this.__blockId;
	}

	getPropertyKeys(): readonly string[] {
		return this.__propertyKeys;
	}

	getTitle(): string | null {
		return this.__title;
	}

	getCollapsed(): boolean {
		return this.__collapsed;
	}

	setPropertyKeys(keys: readonly string[]): void {
		this.getWritable().__propertyKeys = [...keys];
	}

	addPropertyKey(key: string): void {
		const writable = this.getWritable();
		if (writable.__propertyKeys.includes(key)) return;
		writable.__propertyKeys = [...writable.__propertyKeys, key];
	}

	removePropertyKey(key: string): void {
		const writable = this.getWritable();
		writable.__propertyKeys = writable.__propertyKeys.filter((k) => k !== key);
	}

	setTitle(title: string | null): void {
		this.getWritable().__title = title;
	}

	setCollapsed(collapsed: boolean): void {
		this.getWritable().__collapsed = collapsed;
	}

	override decorate(): JSX.Element {
		return (
			<PropertyListBlockView
				nodeKey={this.getKey()}
				propertyKeys={this.__propertyKeys}
				title={this.__title}
				collapsed={this.__collapsed}
			/>
		);
	}

	override isInline(): false {
		return false;
	}
}

function PropertyListBlockView({
	nodeKey,
	propertyKeys,
	title,
	collapsed,
}: {
	nodeKey: NodeKey;
	propertyKeys: readonly string[];
	title: string | null;
	collapsed: boolean;
}): JSX.Element {
	const headerTitle = title && title.length > 0 ? title : t("notes.propertyList.defaultTitle");
	const onAdd = (event: React.MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		addPropertyStore.open({
			kind: AddPropertyTargetKind.AppendToList,
			listKey: nodeKey,
			anchor: rect,
		});
	};
	return (
		<section className="notes__property-list" aria-label={t("notes.propertyList.region")}>
			<header className="notes__property-list-header">
				<span className="notes__property-list-title">{headerTitle}</span>
			</header>
			{collapsed ? null : (
				<div className="notes__property-list-body">
					{propertyKeys.length === 0 ? (
						<div className="notes__property-list-empty">{t("notes.propertyList.empty")}</div>
					) : (
						propertyKeys.map((key) => <PropertyListRow key={key} propertyKey={key} />)
					)}
					<button type="button" className="notes__property-list-add" onClick={onAdd}>
						<span aria-hidden="true">+</span>
						<span>{t("notes.propertyList.addButton")}</span>
					</button>
				</div>
			)}
		</section>
	);
}

function PropertyListRow({ propertyKey }: { propertyKey: string }): JSX.Element {
	const def = useProperty(propertyKey);
	const note = useNoteContextOptional();

	if (!def) {
		return <PropertyBlockFallback propertyKey={propertyKey} />;
	}

	const effectiveView = defaultViewFor(def);
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
						(note.setValue as (d: typeof def, v: unknown) => void)(def, next);
					}}
					readOnly={readOnly}
					noteId={note?.noteId ?? ""}
				/>
			</span>
		</div>
	);
}

export function $createPropertyListBlockNode(
	propertyKeys: readonly string[] = [],
	title: string | null = null,
	collapsed = false,
	blockId?: string,
): PropertyListBlockNode {
	return new PropertyListBlockNode(propertyKeys, title, collapsed, blockId);
}

export function $isPropertyListBlockNode(
	node: LexicalNode | null | undefined,
): node is PropertyListBlockNode {
	return node instanceof PropertyListBlockNode;
}
