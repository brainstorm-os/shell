/**
 * InlineTransclusionNode — the **inline** (text-run) counterpart to the
 * block-level `TransclusionNode` (B11.1). Where `TransclusionNode` breaks to
 * its own line and paints a full card + nested body, this node sits *inside* a
 * paragraph as a compact card preview (icon + live title), so a sentence can
 * reference another object without interrupting the prose flow.
 *
 * It carries no body render and therefore needs no render-time cycle/depth
 * guard (the recursion risk only exists when a transclusion paints another
 * body inline) — it is a live reference chip, richer than a `MentionNode`
 * (icon + title preview, not just `@label`) but lighter than the block card.
 *
 * Persisted shape mirrors `SerializedTransclusionNode` apart from the
 * discriminator (`inline-transclusion`) and the inline DOM flag, so the
 * shell-side note-references walker reads both transclusion forms in one pass
 * and surfaces a single `Transclusion` edge per target. Schema is protocol —
 * the walker (`@brainstorm-os/sdk/note-references`) keys off the same `type`
 * string, pinned by the extract-references parity test.
 */

import { navModeFromEvent } from "@brainstorm-os/sdk";
import {
	type DOMConversionMap,
	type DOMConversionOutput,
	type DOMExportOutput,
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { JSX } from "react";
import { useSyncExternalStore } from "react";
import { EntityIcon } from "../entity-icon";
import { useEditorT } from "../i18n";
import { entityIconsSnapshot, getEntityIcon, subscribeEntityIcons } from "../plugins/entity-index";
import {
	entityTitlesSnapshot,
	getEntityTitle,
	subscribeEntityTitles,
} from "../plugins/entity-index";
import { dispatchOpenEntity } from "../plugins/open-entity-dispatch";

export const INLINE_TRANSCLUSION_NODE_TYPE = "inline-transclusion" as const;
const INLINE_TRANSCLUSION_NODE_VERSION = 1 as const;

/** Sole load-bearing attribute distinguishing an inline-transclusion anchor
 *  from a block transclusion / regular link / block-embed anchor on paste.
 *  Distinct value from `TRANSCLUSION_DOM_FLAG` so a paste target that mounts
 *  both can't conflate them. */
export const INLINE_TRANSCLUSION_DOM_FLAG = "data-lexical-inline-transclusion";
export const INLINE_TRANSCLUSION_DOM_FLAG_VALUE = "true";

const MAX_FIELD_LEN = 1024;

/** ASCII C0 controls + Unicode bidi-override / zero-width / format codes —
 *  the same Trojan-Source / homoglyph defense `TransclusionNode` applies. */
const STRIP_FORMAT_CONTROLS_RE = new RegExp(
	"[" +
		"\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F" +
		"\\u200B-\\u200F" +
		"\\u202A-\\u202E" +
		"\\u2066-\\u2069" +
		"]",
	"g",
);

function clampField(value: unknown): string {
	if (typeof value !== "string") return "";
	const stripped = value.replace(STRIP_FORMAT_CONTROLS_RE, "");
	return stripped.length > MAX_FIELD_LEN ? stripped.slice(0, MAX_FIELD_LEN) : stripped;
}

function entityIdToUriSegment(entityId: string): string {
	return encodeURIComponent(entityId);
}

/** Inline-styled chip for the clipboard export. `inline-flex` (not block) so a
 *  paste into an external paragraph stays in the text run — the inline analogue
 *  of `TRANSCLUSION_CARD_STYLE`. */
const INLINE_TRANSCLUSION_STYLE =
	"display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border:1px solid #e5e7eb;border-radius:6px;background:#fafafa;color:inherit;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:0.95em;";

export type SerializedInlineTransclusionNode = SerializedLexicalNode & {
	type: typeof INLINE_TRANSCLUSION_NODE_TYPE;
	version: typeof INLINE_TRANSCLUSION_NODE_VERSION;
	entityId: string;
	entityType: string;
	label: string;
};

export class InlineTransclusionNode extends DecoratorNode<JSX.Element> {
	__entityId: string;
	__entityType: string;
	__label: string;

	static override getType(): string {
		return INLINE_TRANSCLUSION_NODE_TYPE;
	}

	static override clone(node: InlineTransclusionNode): InlineTransclusionNode {
		return new InlineTransclusionNode(node.__entityId, node.__entityType, node.__label, node.__key);
	}

	constructor(entityId: string, entityType: string, label: string, key?: NodeKey) {
		super(key);
		this.__entityId = entityId;
		this.__entityType = entityType;
		this.__label = label;
	}

	static override importJSON(s: SerializedInlineTransclusionNode): InlineTransclusionNode {
		return new InlineTransclusionNode(
			clampField(s.entityId),
			clampField(s.entityType),
			clampField(s.label),
		);
	}

	override exportJSON(): SerializedInlineTransclusionNode {
		return {
			type: INLINE_TRANSCLUSION_NODE_TYPE,
			version: INLINE_TRANSCLUSION_NODE_VERSION,
			entityId: this.__entityId,
			entityType: this.__entityType,
			label: this.__label,
		};
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const span = document.createElement("span");
		span.className = "notes__inline-transclusion-host";
		span.setAttribute("spellcheck", "false");
		return span;
	}

	override updateDOM(): false {
		return false;
	}

	override exportDOM(): DOMExportOutput {
		const anchor = document.createElement("a");
		const entityId = clampField(this.__entityId);
		const entityType = clampField(this.__entityType);
		const label = clampField(this.__label);
		anchor.setAttribute("href", `brainstorm://entity/${entityIdToUriSegment(entityId)}`);
		anchor.setAttribute(INLINE_TRANSCLUSION_DOM_FLAG, INLINE_TRANSCLUSION_DOM_FLAG_VALUE);
		anchor.setAttribute("data-entity-id", entityId);
		anchor.setAttribute("data-entity-type", entityType);
		anchor.setAttribute("data-label", label);
		anchor.setAttribute("style", INLINE_TRANSCLUSION_STYLE);
		const icon = document.createElement("span");
		icon.setAttribute("aria-hidden", "true");
		icon.textContent = "↪";
		const text = document.createElement("span");
		text.textContent = label;
		anchor.appendChild(icon);
		anchor.appendChild(text);
		return { element: anchor };
	}

	static override importDOM(): DOMConversionMap | null {
		return {
			a: (node: HTMLElement) => {
				if (node.getAttribute(INLINE_TRANSCLUSION_DOM_FLAG) !== INLINE_TRANSCLUSION_DOM_FLAG_VALUE)
					return null;
				return {
					conversion: (element: HTMLElement): DOMConversionOutput => {
						const entityId = clampField(element.getAttribute("data-entity-id"));
						const entityType = clampField(element.getAttribute("data-entity-type"));
						const label = clampField(element.getAttribute("data-label"));
						if (entityId.length === 0) return { node: null };
						return { node: new InlineTransclusionNode(entityId, entityType, label) };
					},
					priority: 1,
				};
			},
		};
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

	/** Plain-text view (copy / Markdown / screen reader / search). Wraps the
	 *  label in "↪ " so a transclusion is distinguishable from a plain mention
	 *  in text-only contexts — mirrors `TransclusionNode.getTextContent`. */
	override getTextContent(): string {
		return `↪ ${this.__label}`;
	}

	override isInline(): true {
		return true;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return (
			<InlineTransclusionView
				entityId={this.__entityId}
				entityType={this.__entityType}
				label={this.__label}
			/>
		);
	}
}

export function InlineTransclusionView({
	entityId,
	entityType,
	label,
}: {
	entityId: string;
	entityType: string;
	label: string;
}) {
	useSyncExternalStore(subscribeEntityIcons, entityIconsSnapshot);
	useSyncExternalStore(subscribeEntityTitles, entityTitlesSnapshot);
	const liveTitle = getEntityTitle(entityId);
	const t = useEditorT();
	const display = liveTitle?.trim() || label.trim() || t("editor.transclusion.untitled");
	const icon = getEntityIcon(entityId);
	return (
		<a
			className="notes__inline-transclusion"
			href={`brainstorm://entity/${entityIdToUriSegment(entityId)}`}
			data-entity-id={entityId}
			data-entity-type={entityType}
			onClick={(event) => {
				if (event.defaultPrevented) return;
				if (event.button !== 0) return;
				event.preventDefault();
				dispatchOpenEntity({ entityId, entityType, mode: navModeFromEvent(event) });
			}}
		>
			<span className="notes__inline-transclusion-arrow" aria-hidden="true">
				↪
			</span>
			<EntityIcon icon={icon} size={14} className="notes__inline-transclusion-glyph" />
			<span className="notes__inline-transclusion-label">{display}</span>
		</a>
	);
}

export function $createInlineTransclusionNode(
	entityId: string,
	entityType: string,
	label: string,
): InlineTransclusionNode {
	return new InlineTransclusionNode(entityId, entityType, label);
}

export function $isInlineTransclusionNode(
	node: LexicalNode | null | undefined,
): node is InlineTransclusionNode {
	return node instanceof InlineTransclusionNode;
}
