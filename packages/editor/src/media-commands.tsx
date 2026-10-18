/**
 * The shared media block-command catalogue — the `/image` `/video`
 * `/audio` `/file` slash commands every full-editor surface gets. Each
 * opens a native file picker, uploads through the host uploader
 * (`getEditorHost().uploadFile`, wired per app at boot), and inserts the
 * matching media block at the caret.
 *
 * Built from an `EditorT` (not hard-coded strings) so a host locale flips
 * the labels via `<BrainstormEditor i18nOverrides>`, mirroring
 * `createStandardBlockCommands`.
 */

import {
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$insertNodes,
	$isParagraphNode,
	$isRangeSelection,
	$setSelection,
	type LexicalEditor,
	type LexicalNode,
	type NodeKey,
} from "lexical";
import { type BlockCommand, CommandCategory } from "./block-command";
import type { EditorT } from "./i18n";
import { AudioIcon, FileIcon, ImageIcon, VideoIcon } from "./icons";
import { MediaFileKind, resolveBinarySrc, resolveImageSrc, tryUploadFile } from "./media-upload";
import { $createAudioBlockNode } from "./nodes/audio-block-node";
import { $createFileBlockNode } from "./nodes/file-block-node";
import { $createImageBlockNode } from "./nodes/image-block-node";
import { $createInlineImageNode } from "./nodes/inline-image-node";
import { $createVideoBlockNode } from "./nodes/video-block-node";
import { VaultMediaFilter, isImageMime } from "./vault-media";
import { type VaultMediaPick, openVaultMediaPicker } from "./vault-media-picker";

/** Slash-menu ids for the media commands, in display order — so a host
 *  that curates its slash palette can include them explicitly. */
export const MEDIA_COMMAND_IDS: readonly string[] = [
	"block.media.image",
	"block.media.image.vault",
	"block.media.image.inline",
	"block.media.video",
	"block.media.audio",
	"block.media.file",
	"block.media.file.vault",
];

export function createMediaBlockCommands(t: EditorT): readonly BlockCommand[] {
	return [
		{
			id: "block.media.image",
			category: CommandCategory.Media,
			label: t("editor.media.image"),
			description: t("editor.media.image.description"),
			icon: <ImageIcon />,
			keywords: ["image", "photo", "picture", "img", "media"],
			run: ({ editor }) => {
				insertImageViaPicker(editor);
			},
		},
		{
			id: "block.media.image.vault",
			category: CommandCategory.Media,
			label: t("editor.media.imageFromVault"),
			description: t("editor.media.imageFromVault.description"),
			icon: <ImageIcon />,
			keywords: ["image", "vault", "existing", "library", "reuse", "photo", "media"],
			run: ({ editor }) => {
				setTimeout(
					() =>
						openVaultMediaPicker(editor, VaultMediaFilter.Image, t, (pick) =>
							insertVaultMedia(editor, pick),
						),
					0,
				);
			},
		},
		{
			id: "block.media.image.inline",
			category: CommandCategory.Media,
			label: t("editor.media.inlineImage"),
			description: t("editor.media.inlineImage.description"),
			icon: <ImageIcon />,
			keywords: ["inline", "image", "icon", "emoji", "logo", "vault", "media"],
			run: ({ editor }) => {
				setTimeout(
					() =>
						openVaultMediaPicker(editor, VaultMediaFilter.Image, t, (pick) =>
							insertInlineImage(editor, pick),
						),
					0,
				);
			},
		},
		{
			id: "block.media.video",
			category: CommandCategory.Media,
			label: t("editor.media.video"),
			description: t("editor.media.video.description"),
			icon: <VideoIcon />,
			keywords: ["video", "movie", "clip", "media"],
			run: ({ editor }) => {
				insertVideoViaPicker(editor);
			},
		},
		{
			id: "block.media.audio",
			category: CommandCategory.Media,
			label: t("editor.media.audio"),
			description: t("editor.media.audio.description"),
			icon: <AudioIcon />,
			keywords: ["audio", "sound", "music", "voice", "recording", "media"],
			run: ({ editor }) => {
				pickFile(editor, "audio/*", (e, file) => insertBinaryBlock(e, file, MediaFileKind.Audio));
			},
		},
		{
			id: "block.media.file",
			category: CommandCategory.Media,
			label: t("editor.media.file"),
			description: t("editor.media.file.description"),
			icon: <FileIcon />,
			keywords: ["file", "attachment", "document", "download", "upload"],
			run: ({ editor }) => {
				pickFile(editor, "", (e, file) => insertBinaryBlock(e, file, MediaFileKind.File));
			},
		},
		{
			id: "block.media.file.vault",
			category: CommandCategory.Media,
			label: t("editor.media.fileFromVault"),
			description: t("editor.media.fileFromVault.description"),
			icon: <FileIcon />,
			keywords: ["file", "vault", "existing", "library", "attachment", "reuse"],
			run: ({ editor }) => {
				setTimeout(
					() =>
						openVaultMediaPicker(editor, VaultMediaFilter.Any, t, (pick) =>
							insertVaultMedia(editor, pick),
						),
					0,
				);
			},
		},
	];
}

function insertImageViaPicker(editor: LexicalEditor): void {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml";
	input.addEventListener("change", () => {
		const file = input.files?.[0];
		if (!file) return;
		void insertImageFile(editor, file);
	});
	input.click();
}

async function insertImageFile(editor: LexicalEditor, file: File): Promise<void> {
	const src = await resolveImageSrc(file);
	if (!src) return;
	editor.update(() => $placeMediaBlock($createImageBlockNode(src, file.name)), { discrete: true });
}

function insertVideoViaPicker(editor: LexicalEditor): void {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "video/mp4,video/webm,video/quicktime";
	input.addEventListener("change", () => {
		const file = input.files?.[0];
		if (!file) return;
		void insertVideoFile(editor, file);
	});
	input.click();
}

async function insertVideoFile(editor: LexicalEditor, file: File): Promise<void> {
	const url = await tryUploadFile(file);
	if (!url) {
		console.warn(
			"[editor/video] host uploadFile unavailable — videos are upload-only (no data-URL fallback because they're too large).",
		);
		return;
	}
	editor.update(() => $placeMediaBlock($createVideoBlockNode(url, file.type)), { discrete: true });
}

function pickFile(
	editor: LexicalEditor,
	accept: string,
	onFile: (editor: LexicalEditor, file: File) => void,
): void {
	const input = document.createElement("input");
	input.type = "file";
	if (accept) input.accept = accept;
	input.addEventListener("change", () => {
		const file = input.files?.[0];
		if (file) onFile(editor, file);
	});
	input.click();
}

async function insertBinaryBlock(
	editor: LexicalEditor,
	file: File,
	kind: MediaFileKind.Audio | MediaFileKind.File,
): Promise<void> {
	const src = await resolveBinarySrc(file);
	if (!src) return;
	editor.update(
		() =>
			$placeMediaBlock(
				kind === MediaFileKind.Audio
					? $createAudioBlockNode(src, file.type, file.name)
					: $createFileBlockNode(src, file.name, file.size, file.type),
			),
		{ discrete: true },
	);
}

/** Put a media block where the user asked for it: in place of the caret's
 *  block (the slash command's emptied paragraph), or after `blockKey` when
 *  that block still holds content, else at the end of the document. */
export function $placeMediaBlock(block: LexicalNode, blockKey: NodeKey | null = null): void {
	const target = blockKey
		? $getNodeByKey(blockKey)
		: (() => {
				const sel = $getSelection();
				return $isRangeSelection(sel) ? sel.anchor.getNode().getTopLevelElement() : null;
			})();
	if (target && blockKey && !($isParagraphNode(target) && target.getTextContentSize() === 0)) {
		target.insertAfter(block);
		return;
	}
	if (target) {
		target.replace(block);
		return;
	}
	$getRoot().append(block);
}

function insertVaultMedia(editor: LexicalEditor, { media, blockKey }: VaultMediaPick): void {
	editor.update(
		() => {
			const block = isImageMime(media.mime)
				? $createImageBlockNode(media.url, media.name)
				: media.mime.startsWith("video/")
					? $createVideoBlockNode(media.url, media.mime)
					: media.mime.startsWith("audio/")
						? $createAudioBlockNode(media.url, media.mime, media.name)
						: $createFileBlockNode(media.url, media.name, media.size ?? 0, media.mime);
			$placeMediaBlock(block, blockKey);
		},
		{ discrete: true },
	);
}

function insertInlineImage(editor: LexicalEditor, { media, selection }: VaultMediaPick): void {
	editor.update(
		() => {
			const restored = selection?.clone() ?? null;
			if (
				$isRangeSelection(restored) &&
				$getNodeByKey(restored.anchor.key) &&
				$getNodeByKey(restored.focus.key)
			) {
				$setSelection(restored);
			}
			if (!$isRangeSelection($getSelection())) $getRoot().selectEnd();
			$insertNodes([$createInlineImageNode(media.url, media.name)]);
		},
		{ discrete: true },
	);
}
