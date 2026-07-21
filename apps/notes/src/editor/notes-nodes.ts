/**
 * The Notes-specific Lexical node set, single-sourced so the live editor
 * surface, the headless migration planter (`store/migrate-body.ts`) and
 * any future serialization tool all register the same classes. Drift
 * here would silently corrupt rich-text: a planter missing
 * `BookmarkNode` would throw `type "bookmark" + not found` during
 * `parseEditorState` on a legacy body, fall back to the rebuild path, and
 * quietly strip the bookmark. Pin the set in one place.
 */

import { CalloutNode, ColumnNode, ColumnsNode, TitleNode, ToggleNode } from "@brainstorm-os/editor";
import { CodeNode } from "@lexical/code";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import type { Klass, LexicalNode } from "lexical";
import { AudioBlockNode } from "./nodes/audio-block-node";
import { BlockEmbedNode } from "./nodes/block-embed-node";
import { BookmarkNode } from "./nodes/bookmark-node";
import { CheckboxFieldNode } from "./nodes/checkbox-field-node";
import { DateFieldNode } from "./nodes/date-field-node";
import { DateMentionNode } from "./nodes/date-mention-node";
import { EquationNode } from "./nodes/equation-node";
import { FileBlockNode } from "./nodes/file-block-node";
import { ImageBlockNode } from "./nodes/image-block-node";
import { InlineTransclusionNode } from "./nodes/inline-transclusion-node";
import { MentionNode } from "./nodes/mention-node";
import { NumberFieldNode } from "./nodes/number-field-node";
import { PageRefNode } from "./nodes/page-ref-node";
import { PropertyBlockNode } from "./nodes/property-block-node";
import { PropertyListBlockNode } from "./nodes/property-list-block-node";
import { SelectFieldNode } from "./nodes/select-field-node";
import { TableOfContentsNode } from "./nodes/toc-node";
import { TransclusionNode } from "./nodes/transclusion-node";
import { VideoBlockNode } from "./nodes/video-block-node";
import { WebEmbedNode } from "./nodes/web-embed-node";

export const NOTES_ADDITIONAL_NODES: ReadonlyArray<Klass<LexicalNode>> = [
	HeadingNode,
	QuoteNode,
	ListNode,
	ListItemNode,
	CodeNode,
	LinkNode,
	AutoLinkNode,
	HorizontalRuleNode,
	ImageBlockNode,
	VideoBlockNode,
	PropertyBlockNode,
	PropertyListBlockNode,
	MentionNode,
	DateMentionNode,
	CheckboxFieldNode,
	DateFieldNode,
	NumberFieldNode,
	SelectFieldNode,
	TitleNode,
	CalloutNode,
	TableNode,
	TableRowNode,
	TableCellNode,
	ToggleNode,
	BookmarkNode,
	WebEmbedNode,
	AudioBlockNode,
	FileBlockNode,
	EquationNode,
	PageRefNode,
	BlockEmbedNode,
	TransclusionNode,
	InlineTransclusionNode,
	ColumnsNode,
	ColumnNode,
	TableOfContentsNode,
];
