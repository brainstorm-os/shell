/**
 * InlineImageNode (B11.28) — a small image that sits inside a line of text
 * (an icon, a logo, a glyph-sized screenshot), baseline-aligned with the
 * surrounding run. Inserted from an existing vault asset ("Inline image"
 * slash command); the block `ImageBlockNode` stays the home for anything
 * that needs a caption, alignment or a width.
 *
 * Sized in `em` so it scales with the text it sits in; the height is
 * clamped to a short range — an inline image taller than a few lines is a
 * block image and should be one.
 */

import {
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { JSX } from "react";

export const INLINE_IMAGE_TYPE = "inline-image";

export const DEFAULT_INLINE_IMAGE_HEIGHT_EM = 1.25;
const MIN_INLINE_IMAGE_HEIGHT_EM = 0.75;
const MAX_INLINE_IMAGE_HEIGHT_EM = 4;

export function clampInlineImageHeight(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INLINE_IMAGE_HEIGHT_EM;
	return Math.min(MAX_INLINE_IMAGE_HEIGHT_EM, Math.max(MIN_INLINE_IMAGE_HEIGHT_EM, value));
}

export type SerializedInlineImageNode = SerializedLexicalNode & {
	type: typeof INLINE_IMAGE_TYPE;
	version: 1;
	src: string;
	alt: string;
	heightEm: number;
};

export class InlineImageNode extends DecoratorNode<JSX.Element> {
	__src: string;
	__alt: string;
	__heightEm: number;

	static override getType(): string {
		return INLINE_IMAGE_TYPE;
	}

	static override clone(node: InlineImageNode): InlineImageNode {
		return new InlineImageNode(node.__src, node.__alt, node.__heightEm, node.__key);
	}

	constructor(
		src: string,
		alt = "",
		heightEm: number = DEFAULT_INLINE_IMAGE_HEIGHT_EM,
		key?: NodeKey,
	) {
		super(key);
		this.__src = src;
		this.__alt = alt;
		this.__heightEm = clampInlineImageHeight(heightEm);
	}

	static override importJSON(serialized: SerializedInlineImageNode): InlineImageNode {
		return new InlineImageNode(
			typeof serialized.src === "string" ? serialized.src : "",
			typeof serialized.alt === "string" ? serialized.alt : "",
			clampInlineImageHeight(serialized.heightEm),
		);
	}

	override exportJSON(): SerializedInlineImageNode {
		return {
			type: INLINE_IMAGE_TYPE,
			version: 1,
			src: this.__src,
			alt: this.__alt,
			heightEm: this.__heightEm,
		};
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const el = document.createElement("span");
		el.className = "bs-inline-image-host";
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	override isInline(): true {
		return true;
	}

	override getTextContent(): string {
		return this.__alt;
	}

	getSrc(): string {
		return this.__src;
	}

	getAlt(): string {
		return this.__alt;
	}

	getHeightEm(): number {
		return this.__heightEm;
	}

	override decorate(): JSX.Element {
		return (
			<img
				className="bs-inline-image"
				src={this.__src}
				alt={this.__alt}
				draggable={false}
				style={{ height: `${this.__heightEm}em` }}
			/>
		);
	}
}

export function $createInlineImageNode(src: string, alt = "", heightEm?: number): InlineImageNode {
	return new InlineImageNode(src, alt, heightEm);
}

export function $isInlineImageNode(node: LexicalNode | null | undefined): node is InlineImageNode {
	return node instanceof InlineImageNode;
}
