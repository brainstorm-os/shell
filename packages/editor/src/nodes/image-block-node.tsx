/**
 * ImageBlockNode — Lexical `DecoratorNode` for a top-level image with
 * optional caption, alignment, and width %.
 *
 * Source values:
 *   - `brainstorm://app-file/...` URL produced by the host uploader.
 *   - Or a base64 data URL for files under the inline cap (≤ 2 MiB).
 *
 * The `MediaInspectorPlugin` edits `alt` / `caption` / `alignment` /
 * `widthPercent` via the matching `set*` methods; it opens when the
 * figure is clicked.
 *
 * Plays nicely with the existing block-level machinery:
 *   - Top-level → `BlockSelectionPlugin` Cmd-click / Shift-click work.
 *   - Has `exportJSON` / `importJSON` → clipboard + duplicate + move
 *     round-trip without extra wiring.
 *   - The gutter walks top-level blocks by Y-coord; it picks the image.
 *
 * Turn-into commands skip this node (Lexical's `$setBlocksType` ignores
 * decorators) — to convert an image into another block, the user
 * deletes it first.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalEditable } from "@lexical/react/useLexicalEditable";
import {
	$getNodeByKey,
	type DOMConversionMap,
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import { type JSX, type PointerEvent as ReactPointerEvent, type RefObject, useRef } from "react";
import { useEditorT } from "../i18n";
import { MediaKind, mediaInspectorStore } from "../media-inspector-store";
import {
	DEFAULT_MEDIA_ALIGNMENT,
	DEFAULT_MEDIA_WIDTH_PERCENT,
	MediaAlignment,
	clampMediaWidth,
	isMediaAlignment,
} from "../media-types";

export const IMAGE_BLOCK_TYPE = "image-block";

export type SerializedImageBlockNode = SerializedLexicalNode & {
	type: typeof IMAGE_BLOCK_TYPE;
	version: 2;
	src: string;
	alt: string;
	caption: string;
	alignment: MediaAlignment;
	widthPercent: number;
};

export class ImageBlockNode extends DecoratorNode<JSX.Element> {
	__src: string;
	__alt: string;
	__caption: string;
	__alignment: MediaAlignment;
	__widthPercent: number;

	static override getType(): string {
		return IMAGE_BLOCK_TYPE;
	}

	static override clone(node: ImageBlockNode): ImageBlockNode {
		return new ImageBlockNode(
			node.__src,
			node.__alt,
			node.__caption,
			node.__alignment,
			node.__widthPercent,
			node.__key,
		);
	}

	constructor(
		src: string,
		alt = "",
		caption = "",
		alignment: MediaAlignment = DEFAULT_MEDIA_ALIGNMENT,
		widthPercent: number = DEFAULT_MEDIA_WIDTH_PERCENT,
		key?: NodeKey,
	) {
		super(key);
		this.__src = src;
		this.__alt = alt;
		this.__caption = caption;
		this.__alignment = alignment;
		this.__widthPercent = clampMediaWidth(widthPercent);
	}

	static override importJSON(serialized: SerializedImageBlockNode): ImageBlockNode {
		// v1 lacked `alignment` + `widthPercent` — default them. Unknown
		// alignment values (forward-compat corrupt data) clamp to Center.
		const alignment = isMediaAlignment(serialized.alignment)
			? serialized.alignment
			: DEFAULT_MEDIA_ALIGNMENT;
		const widthPercent =
			typeof serialized.widthPercent === "number"
				? clampMediaWidth(serialized.widthPercent)
				: DEFAULT_MEDIA_WIDTH_PERCENT;
		return new ImageBlockNode(
			serialized.src,
			serialized.alt,
			serialized.caption,
			alignment,
			widthPercent,
		);
	}

	override exportJSON(): SerializedImageBlockNode {
		return {
			type: IMAGE_BLOCK_TYPE,
			version: 2,
			src: this.__src,
			alt: this.__alt,
			caption: this.__caption,
			alignment: this.__alignment,
			widthPercent: this.__widthPercent,
		};
	}

	static override importDOM(): DOMConversionMap | null {
		return null;
	}

	override createDOM(config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		const themeClass = config.theme.imageBlock;
		el.className = typeof themeClass === "string" ? themeClass : "notes__image-block";
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	getSrc(): string {
		return this.__src;
	}

	getAlt(): string {
		return this.__alt;
	}

	getCaption(): string {
		return this.__caption;
	}

	getAlignment(): MediaAlignment {
		return this.__alignment;
	}

	getWidthPercent(): number {
		return this.__widthPercent;
	}

	setSrc(src: string): void {
		const writable = this.getWritable();
		writable.__src = src;
	}

	setAlt(alt: string): void {
		const writable = this.getWritable();
		writable.__alt = alt;
	}

	setCaption(caption: string): void {
		const writable = this.getWritable();
		writable.__caption = caption;
	}

	setAlignment(alignment: MediaAlignment): void {
		const writable = this.getWritable();
		writable.__alignment = alignment;
	}

	setWidthPercent(widthPercent: number): void {
		const writable = this.getWritable();
		writable.__widthPercent = clampMediaWidth(widthPercent);
	}

	override decorate(): JSX.Element {
		return (
			<ImageBlockView
				nodeKey={this.getKey()}
				src={this.__src}
				alt={this.__alt}
				caption={this.__caption}
				alignment={this.__alignment}
				widthPercent={this.__widthPercent}
			/>
		);
	}

	override isInline(): false {
		return false;
	}
}

function ImageBlockView({
	nodeKey,
	src,
	alt,
	caption,
	alignment,
	widthPercent,
}: {
	nodeKey: NodeKey;
	src: string;
	alt: string;
	caption: string;
	alignment: MediaAlignment;
	widthPercent: number;
}) {
	const t = useEditorT();
	const figureRef = useRef<HTMLElement>(null);
	function openInspector(currentTarget: HTMLElement) {
		const figure = currentTarget.closest("figure") ?? currentTarget;
		const anchor = figure.getBoundingClientRect();
		mediaInspectorStore.open({ nodeKey, kind: MediaKind.Image, anchor });
	}
	return (
		<figure
			ref={figureRef}
			className="notes__image"
			data-alignment={alignment}
			style={{ "--notes-media-width": `${widthPercent}%` } as Record<string, string>}
		>
			<button
				type="button"
				className="notes__media-edit-button"
				aria-label={t("editor.media.inspector.region")}
				onClick={(event) => openInspector(event.currentTarget)}
			>
				<img src={src} alt={alt} draggable={false} />
			</button>
			{alignment !== MediaAlignment.Wide && (
				<ImageResizeHandle nodeKey={nodeKey} figureRef={figureRef} alignment={alignment} />
			)}
			{caption && <figcaption className="notes__image-caption">{caption}</figcaption>}
		</figure>
	);
}

export function $createImageBlockNode(
	src: string,
	alt = "",
	caption = "",
	alignment: MediaAlignment = DEFAULT_MEDIA_ALIGNMENT,
	widthPercent: number = DEFAULT_MEDIA_WIDTH_PERCENT,
): ImageBlockNode {
	return new ImageBlockNode(src, alt, caption, alignment, widthPercent);
}

export function $isImageBlockNode(node: LexicalNode | null | undefined): node is ImageBlockNode {
	return node instanceof ImageBlockNode;
}

/** The width (as % of the content column) a drag of `dx` px on the image's
 *  trailing edge lands on. A centred image grows on both sides, so the edge
 *  under the pointer moves by half the width change — `dx` counts double. */
export function resizedWidthPercent(
	startWidthPx: number,
	dx: number,
	containerPx: number,
	alignment: MediaAlignment,
	rtl: boolean,
): number {
	if (containerPx <= 0) return clampMediaWidth(100);
	const signed = rtl ? -dx : dx;
	const grow = alignment === MediaAlignment.Center ? signed * 2 : signed;
	return clampMediaWidth(((startWidthPx + grow) / containerPx) * 100);
}

/** Drag handle on a block image's trailing edge (B11.28). Pointer-only by
 *  design — the inspector's width slider is the keyboard path to the same
 *  `widthPercent`, so the handle stays out of the tab order. Live feedback
 *  rides the `--notes-media-width` var; one undo step commits on release. */
function ImageResizeHandle({
	nodeKey,
	figureRef,
	alignment,
}: {
	nodeKey: NodeKey;
	figureRef: RefObject<HTMLElement | null>;
	alignment: MediaAlignment;
}) {
	const [editor] = useLexicalComposerContext();
	const editable = useLexicalEditable();
	const t = useEditorT();
	if (!editable) return null;

	const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>): void => {
		const figure = figureRef.current;
		const container = figure?.parentElement;
		if (!figure || !container) return;
		event.preventDefault();
		event.stopPropagation();
		const handle = event.currentTarget;
		const startX = event.clientX;
		const startWidth = figure.getBoundingClientRect().width;
		const containerWidth = container.getBoundingClientRect().width;
		const rtl = getComputedStyle(figure).direction === "rtl";
		let latest: number | null = null;
		handle.setPointerCapture?.(event.pointerId);
		const onMove = (move: PointerEvent): void => {
			latest = resizedWidthPercent(startWidth, move.clientX - startX, containerWidth, alignment, rtl);
			figure.style.setProperty("--notes-media-width", `${latest}%`);
		};
		const onUp = (): void => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			if (latest === null) return;
			const next = latest;
			editor.update(() => {
				const node = $getNodeByKey(nodeKey);
				if ($isImageBlockNode(node)) node.setWidthPercent(next);
			});
		};
		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
	};

	return (
		<span
			className="notes__image-resize"
			aria-hidden="true"
			title={t("editor.media.resize")}
			data-testid="image-resize-handle"
			onPointerDown={onPointerDown}
		/>
	);
}
