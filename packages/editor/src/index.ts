/**
 * @brainstorm/editor — `brainstorm-editor` (Stage 9.2).
 *
 * A pre-configured, always-Yjs-backed Lexical editor + the baseline node
 * set + a Lexical-free read-only preview renderer. Consumes 9.1's
 * `useYDoc(doc)` path; `entityId`-resolved editing layers on at 9.3 when
 * the SDK entities service installs the resolver. Custom app nodes stay
 * app-local in a separate registry (OQ-12); the `BlockEmbedNode` bridge
 * is Stage 9.4.
 */

import "./virtualize-styles.css";
import "./plugins/table-styles.css";
import "./plugins/block-selection-styles.css";
import "./plugins/block-gutter-styles.css";

export {
	type BlockCommand,
	type CommandContext,
	CommandCategory,
} from "./block-command";
export { BlockType, CalloutTone, ToggleVariant } from "./block-types";
export { BLOCK_ID_ATTR, mintBlockId, stableBlockId } from "./block-id";
export {
	BLOCK_MARKDOWN_TRANSFORMERS,
	HR_TRANSFORMER,
} from "./markdown-block-transformers";
export {
	type AnchorMapLike,
	type BlockAnchorEntry,
	type BlockAnchorStore,
	type BlockSnapshot,
	BLOCK_ANCHORS_MAP_NAME,
	anchorEntriesEqual,
	coerceAnchorEntry,
	createMapBlockAnchorStore,
	fingerprintText,
	matchAnchorBlock,
} from "./block-anchors";
export {
	type BlockAnchorReveal,
	type BlockAnchorsController,
	type BlockAnchorsPluginProps,
	BLOCK_ANCHOR_FLASH_CLASS,
	BlockAnchorsPlugin,
	getBlockAnchorsController,
	mountBlockAnchors,
	revealBlockByKey,
	startAnchorReveal,
} from "./plugins/block-anchors-plugin";

// Shared rich-editor plugins (extracted 2026-05-25 from
// `apps/notes/src/editor/` so Journal — and any future app — can mount
// the same editor surface). Notes-coupled plugins (mention, backlinks,
// add-property, transclusion, link-markup, block-gutter / context-menu /
// slash-menu seams) stay app-local until the i18n + keyboard seams
// land in a follow-up iteration.
export { AutosavePlugin } from "./plugins/autosave-plugin";
export { EditorCapturePlugin, devAppendParagraph } from "./plugins/dev-bench";
export {
	type BlockSelectionPluginProps,
	type BlockSelectionAction,
	type BlockSelectionChords,
	BLOCK_SELECTION_DEFAULT_CHORDS,
	BlockSelectionPlugin,
	useBlockSelection,
	useBlockSelectionStore,
} from "./plugins/block-selection-plugin";
export {
	type BlockSelectionSnapshot,
	BlockSelectionStore,
} from "./plugins/block-selection-store";
export {
	type ClipboardPayload,
	BRAINSTORM_HTML_SENTINEL,
	BRAINSTORM_MIME,
	extractBrainstormPayloadFromHtml,
	insertBlocks,
	insertSnippet,
	parseBrainstormPayload,
	plainTextToSerializedBlocks,
	serializeBlocksAsHtml,
	serializeBlocksAsJson,
	serializeBlocksAsText,
} from "./plugins/block-clipboard";
export {
	deepCloneNode,
	duplicateBlocks,
	formatTextInBlocks,
	moveBlocksDown,
	moveBlocksTo,
	moveBlocksUp,
} from "./plugins/block-ops";
export {
	type OpenBlockActionMenuOptions,
	openBlockActionMenu,
} from "./plugins/block-action-menu";
export { gutterAnchor } from "./plugins/block-gutter-anchor";
export {
	type BlockGutterPluginProps,
	BlockGutterPlugin,
} from "./plugins/block-gutter-plugin";
export { useEditorShortcut } from "./plugins/editor-shortcut";
export {
	type SlashMenuPluginProps,
	SlashMenuPlugin,
	filterCommands,
} from "./plugins/slash-menu-plugin";
export {
	AlignCenterIcon,
	AlignJustifyIcon,
	AlignLeftIcon,
	AlignRightIcon,
	ArrowDownIcon,
	ArrowUpIcon,
	AudioIcon,
	BoldIcon,
	BookmarkIcon,
	BooleanTypeIcon,
	BulletListIcon,
	CalloutIcon,
	CheckIcon,
	CloseXIcon,
	CodeIcon,
	ColumnsIcon,
	CopyIcon,
	CutIcon,
	DateTypeIcon,
	DividerIcon,
	DuplicateIcon,
	EmbedIcon,
	EquationIcon,
	FileIcon,
	GlobeIcon,
	GripIcon,
	Heading1Icon,
	Heading2Icon,
	Heading3Icon,
	ImageIcon,
	IndentIcon,
	InlineCodeIcon,
	ItalicIcon,
	LinkIcon,
	MoreIcon,
	NumberTypeIcon,
	NumberedListIcon,
	OutdentIcon,
	ParagraphIcon,
	PlusIcon,
	PropertyIcon,
	QuoteIcon,
	RefTypeIcon,
	RichTextTypeIcon,
	SearchIcon,
	StrikeIcon,
	SubPageIcon,
	TableIcon,
	TextColorIcon,
	TextTypeIcon,
	TocIcon,
	TodoListIcon,
	ToggleIcon,
	TrashIcon,
	UnderlineIcon,
	UnlinkIcon,
	VideoIcon,
} from "./icons";
export { ColumnsPlugin, INSERT_COLUMNS_COMMAND } from "./plugins/columns-plugin";
export { EditablePlugin, type EditablePluginProps } from "./plugins/editable-plugin";
export { InitialFocusPlugin } from "./plugins/initial-focus-plugin";
export { TablesPlugin } from "./plugins/table-plugin";
export { TableColumnResizePlugin } from "./plugins/table-column-resize-plugin";
export {
	TableAxis,
	TableEdge,
	deleteTable,
	deleteTableLine,
	insertTableLine,
	selectionInTable,
	toggleHeaderRow,
} from "./plugins/table-ops";
export { TitlePlugin, enforceTitleInvariant } from "./plugins/title-plugin";
export {
	INSERT_TOGGLE_COMMAND,
	TogglePlugin,
	type TogglePluginProps,
} from "./plugins/toggle-plugin";
export { ToggleCollapseStore } from "./plugins/toggle-collapse-store";
export { TURN_INTO_COMMAND, TurnIntoPlugin } from "./plugins/turn-into-plugin";
export {
	type StandardEditingPluginsProps,
	StandardEditingPlugins,
} from "./plugins/standard-editing-plugins";
export {
	type FullEditorPluginsProps,
	FullEditorPlugins,
} from "./plugins/full-editor-plugins";
export {
	createStandardBlockActions,
	createStandardBlockCommands,
	createTransclusionCommand,
	orderCommandsByPalette,
	selectBlocksAsRange,
} from "./standard-commands";
export { MEDIA_COMMAND_IDS, createMediaBlockCommands } from "./media-commands";
export { STANDARD_ADDITIONAL_NODES, FULL_EDITOR_NODES, MEDIA_NODES } from "./standard-nodes";
export { MediaDropPlugin } from "./plugins/media-drop-plugin";
export { MediaInspectorPlugin } from "./plugins/media-inspector-plugin";
export {
	type InspectorTarget,
	MediaKind,
	mediaInspectorStore,
	useMediaInspector,
} from "./media-inspector-store";
export {
	DEFAULT_MEDIA_ALIGNMENT,
	DEFAULT_MEDIA_WIDTH_PERCENT,
	MAX_MEDIA_WIDTH_PERCENT,
	MIN_MEDIA_WIDTH_PERCENT,
	MediaAlignment,
	clampMediaWidth,
	isMediaAlignment,
} from "./media-types";
export {
	MediaFileKind,
	classifyMediaFile,
	collectMediaFiles,
	dataTransferHasFiles,
	readAsDataUrl,
	resolveBinarySrc,
	resolveImageSrc,
	tryUploadFile,
} from "./media-upload";
export {
	$createImageBlockNode,
	$isImageBlockNode,
	IMAGE_BLOCK_TYPE,
	ImageBlockNode,
	type SerializedImageBlockNode,
} from "./nodes/image-block-node";
export {
	$createVideoBlockNode,
	$isVideoBlockNode,
	VIDEO_BLOCK_TYPE,
	VideoBlockNode,
	type SerializedVideoBlockNode,
} from "./nodes/video-block-node";
export {
	$createAudioBlockNode,
	$isAudioBlockNode,
	AUDIO_BLOCK_TYPE,
	AudioBlockNode,
	type SerializedAudioBlockNode,
} from "./nodes/audio-block-node";
export {
	$createFileBlockNode,
	$isFileBlockNode,
	FILE_BLOCK_TYPE,
	FileBlockNode,
	formatBytes,
	type SerializedFileBlockNode,
} from "./nodes/file-block-node";
export {
	type EditorHost,
	type EditorUploadFn,
	type EditorUploadResult,
	getEditorHost,
	setEditorHost,
} from "./plugins/editor-host";
export { dispatchOpenEntity } from "./plugins/open-entity-dispatch";
export {
	type EditorEntityContextValue,
	type EditorEntityProviderProps,
	EditorEntityProvider,
	useEditorEntity,
	useEditorEntityOptional,
} from "./plugins/editor-entity";
export {
	type EntityIndexSource,
	type EntityIndexSubscription,
	entitiesSnapshotList,
	entityIconsSnapshot,
	entityTitleOf,
	entityTitlesSnapshot,
	fetchEntities,
	getEntityDisplayIcon,
	getEntityIcon,
	getEntityTitle,
	setEntityIndexSource,
	subscribeEntityIcons,
	subscribeEntityTitles,
} from "./plugins/entity-index";
export { type EntityIconProps, EntityIcon } from "./entity-icon";
export {
	type TransclusionBodyRenderer,
	type TransclusionRenderContextValue,
	type TransclusionRenderProviderProps,
	TransclusionRenderProvider,
	useTransclusionRender,
} from "./plugins/transclusion-render-context";
// Rich editor plugins extracted from `apps/notes/src/editor/` so every
// app's editor surface gets the same capabilities (unify stages 2+).
export { CodeBlockPlugin } from "./plugins/code-block-plugin";
export { CodeBlockToolbarPlugin } from "./plugins/code-block-toolbar-plugin";
export {
	CODE_HIGHLIGHT_ROOT_CLASS,
	CodeHighlightPlugin,
} from "./plugins/code-highlight-plugin";
export {
	LINE_NUMBERS_ROOT_CLASS,
	CodeLineNumbersPlugin,
} from "./plugins/code-line-numbers-plugin";
export { FindPlugin } from "./plugins/find-plugin";
export {
	type LexicalMatch,
	createLexicalSearchProvider,
} from "./plugins/find-provider";
export { MarqueePlugin } from "./plugins/marquee-plugin";
export {
	InlineToolbarPlugin,
	type InlineToolbarPluginProps,
} from "./plugins/inline-toolbar-plugin";
export { FormatChordsPlugin } from "./plugins/format-chords-plugin";
export {
	EmojiTypeaheadPlugin,
	OPEN_EMOJI_BROWSE_COMMAND,
} from "./plugins/emoji-typeahead-plugin";
export { EmptyParagraphHintPlugin } from "./plugins/empty-paragraph-hint-plugin";
export {
	type BlankRecoveryPluginProps,
	BlankRecoveryPlugin,
} from "./plugins/blank-recovery-plugin";
export { EditorHandlePlugin } from "./plugins/editor-handle-plugin";
export {
	MENTION_NODE_TYPE,
	type SerializedMentionNode,
	$createMentionNode,
	$isMentionNode,
	MentionNode,
} from "./nodes/mention-node";
export {
	DATE_MENTION_NODE_TYPE,
	type SerializedDateMentionNode,
	$createDateMentionNode,
	$isDateMentionNode,
	DateMentionNode,
} from "./nodes/date-mention-node";
export {
	type MentionTypeaheadPluginProps,
	MentionTypeaheadPlugin,
} from "./plugins/mention-typeahead-plugin";
export {
	type MentionTrigger,
	type EntityFilterResult,
	detectMentionTrigger,
	entityDisplayName,
	filterEntities,
} from "./plugins/mention-ops";
export {
	TRANSCLUSION_NODE_TYPE,
	TRANSCLUSION_DOM_FLAG,
	TRANSCLUSION_DOM_FLAG_VALUE,
	type SerializedTransclusionNode,
	$createTransclusionNode,
	$isTransclusionNode,
	TransclusionNode,
	TransclusionView,
} from "./nodes/transclusion-node";
export {
	INLINE_TRANSCLUSION_NODE_TYPE,
	INLINE_TRANSCLUSION_DOM_FLAG,
	INLINE_TRANSCLUSION_DOM_FLAG_VALUE,
	type SerializedInlineTransclusionNode,
	$createInlineTransclusionNode,
	$isInlineTransclusionNode,
	InlineTransclusionNode,
	InlineTransclusionView,
} from "./nodes/inline-transclusion-node";
export {
	type TransclusionTrigger,
	type TransclusionVerdict,
	TransclusionRejectReason,
	TransclusionRenderDecision,
	MAX_TRANSCLUSION_DEPTH,
	detectTransclusionTrigger,
	resolveTransclusionTarget,
	decideTransclusionRender,
} from "./plugins/transclusion-ops";
export {
	type TransclusionTypeaheadPluginProps,
	type TransclusionInsertion,
	TransclusionTypeaheadPlugin,
	applyTransclusionInsertion,
} from "./plugins/transclusion-typeahead-plugin";
export {
	BOOKMARK_NODE_TYPE,
	type SerializedBookmarkNode,
	$createBookmarkNode,
	$isBookmarkNode,
	BookmarkNode,
} from "./nodes/bookmark-node";
export {
	WEB_EMBED_NODE_TYPE,
	type SerializedWebEmbedNode,
	$createWebEmbedNode,
	$isWebEmbedNode,
	WebEmbedNode,
} from "./nodes/web-embed-node";
export {
	INSERT_BOOKMARK_COMMAND,
	INSERT_EMBED_COMMAND,
	EmbedPlugin,
} from "./plugins/embed-plugin";
export {
	EmbedKind,
	type UrlClassification,
	classifyUrl,
	faviconUrl,
	isLoneUrl,
	parseHttpUrl,
} from "./plugins/embed-providers";

export {
	$createCalloutNode,
	$isCalloutNode,
	CALLOUT_NODE_TYPE,
	CalloutNode,
	type SerializedCalloutNode,
} from "./nodes/callout-node";
export {
	$createColumnNode,
	$createColumnsNode,
	$isColumnNode,
	$isColumnsNode,
	COLUMN_NODE_TYPE,
	COLUMNS_NODE_TYPE,
	ColumnNode,
	ColumnsNode,
	type SerializedColumnNode,
	type SerializedColumnsNode,
} from "./nodes/columns-node";
export {
	$createTitleNode,
	$isTitleNode,
	TITLE_NODE_TYPE,
	TitleNode,
	type SerializedTitleNode,
} from "./nodes/title-node";
export {
	$createToggleNode,
	$isToggleNode,
	TOGGLE_ID_ATTR,
	TOGGLE_NODE_TYPE,
	ToggleNode,
	type SerializedToggleNode,
} from "./nodes/toggle-node";
export {
	type BrainstormEditorConfigOptions,
	type BrainstormInitialConfig,
	DEFAULT_EDITOR_NAMESPACE,
	createEditorConfig,
} from "./config";
export {
	type OffscreenGateProps,
	type OffscreenGateProviderProps,
	type OffscreenObserver,
	OffscreenGate,
	OffscreenGateProvider,
	createOffscreenObserver,
} from "./decorator-unmount";
export { type BrainstormEditorProps, BrainstormEditor } from "./editor";
export {
	type CompactEditorHandle,
	type CompactEditorPayload,
	type CompactEditorProps,
	CompactEditor,
} from "./compact-editor";
export {
	type MentionComposerHandle,
	type MentionComposerPluginProps,
	MentionComposerPlugin,
} from "./mention-composer-plugin";
export {
	PEER_COLORS,
	PEER_NAME_MAX_LEN,
	localPresence,
	localPresenceName,
	peerColor,
	sanitizePeerName,
} from "./peer-presence";
export { createBrainstormHeadlessEditor } from "./headless";
export {
	type AddCommentInput,
	type CommentEntitiesService,
	type CommentEntity,
	type CommentsAdapter,
	type EntityCommentsAdapterOptions,
	commentToEntityProperties,
	createEntityCommentsAdapter,
	entityToComment,
} from "./comments/comments-adapter";
export {
	type CommentsContextValue,
	type CommentsProviderProps,
	CommentsProvider,
	useComments,
} from "./comments/comments-context";
export {
	type CommentsFocusRequest,
	type CommentsPanelProps,
	CommentsPanel,
	DOCUMENT_BLOCK_ID,
} from "./comments/comments-panel";
export {
	CommentsRightPanel,
	RightPanelTab,
	RightPanelTabs,
} from "./comments/right-panel-tabs";
export {
	type EntityCommentsPanelProps,
	type EntityCommentsServices,
	type EntityMutationServices,
	EntityCommentsPanel,
	useCommentMentionHost,
	useCommentMutations,
} from "./comments/entity-comments-panel";
export {
	$applySuggestionToBlock,
	applySuggestionInEditor,
} from "./comments/suggestion-apply";
export {
	type SelectionCommentAnchor,
	$commentAnchorFromSelection,
} from "./comments/selection-anchor";
export { openCommentBlockIds } from "./comments/comment-blocks";
export {
	type CommentMutationsService,
	commentEntitiesFromSnapshot,
	useEntityCommentsAdapter,
	useOpenCommentBlockIds,
} from "./comments/use-entity-comments-adapter";
export {
	COMMENT_BLOCK_ATTR,
	CommentHighlightPlugin,
} from "./plugins/comment-highlight-plugin";
export {
	type EditorI18nKey,
	type EditorManifest,
	type EditorT,
	type EditorI18nProviderProps,
	EDITOR_I18N_DEFAULTS,
	EditorI18nProvider,
	createEditorT,
	useEditorT,
} from "./i18n";
export {
	type HeightCache,
	BlockKind,
	ESTIMATED_CODE_LINE_HEIGHT_PX,
	ESTIMATED_EMBED_PX,
	ESTIMATED_HEADING_H1_PX,
	ESTIMATED_HEADING_H2_PX,
	ESTIMATED_HEADING_H3_PX,
	ESTIMATED_LINE_HEIGHT_PX,
	ESTIMATED_PARAGRAPH_CHARS_PER_LINE,
	createHeightCache,
} from "./height-cache";
export {
	type ImageWidth,
	type SerializedImageNode,
	$createImageNode,
	$isImageNode,
	ImageNode,
} from "./image-node";
export {
	type LargeDocProfile,
	type SampleStats,
	LARGE_DOC_PROFILES,
	seedLargeDoc,
	timeSamples,
} from "./large-doc-fixture";
export { DEFAULT_SNIPPET_LENGTH, clipPlainText } from "./clip-plain-text";
export { type DenormalizedBody, denormalizeBody } from "./denormalize-body";
export { extractPlainText } from "./extract-text";
export { extractTitle } from "./extract-title";
export { createLocalProvider } from "./local-provider";
export { BASELINE_NODES } from "./nodes";
export { type PlantStateOptions, plantSerializedStateIntoDoc } from "./plant-state";
export {
	SEED_STANDIN_NODES,
	SeedHorizontalRuleNode,
	SeedMentionNode,
	SeedTitleNode,
	type SerializedSeedMentionNode,
} from "./seed-nodes";
export {
	type EditorPreviewOptions,
	type EditorPreviewProps,
	type SerializedEditorStateLike,
	EditorPreview,
	TextFormat,
	renderEditorState,
} from "./preview";
export { serializedStateToHtml } from "./serialize-html";
export { serializedStateToMarkdown } from "./serialize-markdown";
export { baselineTheme, mergeTheme, richTextTheme } from "./theme";
export {
	blockParentOf,
	getAllBlocks,
	isTopLevelBlock,
	topLevelKeyOf,
} from "./top-level-block";
export {
	type VirtualizePluginProps,
	VirtualizePlugin,
	mountVirtualization,
} from "./virtualize-plugin";

export {
	ColorTarget,
	SwatchColor,
	SWATCH_COLORS,
	swatchCssValue,
	swatchFromCss,
	applySwatch,
	readActiveSwatch,
	applySwatchToBlocks,
	mergeStyleProp,
} from "./text-color";
