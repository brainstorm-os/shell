/**
 * Editor icon shim. Every glyph here is a thin wrapper over `@phosphor-icons/react`
 * so the editor surfaces (slash menu, block action menu, gutter) share one
 * cohesive 16px family with the rest of the shell + SDK chrome.
 *
 * Function names are preserved so existing call sites stay unchanged.
 */

import {
	ArrowDown,
	ArrowLeft,
	ArrowLineDown,
	ArrowLineLeft,
	ArrowLineRight,
	ArrowRight,
	ArrowUp,
	Bookmark,
	BracketsAngle,
	Calendar,
	CaretRight,
	ChatCircle,
	Check,
	Code,
	Columns,
	Copy,
	DotsSixVertical,
	DotsThree,
	File,
	FilePlus,
	FilmStrip,
	Function as FunctionGlyph,
	Globe,
	Hash,
	Image,
	Info,
	Link,
	LinkBreak,
	ListBullets,
	ListChecks,
	ListDashes,
	ListNumbers,
	MagnifyingGlass,
	Minus,
	MusicNote,
	Paragraph,
	Plus,
	Quotes,
	Rows,
	Scissors,
	Smiley,
	SortAscending,
	SortDescending,
	Table,
	TextAa,
	TextAlignCenter,
	TextAlignJustify,
	TextAlignLeft,
	TextAlignRight,
	TextB,
	TextHOne,
	TextHThree,
	TextHTwo,
	TextIndent,
	TextItalic,
	TextOutdent,
	TextStrikethrough,
	TextT,
	TextUnderline,
	ToggleRight,
	Trash,
	X,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

const SIZE = 16;

export function ParagraphIcon(): ReactNode {
	return <Paragraph size={SIZE} aria-hidden focusable={false} />;
}

export function Heading1Icon(): ReactNode {
	return <TextHOne size={SIZE} aria-hidden focusable={false} />;
}

export function Heading2Icon(): ReactNode {
	return <TextHTwo size={SIZE} aria-hidden focusable={false} />;
}

export function Heading3Icon(): ReactNode {
	return <TextHThree size={SIZE} aria-hidden focusable={false} />;
}

export function BulletListIcon(): ReactNode {
	return <ListBullets size={SIZE} aria-hidden focusable={false} />;
}

export function NumberedListIcon(): ReactNode {
	return <ListNumbers size={SIZE} aria-hidden focusable={false} />;
}

export function TodoListIcon(): ReactNode {
	return <ListChecks size={SIZE} aria-hidden focusable={false} />;
}

export function QuoteIcon(): ReactNode {
	return <Quotes size={SIZE} aria-hidden focusable={false} />;
}

export function CalloutIcon(): ReactNode {
	return <Info size={SIZE} aria-hidden focusable={false} />;
}

export function CodeIcon(): ReactNode {
	return <Code size={SIZE} aria-hidden focusable={false} />;
}

export function ImageIcon(): ReactNode {
	return <Image size={SIZE} aria-hidden focusable={false} />;
}

export function VideoIcon(): ReactNode {
	return <FilmStrip size={SIZE} aria-hidden focusable={false} />;
}

export function ArrowUpIcon(): ReactNode {
	return <ArrowUp size={SIZE} aria-hidden focusable={false} />;
}

export function ArrowDownIcon(): ReactNode {
	return <ArrowDown size={SIZE} aria-hidden focusable={false} />;
}

export function DuplicateIcon(): ReactNode {
	return <Copy size={SIZE} aria-hidden focusable={false} />;
}
export function TrashIcon(): ReactNode {
	return <Trash size={SIZE} aria-hidden focusable={false} />;
}

export function PlusIcon(): ReactNode {
	return <Plus size={SIZE} aria-hidden focusable={false} />;
}

export function AlignLeftIcon(): ReactNode {
	return <TextAlignLeft size={SIZE} aria-hidden focusable={false} />;
}

export function AlignCenterIcon(): ReactNode {
	return <TextAlignCenter size={SIZE} aria-hidden focusable={false} />;
}

export function AlignRightIcon(): ReactNode {
	return <TextAlignRight size={SIZE} aria-hidden focusable={false} />;
}

export function AlignJustifyIcon(): ReactNode {
	return <TextAlignJustify size={SIZE} aria-hidden focusable={false} />;
}

export function IndentIcon(): ReactNode {
	return <TextIndent size={SIZE} aria-hidden focusable={false} />;
}

export function OutdentIcon(): ReactNode {
	return <TextOutdent size={SIZE} aria-hidden focusable={false} />;
}

export function BoldIcon(): ReactNode {
	return <TextB size={SIZE} aria-hidden focusable={false} />;
}

export function ItalicIcon(): ReactNode {
	return <TextItalic size={SIZE} aria-hidden focusable={false} />;
}

export function UnderlineIcon(): ReactNode {
	return <TextUnderline size={SIZE} aria-hidden focusable={false} />;
}

export function StrikeIcon(): ReactNode {
	return <TextStrikethrough size={SIZE} aria-hidden focusable={false} />;
}

export function InlineCodeIcon(): ReactNode {
	return <Code size={SIZE} aria-hidden focusable={false} />;
}

export function LinkIcon(): ReactNode {
	return <Link size={SIZE} aria-hidden focusable={false} />;
}

export function UnlinkIcon(): ReactNode {
	return <LinkBreak size={SIZE} aria-hidden focusable={false} />;
}

export function DividerIcon(): ReactNode {
	return <Minus size={SIZE} aria-hidden focusable={false} />;
}

export function CopyIcon(): ReactNode {
	return <Copy size={SIZE} aria-hidden focusable={false} />;
}

export function CommentIcon(): ReactNode {
	return <ChatCircle size={SIZE} aria-hidden focusable={false} />;
}

export function EmojiIcon(): ReactNode {
	return <Smiley size={SIZE} aria-hidden focusable={false} />;
}

export function CutIcon(): ReactNode {
	return <Scissors size={SIZE} aria-hidden focusable={false} />;
}

export function PropertyIcon(): ReactNode {
	return <Rows size={SIZE} aria-hidden focusable={false} />;
}

export function SearchIcon(): ReactNode {
	return <MagnifyingGlass size={SIZE} aria-hidden focusable={false} />;
}

export function CloseXIcon(): ReactNode {
	return <X size={SIZE} aria-hidden focusable={false} />;
}

export function CheckIcon(): ReactNode {
	return <Check size={SIZE} aria-hidden focusable={false} />;
}

export function MoreIcon(): ReactNode {
	return <DotsThree size={SIZE} weight="bold" aria-hidden focusable={false} />;
}

export function TextTypeIcon(): ReactNode {
	return <TextT size={SIZE} aria-hidden focusable={false} />;
}

export function TocIcon(): ReactNode {
	return <ListDashes size={SIZE} aria-hidden focusable={false} />;
}

export function ColumnsIcon(): ReactNode {
	return <Columns size={SIZE} aria-hidden focusable={false} />;
}

export function SubPageIcon(): ReactNode {
	return <FilePlus size={SIZE} aria-hidden focusable={false} />;
}

export function EquationIcon(): ReactNode {
	return <FunctionGlyph size={SIZE} aria-hidden focusable={false} />;
}

export function FileIcon(): ReactNode {
	return <File size={SIZE} aria-hidden focusable={false} />;
}

export function AudioIcon(): ReactNode {
	return <MusicNote size={SIZE} aria-hidden focusable={false} />;
}

export function GlobeIcon(): ReactNode {
	return <Globe size={SIZE} aria-hidden focusable={false} />;
}

export function EmbedIcon(): ReactNode {
	return <BracketsAngle size={SIZE} aria-hidden focusable={false} />;
}

export function BookmarkIcon(): ReactNode {
	return <Bookmark size={SIZE} aria-hidden focusable={false} />;
}

export function ToggleIcon(): ReactNode {
	return <CaretRight size={SIZE} aria-hidden focusable={false} />;
}

export function TableIcon(): ReactNode {
	return <Table size={SIZE} aria-hidden focusable={false} />;
}

export function ArrowLeftIcon(): ReactNode {
	return <ArrowLeft size={SIZE} aria-hidden focusable={false} />;
}

export function ArrowRightIcon(): ReactNode {
	return <ArrowRight size={SIZE} aria-hidden focusable={false} />;
}

export function SortAscIcon(): ReactNode {
	return <SortAscending size={SIZE} aria-hidden focusable={false} />;
}

export function SortDescIcon(): ReactNode {
	return <SortDescending size={SIZE} aria-hidden focusable={false} />;
}

export function FillDownIcon(): ReactNode {
	return <ArrowLineDown size={SIZE} aria-hidden focusable={false} />;
}

export function MoveColLeftIcon(): ReactNode {
	return <ArrowLineLeft size={SIZE} aria-hidden focusable={false} />;
}

export function MoveColRightIcon(): ReactNode {
	return <ArrowLineRight size={SIZE} aria-hidden focusable={false} />;
}

export function TextColorIcon(): ReactNode {
	return <TextAa size={SIZE} aria-hidden focusable={false} />;
}

export function NumberTypeIcon(): ReactNode {
	return <Hash size={SIZE} aria-hidden focusable={false} />;
}

export function BooleanTypeIcon(): ReactNode {
	return <ToggleRight size={SIZE} aria-hidden focusable={false} />;
}

export function DateTypeIcon(): ReactNode {
	return <Calendar size={SIZE} aria-hidden focusable={false} />;
}

export function RefTypeIcon(): ReactNode {
	return <Link size={SIZE} aria-hidden focusable={false} />;
}

export function RichTextTypeIcon(): ReactNode {
	return <TextAlignLeft size={SIZE} aria-hidden focusable={false} />;
}

export function GripIcon(): ReactNode {
	return <DotsSixVertical size={SIZE} aria-hidden focusable={false} />;
}
