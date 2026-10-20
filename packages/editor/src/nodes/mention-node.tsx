/**
 * MentionNode — inline reference to another vault entity, rendered as
 * a chip. Created by typing `@<query>` in the editor and picking from
 * the typeahead. Carries `entityId` + `entityType` + the resolved
 * `label` (captured at insertion time so the chip survives if the
 * entity is later renamed; the typeahead refreshes the label whenever
 * the user re-mentions).
 *
 * Inline `DecoratorNode` so the chip can host an entity icon + label
 * with a click handler that dispatches `intent.open` once link
 * resolution lands. The chip's plain-text view is `@<label>`, which
 * keeps copy/paste / Markdown export / accessibility readouts intact
 * even outside Brainstorm.
 *
 * Persisted shape lives in the note's `SerializedEditorState` and is
 * what the shell-side `extract-note-references` helper scans against
 * to emit `VaultLink` rows for the Graph app. Schema is therefore
 * protocol — don't rename `type` / `entityId` / `entityType` / `label`
 * without updating that walker.
 */

import {
	$applyNodeReplacement,
	type DOMConversionMap,
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { JSX } from "react";
import { useSyncExternalStore } from "react";
import { EntityIcon } from "../entity-icon";
import {
	entityIconsSnapshot,
	getEntityIcon,
	getEntityTitle,
	subscribeEntityIcons,
} from "../plugins/entity-index";
import { TaskCheckbox } from "../task-checkbox";
import { TASK_ENTITY_TYPE } from "../task-entity";

export const MENTION_NODE_TYPE = "mention";

const MENTION_NODE_VERSION = 1 as const;

export type SerializedMentionNode = SerializedLexicalNode & {
	type: typeof MENTION_NODE_TYPE;
	version: typeof MENTION_NODE_VERSION;
	entityId: string;
	entityType: string;
	label: string;
};

export class MentionNode extends DecoratorNode<JSX.Element> {
	__entityId: string;
	__entityType: string;
	__label: string;

	static override getType(): string {
		return MENTION_NODE_TYPE;
	}

	static override clone(node: MentionNode): MentionNode {
		return new MentionNode(node.__entityId, node.__entityType, node.__label, node.__key);
	}

	constructor(entityId: string, entityType: string, label: string, key?: NodeKey) {
		super(key);
		this.__entityId = entityId;
		this.__entityType = entityType;
		this.__label = label;
	}

	static override importJSON(serialized: SerializedMentionNode): MentionNode {
		const entityId = typeof serialized.entityId === "string" ? serialized.entityId : "";
		const entityType = typeof serialized.entityType === "string" ? serialized.entityType : "";
		const label = typeof serialized.label === "string" ? serialized.label : "";
		return new MentionNode(entityId, entityType, label);
	}

	override exportJSON(): SerializedMentionNode {
		return {
			type: MENTION_NODE_TYPE,
			version: MENTION_NODE_VERSION,
			entityId: this.__entityId,
			entityType: this.__entityType,
			label: this.__label,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(config: EditorConfig): HTMLElement {
		const span = document.createElement("span");
		const themeClass = config.theme.mention;
		span.className = typeof themeClass === "string" ? themeClass : "notes__mention";
		span.setAttribute("data-entity-id", this.__entityId);
		span.setAttribute("data-entity-type", this.__entityType);
		span.setAttribute("spellcheck", "false");
		return span;
	}

	override updateDOM(): false {
		return false;
	}

	getEntityId(): string {
		return this.__entityId;
	}

	getEntityType(): string {
		return this.__entityType;
	}

	getLabel(): string {
		return this.__label;
	}

	setLabel(label: string): void {
		this.getWritable().__label = label;
	}

	/** Plain-text view of the chip. Used by copy/paste, Markdown export,
	 *  and screen readers. Mirrors the inline `@<label>` rendering. */
	override getTextContent(): string {
		return `@${this.__label}`;
	}

	override isInline(): true {
		return true;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return (
			<MentionView entityId={this.__entityId} entityType={this.__entityType} label={this.__label} />
		);
	}
}

function MentionView({
	entityId,
	entityType,
	label,
}: {
	entityId: string;
	entityType: string;
	label: string;
}) {
	// Re-render when the vault-entities snapshot changes so a chip whose
	// entity loads / is renamed / re-iconed after mount picks up the icon.
	useSyncExternalStore(subscribeEntityIcons, entityIconsSnapshot);
	const icon = getEntityIcon(entityId);
	// A task chip (B11.24) follows the task's live name — it's renamed in the
	// Tasks app far more often than a mentioned page is.
	const isTask = entityType === TASK_ENTITY_TYPE;
	const stored = label.trim().length > 0 ? label : entityId;
	const displayLabel = isTask ? (getEntityTitle(entityId) ?? stored) : stored;
	return (
		<span
			className={isTask ? "notes__mention-chip notes__mention-chip--task" : "notes__mention-chip"}
			data-entity-id={entityId}
			data-entity-type={entityType}
		>
			{isTask ? (
				<TaskCheckbox entityId={entityId} label={displayLabel} />
			) : (
				<span className="notes__mention-at" aria-hidden="true">
					@
				</span>
			)}
			<EntityIcon icon={icon} size={14} className="notes__mention-glyph" />
			<span className="notes__mention-label">{displayLabel}</span>
		</span>
	);
}

export function $createMentionNode(
	entityId: string,
	entityType: string,
	label: string,
): MentionNode {
	return $applyNodeReplacement(new MentionNode(entityId, entityType, label));
}

export function $isMentionNode(node?: LexicalNode | null): node is MentionNode {
	return node instanceof MentionNode;
}
