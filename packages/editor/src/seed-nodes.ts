/**
 * Headless **stand-in** node classes for planting seed / starter content.
 *
 * A stand-in is the bare minimum a Lexical node needs (`getType()` +
 * `clone()` + `importJSON`/`exportJSON` that preserve the persisted shape)
 * so `parseEditorState` recognises every `type:` string a generated body
 * carries and `plantSerializedStateIntoDoc` produces XmlElements with the
 * right `type` attribute. When the runtime editor later reads the resulting
 * `.ydoc` it looks up its REAL `TitleNode` / `MentionNode` / etc. by type and
 * instantiates those — these stand-ins never touch the live editor.
 *
 * Why here and not in an app: two seeders need the exact same stand-ins — the
 * dev-vault seed-cli (`tools/mcp-server/src/seed`) and the shell's Welcome-1
 * starter-content seeder — and neither can import the other's (nor an app's)
 * node classes. Extracting them to `@brainstorm-os/editor` (which already owns
 * `plantSerializedStateIntoDoc` + `BASELINE_NODES`) is the single source, per
 * the DRY-at-copy-two rule. The serialized shape MUST stay in lockstep with
 * `apps/notes/src/editor/notes-nodes.ts` `NOTES_ADDITIONAL_NODES` — any node a
 * seeder emits must be stood-in here or `parseEditorState` throws.
 */

import {
	DecoratorNode,
	type Klass,
	type LexicalNode,
	ParagraphNode,
	type SerializedLexicalNode,
	type SerializedParagraphNode,
} from "lexical";

const TITLE_NODE_TYPE = "title";
const MENTION_NODE_TYPE = "mention";
const HORIZONTAL_RULE_NODE_TYPE = "horizontalrule";
const IMAGE_BLOCK_NODE_TYPE = "image-block";

export type SerializedSeedMentionNode = SerializedLexicalNode & {
	entityId: string;
	entityType: string;
	label: string;
};

export class SeedTitleNode extends ParagraphNode {
	static override getType(): string {
		return TITLE_NODE_TYPE;
	}
	static override clone(node: SeedTitleNode): SeedTitleNode {
		return new SeedTitleNode(node.__key);
	}
	static override importJSON(json: SerializedParagraphNode): SeedTitleNode {
		const n = new SeedTitleNode();
		n.setFormat(json.format);
		n.setIndent(json.indent);
		n.setDirection(json.direction);
		return n;
	}
	override exportJSON(): SerializedParagraphNode {
		return { ...super.exportJSON(), type: TITLE_NODE_TYPE, version: 1 };
	}
}

/** Stand-in for the inline `mention` chip. The real `MentionNode`
 *  (`apps/notes/src/editor/nodes/mention-node.tsx`) is an INLINE
 *  `DecoratorNode`, so the stand-in must be one too: `@lexical/yjs` encodes a
 *  decorator as an embedded element and a `TextNode` as a text run — a
 *  `TextNode` stand-in plants the mention as inline text, then the runtime
 *  editor (which has the real decorator registered for `type:"mention"`)
 *  throws `syncPropertiesAndTextFromYjs: could not find decorator node` while
 *  hydrating and rolls back the WHOLE editor update, leaving the note body
 *  blank ("icon, empty body"). Mirroring the real node's KIND + inline-ness +
 *  serialized shape keeps the plant's Yjs encoding byte-compatible with what
 *  the runtime editor expects. */
export class SeedMentionNode extends DecoratorNode<null> {
	__entityId: string;
	__entityType: string;
	__label: string;
	constructor(entityId: string, entityType: string, label: string, key?: string) {
		super(key);
		this.__entityId = entityId;
		this.__entityType = entityType;
		this.__label = label;
	}
	static override getType(): string {
		return MENTION_NODE_TYPE;
	}
	static override clone(node: SeedMentionNode): SeedMentionNode {
		return new SeedMentionNode(node.__entityId, node.__entityType, node.__label, node.__key);
	}
	static override importJSON(json: SerializedSeedMentionNode): SeedMentionNode {
		return new SeedMentionNode(json.entityId, json.entityType, json.label);
	}
	override exportJSON(): SerializedSeedMentionNode {
		return {
			type: MENTION_NODE_TYPE,
			version: 1,
			entityId: this.__entityId,
			entityType: this.__entityType,
			label: this.__label,
		};
	}
	override isInline(): true {
		return true;
	}
	override createDOM(): HTMLElement {
		throw new Error("SeedMentionNode: createDOM not implemented (headless)");
	}
	override updateDOM(): false {
		return false;
	}
	override decorate(): null {
		return null;
	}
}

/** Stand-in for the `horizontalrule` block. The real runtime class lives in
 *  `@lexical/react/LexicalHorizontalRuleNode` and pulls React; a bare
 *  `DecoratorNode` subclass is enough for `parseEditorState` + the Yjs plant
 *  to recognise the type (the runtime editor uses the real class once it reads
 *  the resulting `.ydoc`). */
export class SeedHorizontalRuleNode extends DecoratorNode<null> {
	static override getType(): string {
		return HORIZONTAL_RULE_NODE_TYPE;
	}
	static override clone(node: SeedHorizontalRuleNode): SeedHorizontalRuleNode {
		return new SeedHorizontalRuleNode(node.__key);
	}
	static override importJSON(_json: SerializedLexicalNode): SeedHorizontalRuleNode {
		return new SeedHorizontalRuleNode();
	}
	override exportJSON(): SerializedLexicalNode {
		return { type: HORIZONTAL_RULE_NODE_TYPE, version: 1 };
	}
	override createDOM(): HTMLElement {
		throw new Error("SeedHorizontalRuleNode: createDOM not implemented (headless)");
	}
	override updateDOM(): false {
		return false;
	}
	override decorate(): null {
		return null;
	}
}

export type SerializedSeedImageBlockNode = SerializedLexicalNode & {
	src: string;
	alt: string;
	caption: string;
	alignment: string;
	widthPercent: number;
};

/** Stand-in for the `image-block` media node (the resizable/aligned image
 *  the runtime editor renders). DecoratorNode kind must match the real
 *  `ImageBlockNode` for the same Yjs-encoding reason as the mention stand-in
 *  above; the serialized shape mirrors `SerializedImageBlockNode` v2 so the
 *  runtime hydrates alignment + widthPercent exactly as planted. */
export class SeedImageBlockNode extends DecoratorNode<null> {
	__src: string;
	__alt: string;
	__caption: string;
	__alignment: string;
	__widthPercent: number;
	constructor(
		src: string,
		alt: string,
		caption: string,
		alignment: string,
		widthPercent: number,
		key?: string,
	) {
		super(key);
		this.__src = src;
		this.__alt = alt;
		this.__caption = caption;
		this.__alignment = alignment;
		this.__widthPercent = widthPercent;
	}
	static override getType(): string {
		return IMAGE_BLOCK_NODE_TYPE;
	}
	static override clone(node: SeedImageBlockNode): SeedImageBlockNode {
		return new SeedImageBlockNode(
			node.__src,
			node.__alt,
			node.__caption,
			node.__alignment,
			node.__widthPercent,
			node.__key,
		);
	}
	static override importJSON(json: SerializedSeedImageBlockNode): SeedImageBlockNode {
		return new SeedImageBlockNode(
			json.src,
			json.alt ?? "",
			json.caption ?? "",
			json.alignment ?? "center",
			typeof json.widthPercent === "number" ? json.widthPercent : 100,
		);
	}
	override exportJSON(): SerializedSeedImageBlockNode {
		return {
			type: IMAGE_BLOCK_NODE_TYPE,
			version: 2,
			src: this.__src,
			alt: this.__alt,
			caption: this.__caption,
			alignment: this.__alignment,
			widthPercent: this.__widthPercent,
		};
	}
	override isInline(): false {
		return false;
	}
	override createDOM(): HTMLElement {
		throw new Error("SeedImageBlockNode: createDOM not implemented (headless)");
	}
	override updateDOM(): false {
		return false;
	}
	override decorate(): null {
		return null;
	}
}

/** The custom stand-in nodes a seed plant needs on top of `BASELINE_NODES`
 *  (title + mention + horizontalrule). Table nodes are not here — consumers
 *  that emit tables append `@lexical/table`'s real classes at the call site. */
export const SEED_STANDIN_NODES: ReadonlyArray<Klass<LexicalNode>> = [
	SeedTitleNode,
	SeedMentionNode,
	SeedHorizontalRuleNode,
	SeedImageBlockNode,
];
