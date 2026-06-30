/**
 * InlineToolbarPlugin — the shared floating formatting toolbar that appears
 * above any non-collapsed text selection. Bundled into `<FullEditorPlugins>`
 * so every editor consumer (Notes / Journal / Tasks / Bookmarks) gets the same
 * B/I/U/S/code + colour + link affordance — previously this lived only in Notes.
 *
 * Core formatting (marks, colour, link, remove-formatting) is always present.
 * The overflow extras are opt-in:
 *   - `mention` / `emoji` — only shown when the host mounts the matching
 *     typeahead plugin (the row drives its `@` / `:` trigger).
 *   - `onInsertEquation` — a host-supplied callback (Notes' inline LaTeX); the
 *     "Inline equation" row appears only when it's provided.
 *
 * Position is computed from the selection's visual `getBoundingClientRect()`
 * (Lexical's selection is logical) and re-measured on resize/scroll. The
 * toolbar `position: fixed`-renders outside the contenteditable and
 * `preventDefault`s its mousedown so pressing it doesn't clear the selection.
 */

import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
	$getSelection,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_LOW,
	FORMAT_TEXT_COMMAND,
	SELECTION_CHANGE_COMMAND,
	type TextFormatType,
} from "lexical";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	$commentAnchorFromSelection,
	type SelectionCommentAnchor,
} from "../comments/selection-anchor";
import { type EditorT, useEditorT } from "../i18n";
import {
	BoldIcon,
	CommentIcon,
	EmojiIcon,
	EquationIcon,
	InlineCodeIcon,
	ItalicIcon,
	LinkIcon,
	MoreIcon,
	RefTypeIcon,
	StrikeIcon,
	TextColorIcon,
	UnderlineIcon,
	UnlinkIcon,
} from "../icons";
import {
	ColorTarget,
	SWATCH_COLORS,
	SwatchColor,
	applySwatch,
	readActiveSwatch,
	swatchCssValue,
} from "../text-color";
import { useEditorShortcut } from "./editor-shortcut";
import { OPEN_EMOJI_BROWSE_COMMAND } from "./emoji-typeahead-plugin";

export type InlineToolbarPluginProps = {
	/** Show a "Mention" overflow row (inserts `@` for the mention typeahead).
	 *  Only enable when `<MentionTypeaheadPlugin>` is mounted. */
	mention?: boolean;
	/** Show an "Emoji" overflow row (opens the `:`-typeahead in browse mode).
	 *  Only enable when `<EmojiTypeaheadPlugin>` is mounted. */
	emoji?: boolean;
	/** Host-supplied inline-equation insert (Notes). When set, an "Inline
	 *  equation" overflow row wraps the selection. */
	onInsertEquation?: () => void;
	/** Host-supplied comment-on-selection (B11.9). When set, a "Comment"
	 *  overflow row anchors a comment to the selection's block, handing the
	 *  host the block id + quoted text. */
	onComment?: (anchor: SelectionCommentAnchor) => void;
};

enum InlineFormat {
	Bold = "bold",
	Italic = "italic",
	Underline = "underline",
	Strike = "strikethrough",
	Code = "code",
}

type ToolbarState = {
	rect: DOMRect;
	active: ReadonlySet<InlineFormat>;
	linkUrl: string | null;
	textColor: SwatchColor;
	highlight: SwatchColor;
};

const TOOLBAR_GAP_PX = 8;
const TOOLBAR_HEIGHT = 36;

/** Bottom edge of the app chrome's reserved top band. Every first-party app
 *  injects `--app-header-height` (44px) via the shell preload; standalone /
 *  preview surfaces with no header resolve it to 0. */
function appHeaderHeight(): number {
	const raw = getComputedStyle(document.documentElement)
		.getPropertyValue("--app-header-height")
		.trim();
	const px = Number.parseFloat(raw);
	return Number.isFinite(px) ? px : 0;
}

function colorName(t: EditorT, color: SwatchColor): string {
	switch (color) {
		case SwatchColor.Gray:
			return t("editor.inline.colorName.gray");
		case SwatchColor.Brown:
			return t("editor.inline.colorName.brown");
		case SwatchColor.Orange:
			return t("editor.inline.colorName.orange");
		case SwatchColor.Yellow:
			return t("editor.inline.colorName.yellow");
		case SwatchColor.Green:
			return t("editor.inline.colorName.green");
		case SwatchColor.Blue:
			return t("editor.inline.colorName.blue");
		case SwatchColor.Purple:
			return t("editor.inline.colorName.purple");
		case SwatchColor.Pink:
			return t("editor.inline.colorName.pink");
		case SwatchColor.Red:
			return t("editor.inline.colorName.red");
		default:
			return t("editor.inline.color.default");
	}
}

export function InlineToolbarPlugin(props: InlineToolbarPluginProps = {}): ReactNode {
	const [editor] = useLexicalComposerContext();
	const [state, setState] = useState<ToolbarState | null>(null);
	const [linkEditor, setLinkEditor] = useState<{ value: string; original: string | null } | null>(
		null,
	);

	useEffect(() => {
		function read(): ToolbarState | null {
			// A locked / read-only note (`editor.setEditable(false)`) must never
			// show the formatting toolbar — text is still selectable in a
			// `contenteditable="false"` element, so a stale selection would keep
			// the bar up. Gate on editability (and re-run via the editable
			// listener below so locking *while* selected dismisses it).
			if (!editor.isEditable()) return null;
			let next: ToolbarState | null = null;
			editor.getEditorState().read(() => {
				const selection = $getSelection();
				if (!$isRangeSelection(selection) || selection.isCollapsed()) return;
				const text = selection.getTextContent();
				if (text.length === 0) return;
				const native = window.getSelection();
				if (!native || native.rangeCount === 0) return;
				const range = native.getRangeAt(0);
				const rect = range.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) return;
				const active = new Set<InlineFormat>();
				for (const f of [
					InlineFormat.Bold,
					InlineFormat.Italic,
					InlineFormat.Underline,
					InlineFormat.Strike,
					InlineFormat.Code,
				]) {
					if (selection.hasFormat(f)) active.add(f);
				}
				const node = selection.anchor.getNode();
				const parent = node.getParent();
				const linkNode = $isLinkNode(node) ? node : $isLinkNode(parent) ? parent : null;
				next = {
					rect,
					active,
					linkUrl: linkNode ? linkNode.getURL() : null,
					textColor: readActiveSwatch(ColorTarget.Text),
					highlight: readActiveSwatch(ColorTarget.Highlight),
				};
			});
			return next;
		}

		function apply(): void {
			const next = read();
			setState(next);
			if (!next) setLinkEditor(null);
		}

		let raf = 0;
		const reflow = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				apply();
			});
		};
		window.addEventListener("resize", reflow);
		window.addEventListener("scroll", reflow, true);

		return mergeRegister(
			editor.registerUpdateListener(apply),
			// Lock/unlock toggles `editable` — re-evaluate so the bar hides the
			// moment a note is locked (and may return once unlocked).
			editor.registerEditableListener(() => apply()),
			editor.registerCommand(
				SELECTION_CHANGE_COMMAND,
				() => {
					apply();
					return false;
				},
				COMMAND_PRIORITY_LOW,
			),
			() => {
				window.removeEventListener("resize", reflow);
				window.removeEventListener("scroll", reflow, true);
				if (raf) cancelAnimationFrame(raf);
			},
		);
	}, [editor]);

	const toggleFormat = useCallback(
		(format: InlineFormat) => {
			editor.dispatchCommand(FORMAT_TEXT_COMMAND, format as TextFormatType);
		},
		[editor],
	);

	const applyColor = useCallback(
		(target: ColorTarget, color: SwatchColor) => {
			applySwatch(editor, target, color);
		},
		[editor],
	);

	const removeFormatting = useCallback(() => {
		if (!state) return;
		for (const format of state.active) {
			editor.dispatchCommand(FORMAT_TEXT_COMMAND, format as TextFormatType);
		}
		if (state.textColor !== SwatchColor.Default) {
			applySwatch(editor, ColorTarget.Text, SwatchColor.Default);
		}
		if (state.highlight !== SwatchColor.Default) {
			applySwatch(editor, ColorTarget.Highlight, SwatchColor.Default);
		}
	}, [editor, state]);

	const insertMention = useCallback(() => {
		editor.focus();
		editor.update(() => {
			const sel = $getSelection();
			if (!$isRangeSelection(sel)) return;
			const end = sel.isBackward() ? sel.anchor : sel.focus;
			sel.anchor.set(end.key, end.offset, end.type);
			sel.focus.set(end.key, end.offset, end.type);
			const node = sel.anchor.getNode();
			const before = $isTextNode(node) ? node.getTextContent().slice(0, sel.anchor.offset) : "";
			const prev = before.slice(-1);
			const needsSpace = prev !== "" && !/[\s([{]/.test(prev);
			sel.insertText(needsSpace ? " @" : "@");
		});
	}, [editor]);

	const insertEmoji = useCallback(() => {
		editor.dispatchCommand(OPEN_EMOJI_BROWSE_COMMAND, undefined);
	}, [editor]);

	const onComment = props.onComment;
	const commentOnSelection = useCallback(() => {
		if (!onComment) return;
		editor.getEditorState().read(() => {
			const anchor = $commentAnchorFromSelection();
			if (anchor) onComment(anchor);
		});
	}, [editor, onComment]);

	const openLinkEditor = useCallback(() => {
		if (!state) return;
		setLinkEditor({ value: state.linkUrl ?? "", original: state.linkUrl });
	}, [state]);

	const closeLinkEditor = useCallback(() => setLinkEditor(null), []);

	const commitLink = useCallback(
		(value: string | null) => {
			const url = value === null ? null : value.trim();
			editor.dispatchCommand(TOGGLE_LINK_COMMAND, url && url.length > 0 ? url : null);
			setLinkEditor(null);
		},
		[editor],
	);

	const [colorMenuOpen, setColorMenuOpen] = useState(false);
	useEffect(() => {
		if (!state) setColorMenuOpen(false);
	}, [state]);
	useEditorShortcut(
		["Mod+Shift+c", "Mod+Shift+h"],
		useCallback(
			(event: KeyboardEvent) => {
				if (!state) return;
				event.preventDefault();
				setColorMenuOpen(true);
			},
			[state],
		),
	);

	if (!state) return null;
	return (
		<InlineToolbar
			state={state}
			linkEditor={linkEditor}
			colorMenuOpen={colorMenuOpen}
			onColorMenuOpenChange={setColorMenuOpen}
			onToggleFormat={toggleFormat}
			onApplyColor={applyColor}
			onOpenLinkEditor={openLinkEditor}
			onCloseLinkEditor={closeLinkEditor}
			onCommitLink={commitLink}
			onRemoveFormatting={removeFormatting}
			{...(props.onInsertEquation ? { onInsertEquation: props.onInsertEquation } : {})}
			{...(props.mention ? { onInsertMention: insertMention } : {})}
			{...(props.emoji ? { onInsertEmoji: insertEmoji } : {})}
			{...(onComment ? { onComment: commentOnSelection } : {})}
		/>
	);
}

type InlineToolbarProps = {
	state: ToolbarState;
	linkEditor: { value: string; original: string | null } | null;
	colorMenuOpen: boolean;
	onColorMenuOpenChange: (open: boolean) => void;
	onToggleFormat: (format: InlineFormat) => void;
	onApplyColor: (target: ColorTarget, color: SwatchColor) => void;
	onOpenLinkEditor: () => void;
	onCloseLinkEditor: () => void;
	onCommitLink: (value: string | null) => void;
	onRemoveFormatting: () => void;
	onInsertEquation?: () => void;
	onInsertMention?: () => void;
	onInsertEmoji?: () => void;
	onComment?: () => void;
};

function InlineToolbar({
	state,
	linkEditor,
	colorMenuOpen,
	onColorMenuOpenChange,
	onToggleFormat,
	onApplyColor,
	onOpenLinkEditor,
	onCloseLinkEditor,
	onCommitLink,
	onRemoveFormatting,
	onInsertEquation,
	onInsertMention,
	onInsertEmoji,
	onComment,
}: InlineToolbarProps) {
	const t = useEditorT();
	const ref = useRef<HTMLDivElement | null>(null);
	const [overflowOpen, setOverflowOpen] = useState(false);
	const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

	// biome-ignore lint/correctness/useExhaustiveDependencies: `linkEditor` is intentionally a dep — the toolbar swaps its children (buttons vs URL input) on toggle, changing `offsetWidth`. Re-measuring is the point.
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const width = node.offsetWidth;
		const viewportW = window.innerWidth;
		const viewportH = window.innerHeight;
		// The app chrome reserves the top `--app-header-height` band (44px in
		// every first-party app). Placing the `position: fixed` toolbar above a
		// selection that sits high in the document tucks it under that header —
		// since the toolbar is translucent glass the header shows through and it
		// reads as a broken z-index. Treat the header's bottom edge as the real
		// top boundary so the toolbar flips below the selection instead.
		const safeTop = appHeaderHeight() + TOOLBAR_GAP_PX;
		const cx = state.rect.left + state.rect.width / 2;
		let left = Math.round(cx - width / 2);
		if (left < 8) left = 8;
		if (left + width > viewportW - 8) left = viewportW - 8 - width;
		let top = Math.round(state.rect.top - TOOLBAR_HEIGHT - TOOLBAR_GAP_PX);
		if (top < safeTop) top = Math.round(state.rect.bottom + TOOLBAR_GAP_PX);
		if (top + TOOLBAR_HEIGHT > viewportH - 8) {
			top = Math.max(safeTop, viewportH - 8 - TOOLBAR_HEIGHT);
		}
		setPosition({ top, left });
	}, [state.rect, linkEditor]);

	const hasOverflow = onInsertEquation || onInsertMention || onInsertEmoji || onComment;

	return (
		<div
			ref={ref}
			className="fm-menu notes__inline-toolbar"
			role="toolbar"
			aria-label={t("editor.inline.toolbar.region")}
			style={{ top: `${position.top}px`, left: `${position.left}px` }}
			onMouseDown={(event) => event.preventDefault()}
		>
			{linkEditor ? (
				<LinkInput
					initial={linkEditor.value}
					hasExisting={linkEditor.original !== null}
					onCommit={onCommitLink}
					onCancel={onCloseLinkEditor}
				/>
			) : (
				<>
					<ToolButton
						label={t("editor.inline.bold")}
						active={state.active.has(InlineFormat.Bold)}
						onSelect={() => onToggleFormat(InlineFormat.Bold)}
					>
						<BoldIcon />
					</ToolButton>
					<ToolButton
						label={t("editor.inline.italic")}
						active={state.active.has(InlineFormat.Italic)}
						onSelect={() => onToggleFormat(InlineFormat.Italic)}
					>
						<ItalicIcon />
					</ToolButton>
					<ToolButton
						label={t("editor.inline.underline")}
						active={state.active.has(InlineFormat.Underline)}
						onSelect={() => onToggleFormat(InlineFormat.Underline)}
					>
						<UnderlineIcon />
					</ToolButton>
					<ToolButton
						label={t("editor.inline.strike")}
						active={state.active.has(InlineFormat.Strike)}
						onSelect={() => onToggleFormat(InlineFormat.Strike)}
					>
						<StrikeIcon />
					</ToolButton>
					<ToolButton
						label={t("editor.inline.code")}
						active={state.active.has(InlineFormat.Code)}
						onSelect={() => onToggleFormat(InlineFormat.Code)}
					>
						<InlineCodeIcon />
					</ToolButton>
					<div className="notes__inline-toolbar-divider" aria-hidden="true" />
					<div className="notes__inline-toolbar-color">
						<ToolButton
							label={t("editor.inline.color")}
							active={state.textColor !== SwatchColor.Default || state.highlight !== SwatchColor.Default}
							onSelect={() => onColorMenuOpenChange(!colorMenuOpen)}
						>
							<TextColorIcon />
						</ToolButton>
						{colorMenuOpen && (
							<ColorMenu
								textColor={state.textColor}
								highlight={state.highlight}
								onApply={(target, color) => {
									onApplyColor(target, color);
									onColorMenuOpenChange(false);
								}}
								onClose={() => onColorMenuOpenChange(false)}
							/>
						)}
					</div>
					<ToolButton
						label={t(state.linkUrl ? "editor.inline.editLink" : "editor.inline.link")}
						active={state.linkUrl !== null}
						onSelect={onOpenLinkEditor}
					>
						<LinkIcon />
					</ToolButton>
					{hasOverflow && (
						<>
							<div className="notes__inline-toolbar-divider" aria-hidden="true" />
							<div className="notes__inline-toolbar-overflow">
								<ToolButton
									label={t("editor.inline.more")}
									active={overflowOpen}
									onSelect={() => setOverflowOpen((open) => !open)}
								>
									<MoreIcon />
								</ToolButton>
								{overflowOpen && (
									<OverflowMenu
										onRemoveFormatting={() => {
											onRemoveFormatting();
											setOverflowOpen(false);
										}}
										{...(onInsertEquation
											? {
													onInsertEquation: () => {
														onInsertEquation();
														setOverflowOpen(false);
													},
												}
											: {})}
										{...(onInsertMention
											? {
													onInsertMention: () => {
														onInsertMention();
														setOverflowOpen(false);
													},
												}
											: {})}
										{...(onInsertEmoji
											? {
													onInsertEmoji: () => {
														onInsertEmoji();
														setOverflowOpen(false);
													},
												}
											: {})}
										{...(onComment
											? {
													onComment: () => {
														onComment();
														setOverflowOpen(false);
													},
												}
											: {})}
										onClose={() => setOverflowOpen(false)}
									/>
								)}
							</div>
						</>
					)}
				</>
			)}
		</div>
	);
}

function OverflowMenu({
	onRemoveFormatting,
	onInsertEquation,
	onInsertMention,
	onInsertEmoji,
	onComment,
	onClose,
}: {
	onRemoveFormatting: () => void;
	onInsertEquation?: () => void;
	onInsertMention?: () => void;
	onInsertEmoji?: () => void;
	onComment?: () => void;
	onClose: () => void;
}) {
	const t = useEditorT();
	useEditorShortcut(
		["Escape"],
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				onClose();
			},
			[onClose],
		),
	);
	return (
		<div
			className="fm-menu notes__inline-overflow-menu"
			role="menu"
			aria-label={t("editor.inline.overflow.region")}
		>
			<div className="fm-list" role="presentation">
				<button type="button" role="menuitem" className="fm-row" onClick={onRemoveFormatting}>
					<span className="fm-row__name">{t("editor.inline.removeFormat")}</span>
				</button>
				{onInsertEquation && (
					<button type="button" role="menuitem" className="fm-row" onClick={onInsertEquation}>
						<span className="fm-row__icon" aria-hidden="true">
							<EquationIcon />
						</span>
						<span className="fm-row__name">{t("editor.inline.equation")}</span>
					</button>
				)}
				{onInsertMention && (
					<button type="button" role="menuitem" className="fm-row" onClick={onInsertMention}>
						<span className="fm-row__icon" aria-hidden="true">
							<RefTypeIcon />
						</span>
						<span className="fm-row__name">{t("editor.inline.mention")}</span>
					</button>
				)}
				{onInsertEmoji && (
					<button type="button" role="menuitem" className="fm-row" onClick={onInsertEmoji}>
						<span className="fm-row__icon" aria-hidden="true">
							<EmojiIcon />
						</span>
						<span className="fm-row__name">{t("editor.inline.emoji")}</span>
					</button>
				)}
				{onComment && (
					<button type="button" role="menuitem" className="fm-row" onClick={onComment}>
						<span className="fm-row__icon" aria-hidden="true">
							<CommentIcon />
						</span>
						<span className="fm-row__name">{t("editor.inline.comment")}</span>
					</button>
				)}
			</div>
		</div>
	);
}

function ColorMenu({
	textColor,
	highlight,
	onApply,
	onClose,
}: {
	textColor: SwatchColor;
	highlight: SwatchColor;
	onApply: (target: ColorTarget, color: SwatchColor) => void;
	onClose: () => void;
}) {
	const t = useEditorT();
	useEditorShortcut(
		["Escape"],
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				onClose();
			},
			[onClose],
		),
	);
	return (
		<div
			className="fm-menu notes__color-menu"
			role="menu"
			aria-label={t("editor.inline.color.region")}
		>
			<ColorRow
				target={ColorTarget.Text}
				heading={t("editor.inline.color.text")}
				active={textColor}
				onApply={onApply}
			/>
			<ColorRow
				target={ColorTarget.Highlight}
				heading={t("editor.inline.color.highlight")}
				active={highlight}
				onApply={onApply}
			/>
		</div>
	);
}

function ColorRow({
	target,
	heading,
	active,
	onApply,
}: {
	target: ColorTarget;
	heading: string;
	active: SwatchColor;
	onApply: (target: ColorTarget, color: SwatchColor) => void;
}) {
	const t = useEditorT();
	return (
		<div className="notes__color-row">
			<div className="notes__color-row-heading">{heading}</div>
			<div className="notes__color-swatches">
				{SWATCH_COLORS.map((color) => {
					const isDefault = color === SwatchColor.Default;
					const label = isDefault ? t("editor.inline.color.default") : colorName(t, color);
					const value = swatchCssValue(target, color);
					const chipStyle =
						value === null
							? undefined
							: target === ColorTarget.Text
								? { color: value }
								: { backgroundColor: value };
					return (
						<button
							key={color}
							type="button"
							role="menuitemradio"
							aria-checked={active === color}
							className={
								active === color ? "notes__color-swatch notes__color-swatch--active" : "notes__color-swatch"
							}
							title={label}
							aria-label={t("editor.inline.color.swatchLabel", { group: heading, color: label })}
							onClick={() => onApply(target, color)}
						>
							<span
								aria-hidden="true"
								className={
									isDefault
										? "notes__color-swatch-chip notes__color-swatch-chip--default"
										: "notes__color-swatch-chip"
								}
								style={chipStyle}
							>
								{target === ColorTarget.Text && !isDefault ? "A" : null}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function ToolButton({
	children,
	label,
	active,
	onSelect,
}: {
	children: ReactNode;
	label: string;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			className={
				active
					? "notes__inline-toolbar-btn notes__inline-toolbar-btn--active"
					: "notes__inline-toolbar-btn"
			}
			title={label}
			aria-label={label}
			aria-pressed={active}
			onClick={onSelect}
		>
			{children}
		</button>
	);
}

function LinkInput({
	initial,
	hasExisting,
	onCommit,
	onCancel,
}: {
	initial: string;
	hasExisting: boolean;
	onCommit: (value: string | null) => void;
	onCancel: () => void;
}) {
	const t = useEditorT();
	const [value, setValue] = useState(initial);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useLayoutEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	return (
		<form
			className="notes__inline-toolbar-link"
			onSubmit={(event) => {
				event.preventDefault();
				onCommit(value);
			}}
		>
			<input
				ref={inputRef}
				type="url"
				className="notes__inline-toolbar-link-input"
				placeholder={t("editor.inline.link.placeholder")}
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					// keyboard-exempt
					if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
			/>
			<button
				type="submit"
				className="notes__inline-toolbar-btn notes__inline-toolbar-btn--primary"
				title={t("editor.inline.link.commit")}
				aria-label={t("editor.inline.link.commit")}
			>
				<LinkIcon />
			</button>
			{hasExisting && (
				<button
					type="button"
					className="notes__inline-toolbar-btn notes__inline-toolbar-btn--destructive"
					title={t("editor.inline.link.remove")}
					aria-label={t("editor.inline.link.remove")}
					onClick={() => onCommit(null)}
				>
					<UnlinkIcon />
				</button>
			)}
		</form>
	);
}
