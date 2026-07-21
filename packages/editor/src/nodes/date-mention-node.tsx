/**
 * DateMentionNode — inline chip for a date reference (B11.1). Created by
 * typing `@today` / `@tomorrow` / `@yesterday` / an ISO `YYYY-MM-DD` in
 * the `@` typeahead and picking the date option.
 *
 * A date is NOT a vault entity, so this is a separate node from
 * `MentionNode` — keeping them distinct means the shell-side
 * `extract-note-references` walker (which scans `MentionNode` /
 * `PageRefNode` / `TransclusionNode` for `VaultLink` rows) never mistakes
 * a date for an entity edge. The chip stores the resolved `iso`
 * (`YYYY-MM-DD`, the stored value Calendar/Journal key days by) plus the
 * `label` shown at insertion time (`Today` / the ISO). Routing a click to
 * the day in Calendar/Journal is a follow-up — there is no date-target
 * open intent yet, so the chip is non-navigational for now.
 *
 * Persisted shape is protocol — don't rename `type` / `iso` / `label`.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
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

export const DATE_MENTION_NODE_TYPE = "date-mention";

const DATE_MENTION_NODE_VERSION = 1 as const;

/** Hard cap on the persisted strings — a hostile imported body can't
 *  smuggle a multi-megabyte label/iso through the editor state. */
const MAX_FIELD_LEN = 64;

function clampField(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.length > MAX_FIELD_LEN ? value.slice(0, MAX_FIELD_LEN) : value;
}

export type SerializedDateMentionNode = SerializedLexicalNode & {
	type: typeof DATE_MENTION_NODE_TYPE;
	version: typeof DATE_MENTION_NODE_VERSION;
	iso: string;
	label: string;
};

export class DateMentionNode extends DecoratorNode<JSX.Element> {
	__iso: string;
	__label: string;

	static override getType(): string {
		return DATE_MENTION_NODE_TYPE;
	}

	static override clone(node: DateMentionNode): DateMentionNode {
		return new DateMentionNode(node.__iso, node.__label, node.__key);
	}

	constructor(iso: string, label: string, key?: NodeKey) {
		super(key);
		this.__iso = iso;
		this.__label = label;
	}

	static override importJSON(serialized: SerializedDateMentionNode): DateMentionNode {
		return new DateMentionNode(clampField(serialized.iso), clampField(serialized.label));
	}

	override exportJSON(): SerializedDateMentionNode {
		return {
			type: DATE_MENTION_NODE_TYPE,
			version: DATE_MENTION_NODE_VERSION,
			iso: this.__iso,
			label: this.__label,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const span = document.createElement("span");
		span.className = "notes__date-mention";
		span.setAttribute("data-iso", this.__iso);
		span.setAttribute("spellcheck", "false");
		return span;
	}

	override updateDOM(): false {
		return false;
	}

	getIso(): string {
		return this.__iso;
	}

	getLabel(): string {
		return this.__label;
	}

	/** Plain-text view of the chip — used by copy/paste, Markdown export,
	 *  and screen readers. `@<label>` mirrors how the chip reads inline. */
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
		return <DateMentionView iso={this.__iso} label={this.__label} />;
	}
}

function DateMentionView({ iso, label }: { iso: string; label: string }) {
	const display = label.trim().length > 0 ? label : iso;
	return (
		<span className="notes__date-mention-chip" data-iso={iso} title={iso}>
			<Icon name={IconName.KindDate} size={14} className="notes__date-mention-glyph" />
			<span className="notes__date-mention-label">{display}</span>
		</span>
	);
}

export function $createDateMentionNode(iso: string, label: string): DateMentionNode {
	return $applyNodeReplacement(new DateMentionNode(iso, label));
}

export function $isDateMentionNode(node?: LexicalNode | null): node is DateMentionNode {
	return node instanceof DateMentionNode;
}
