/**
 * TransclusionNode — `!@`-inserted block-level live reference to another
 * vault entity. Where `BlockEmbedNode` paints a generic preview card,
 * `TransclusionNode` is the "render the target's content inline" shape.
 * v1 ships the icon + title chrome with a "Transcluded {type}" subtitle;
 * the live read-only Lexical sub-editor renderer that paints the target
 * body inline (depth-budgeted, cycle-guarded at render time as a defense
 * against a hand-edited body that smuggles a cycle past the picker) is a
 * B6.4b follow-up. The persisted shape + walker edge are the load-
 * bearing part — they need to be right today so the renderer upgrade
 * doesn't move bytes on disk.
 *
 * The cycle + depth guards live in the picker (resolveTransclusionTarget
 * in transclusion-ops) — by the time a TransclusionNode exists in the
 * tree, the insertion has already been vetted.
 *
 * Persisted shape (`SerializedTransclusionNode`) parallels
 * `SerializedBlockEmbedNode` so the shell-side walker reads both in one
 * pass; the only schema difference is the discriminator string. The
 * `brainstorm://entity/<id>` URI lives in the HTML export so clipboard
 * out-of-Brainstorm paste still resolves back to a live reference.
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
import { type EditorT, createEditorT, useEditorT } from "../i18n";
import {
	entityIconsSnapshot,
	entityTitlesSnapshot,
	getEntityDisplayIcon,
	getEntityTitle,
	subscribeEntityIcons,
	subscribeEntityTitles,
} from "../plugins/entity-index";
import { dispatchOpenEntity } from "../plugins/open-entity-dispatch";
import { TransclusionRenderDecision, decideTransclusionRender } from "../plugins/transclusion-ops";
import { useTransclusionRender } from "../plugins/transclusion-render-context";

/** Non-React `t` for the imperative `exportDOM` clipboard path (English
 *  defaults — the live decorator uses the reactive `useEditorT`). */
const DEFAULT_T = createEditorT();

export const TRANSCLUSION_NODE_TYPE = "transclusion" as const;
const TRANSCLUSION_NODE_VERSION = 1 as const;

/** Sole load-bearing attribute that distinguishes a TransclusionNode-shaped
 *  anchor from a regular link or a BlockEmbedNode anchor on paste. Both
 *  `exportDOM` and `importDOM` reference this constant so a future rename
 *  stays consistent. Distinct value from `BLOCK_EMBED_DOM_FLAG` so a
 *  paste-target that mounts both can't conflate the two. */
export const TRANSCLUSION_DOM_FLAG = "data-lexical-transclusion";

/** Exact value the export side stamps onto {@link TRANSCLUSION_DOM_FLAG}.
 *  `importDOM` matches on this value (not just on attribute presence) —
 *  any other value rejects, mirroring the BlockEmbedNode hardening. */
export const TRANSCLUSION_DOM_FLAG_VALUE = "true";

/** Hard cap on every persisted string field. Mirrors BlockEmbedNode's
 *  `MAX_FIELD_LEN`; protects the vault graph from a hostile import
 *  smuggling multi-megabyte ids/labels through the body walker. */
const MAX_FIELD_LEN = 1024;

/** ASCII C0 controls + Unicode bidi-override / zero-width / format codes.
 *  Same set BlockEmbedNode strips — Trojan-Source / homoglyph defense.
 *  Stripping happens uniformly in `clampField` so every user-facing field
 *  (label, ids, types) lands clean regardless of provenance. */
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

/** URL-encode the entityId before splicing into `brainstorm://entity/<id>`.
 *  Same rationale as BlockEmbedNode: defangs `#` / `?` / `/` in the id
 *  truncating the parser at `parseBrainstormEntityUri` and routing
 *  navigation to a different target than the URL bar shows. */
function entityIdToUriSegment(entityId: string): string {
	return encodeURIComponent(entityId);
}

/** Inline-styled card chrome for the clipboard export. Mirrors the live
 *  `<TransclusionView>` layout; values inline because external apps strip
 *  `<style>` blocks and CSS classes on paste. Block-level (`display:flex`,
 *  not `inline-flex`) so paste into a Google Docs / Word paragraph lands
 *  on its own line — same as BlockEmbedNode. */
const TRANSCLUSION_CARD_STYLE =
	"display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;color:inherit;text-decoration:none;max-width:480px;min-width:200px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
const TRANSCLUSION_ICON_STYLE =
	"display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:6px;background:#e5e7eb;color:#374151;font-weight:600;font-size:16px;flex:0 0 auto;";
const TRANSCLUSION_BODY_STYLE =
	"display:flex;flex-direction:column;gap:2px;min-width:0;line-height:1.2;";
const TRANSCLUSION_TITLE_STYLE =
	"font-weight:600;color:inherit;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
const TRANSCLUSION_SUBTITLE_STYLE =
	"color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

export type SerializedTransclusionNode = SerializedLexicalNode & {
	type: typeof TRANSCLUSION_NODE_TYPE;
	version: typeof TRANSCLUSION_NODE_VERSION;
	entityId: string;
	entityType: string;
	label: string;
};

export class TransclusionNode extends DecoratorNode<JSX.Element> {
	__entityId: string;
	__entityType: string;
	__label: string;

	static override getType(): string {
		return TRANSCLUSION_NODE_TYPE;
	}

	static override clone(node: TransclusionNode): TransclusionNode {
		return new TransclusionNode(node.__entityId, node.__entityType, node.__label, node.__key);
	}

	constructor(entityId: string, entityType: string, label: string, key?: NodeKey) {
		super(key);
		this.__entityId = entityId;
		this.__entityType = entityType;
		this.__label = label;
	}

	static override importJSON(s: SerializedTransclusionNode): TransclusionNode {
		return new TransclusionNode(
			clampField(s.entityId),
			clampField(s.entityType),
			clampField(s.label),
		);
	}

	override exportJSON(): SerializedTransclusionNode {
		return {
			type: TRANSCLUSION_NODE_TYPE,
			version: TRANSCLUSION_NODE_VERSION,
			entityId: this.__entityId,
			entityType: this.__entityType,
			label: this.__label,
		};
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		el.className = "notes__transclusion-host";
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	/** HTML clipboard representation. Mirrors BlockEmbedNode's export
	 *  shape; the load-bearing `data-lexical-transclusion="true"` flag is
	 *  what distinguishes a TransclusionNode anchor from a BlockEmbedNode
	 *  anchor on paste. Every persisted field clamps through `clampField`. */
	override exportDOM(): DOMExportOutput {
		const anchor = document.createElement("a");
		const entityId = clampField(this.__entityId);
		const entityType = clampField(this.__entityType);
		const label = clampField(this.__label);
		const typeLabel = entityTypeLabel(entityType, DEFAULT_T);
		anchor.setAttribute("href", `brainstorm://entity/${entityIdToUriSegment(entityId)}`);
		anchor.setAttribute(TRANSCLUSION_DOM_FLAG, TRANSCLUSION_DOM_FLAG_VALUE);
		anchor.setAttribute("data-entity-id", entityId);
		anchor.setAttribute("data-entity-type", entityType);
		anchor.setAttribute("data-label", label);
		anchor.setAttribute("style", TRANSCLUSION_CARD_STYLE);
		const icon = document.createElement("span");
		icon.setAttribute("style", TRANSCLUSION_ICON_STYLE);
		icon.setAttribute("aria-hidden", "true");
		// Glyph differs from BlockEmbedNode (a "•" or letter); the
		// transclusion arrow ("↪") visually signals "live content" vs the
		// generic preview card.
		icon.textContent = "↪";
		const body = document.createElement("span");
		body.setAttribute("style", TRANSCLUSION_BODY_STYLE);
		const title = document.createElement("span");
		title.setAttribute("style", TRANSCLUSION_TITLE_STYLE);
		title.textContent = label;
		const subtitle = document.createElement("span");
		subtitle.setAttribute("style", TRANSCLUSION_SUBTITLE_STYLE);
		subtitle.textContent = typeLabel;
		body.appendChild(title);
		body.appendChild(subtitle);
		anchor.appendChild(icon);
		anchor.appendChild(body);
		return { element: anchor };
	}

	/** HTML paste path. Only an `<a>` whose `TRANSCLUSION_DOM_FLAG` value
	 *  matches the exact stamp converts back to a `TransclusionNode` —
	 *  plain `<a>` keeps the regular link-paste behaviour. Empty
	 *  `data-entity-id` rejects the conversion outright (a reference to
	 *  nothing is not a reference). */
	static override importDOM(): DOMConversionMap | null {
		return {
			a: (node: HTMLElement) => {
				if (node.getAttribute(TRANSCLUSION_DOM_FLAG) !== TRANSCLUSION_DOM_FLAG_VALUE) return null;
				return {
					conversion: (element: HTMLElement): DOMConversionOutput => {
						const entityId = clampField(element.getAttribute("data-entity-id"));
						const entityType = clampField(element.getAttribute("data-entity-type"));
						const label = clampField(element.getAttribute("data-label"));
						if (entityId.length === 0) return { node: null };
						return {
							node: new TransclusionNode(entityId, entityType, label),
						};
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

	/** Plain-text view. Used by copy-as-text / Markdown export / screen
	 *  readers / search indexing — they want the label, not the URI.
	 *  Wrapping in "↪ " marks the line as a transclusion in plain-text
	 *  contexts where the icon glyph isn't otherwise rendered. */
	override getTextContent(): string {
		return `↪ ${this.__label}`;
	}

	override isInline(): false {
		return false;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return (
			<TransclusionView
				entityId={this.__entityId}
				entityType={this.__entityType}
				label={this.__label}
			/>
		);
	}
}

export function TransclusionView({
	entityId,
	entityType,
	label,
}: {
	entityId: string;
	entityType: string;
	label: string;
}) {
	const t = useEditorT();
	useSyncExternalStore(subscribeEntityIcons, entityIconsSnapshot);
	useSyncExternalStore(subscribeEntityTitles, entityTitlesSnapshot);
	const liveTitle = getEntityTitle(entityId);
	const display = liveTitle?.trim() || label.trim() || t("editor.transclusion.untitled");
	const icon = getEntityDisplayIcon(entityId, entityType);
	const subtitle = t("editor.transclusion.subtitle", { type: entityTypeLabel(entityType, t) });

	// B6.4b: decide against the LIVE render chain (host-first, this target
	// excluded). The picker already vetted insertion against the forward graph,
	// but a hand-edited / imported / concurrently-synced body can smuggle a
	// cycle past it — so the renderer re-checks before mounting the nested body.
	const { ancestorChain, renderBody } = useTransclusionRender();
	const decision = decideTransclusionRender(ancestorChain, entityId);
	const showBody = decision === TransclusionRenderDecision.Render && renderBody !== null;
	const elidedNote =
		decision === TransclusionRenderDecision.CycleElided
			? t("editor.transclusion.cycleElided")
			: decision === TransclusionRenderDecision.DepthElided
				? t("editor.transclusion.depthElided")
				: null;

	return (
		<div className="notes__transclusion" data-decision={decision}>
			<a
				className="notes__transclusion-card"
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
				<span className="notes__transclusion-card-icon" aria-hidden="true">
					<EntityIcon icon={icon} size={36} className="notes__transclusion-card-icon-glyph" />
				</span>
				<span className="notes__transclusion-card-body">
					<span className="notes__transclusion-card-title">{display}</span>
					<span className="notes__transclusion-card-type">{subtitle}</span>
				</span>
			</a>
			{showBody ? (
				<div className="notes__transclusion-body" contentEditable={false}>
					{renderBody({ entityId, entityType, chain: ancestorChain })}
				</div>
			) : elidedNote ? (
				<div className="notes__transclusion-elided">{elidedNote}</div>
			) : null}
		</div>
	);
}

/** Human-readable type label for the card's bottom-line. Reverse-DNS
 *  ids collapse to their last `/`-segment minus the `/v\d+` suffix —
 *  `io.brainstorm.notes/Note/v1` → `Note`. Same shape BlockEmbedNode uses. */
function entityTypeLabel(entityType: string, t: EditorT): string {
	if (!entityType) return t("editor.transclusion.typeUnknown");
	const lastSlash = entityType.lastIndexOf("/");
	const tail = lastSlash >= 0 ? entityType.slice(lastSlash + 1) : entityType;
	const trimmed = tail.replace(/^v\d+$/, "");
	if (trimmed.length > 0) return trimmed;
	const penultimate = entityType.slice(0, lastSlash);
	const prevSlash = penultimate.lastIndexOf("/");
	return prevSlash >= 0 ? penultimate.slice(prevSlash + 1) : penultimate;
}

export function $createTransclusionNode(
	entityId: string,
	entityType: string,
	label: string,
): TransclusionNode {
	return new TransclusionNode(entityId, entityType, label);
}

export function $isTransclusionNode(
	node: LexicalNode | null | undefined,
): node is TransclusionNode {
	return node instanceof TransclusionNode;
}
