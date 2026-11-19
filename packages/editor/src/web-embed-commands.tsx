/**
 * The shared external-embed slash rows (B11.20b): the generic bookmark /
 * web-embed command plus a first-class row per v1 provider. Every row takes
 * the same path — an empty bookmark block opens on its URL prompt — and a
 * provider row only pre-configures that prompt and turns an allowlisted link
 * into an embed on save. Tier-2 providers have no row of their own: they are
 * reachable through the generic row's keywords until use earns them one.
 */

import { $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import { type BlockCommand, CommandCategory } from "./block-command";
import type { EditorT } from "./i18n";
import { BookmarkIcon, MapPinIcon, PlayIcon } from "./icons";
import { $createBookmarkNode } from "./nodes/bookmark-node";
import { EmbedKind, type EmbedProviderKind } from "./plugins/embed-providers";

export const WEB_EMBED_COMMAND_IDS = [
	"block.embed.bookmark",
	"block.embed.youtube",
	"block.embed.maps",
] as const;

function insertUrlPrompt(editor: LexicalEditor, hint: EmbedProviderKind | null): void {
	editor.update(() => {
		const sel = $getSelection();
		if (!$isRangeSelection(sel)) return;
		const block = sel.anchor.getNode().getTopLevelElement();
		if (block) block.replace($createBookmarkNode("", "", "", hint));
	});
}

export function createWebEmbedCommands(t: EditorT): readonly BlockCommand[] {
	return [
		{
			id: "block.embed.bookmark",
			category: CommandCategory.Embed,
			label: t("editor.block.webEmbed"),
			description: t("editor.block.webEmbed.description"),
			icon: <BookmarkIcon />,
			keywords: [
				"bookmark",
				"link",
				"url",
				"web",
				"embed",
				"preview",
				"vimeo",
				"loom",
				"figma",
				"codesandbox",
				"openstreetmap",
				"osm",
				"spotify",
				"soundcloud",
				"codepen",
				"miro",
				"twitter",
				"tweet",
				"gist",
			],
			run: ({ editor }) => insertUrlPrompt(editor, null),
		},
		{
			id: "block.embed.youtube",
			category: CommandCategory.Embed,
			label: t("editor.block.youtube"),
			description: t("editor.block.youtube.description"),
			icon: <PlayIcon />,
			keywords: ["youtube", "video", "embed", "watch"],
			run: ({ editor }) => insertUrlPrompt(editor, EmbedKind.YouTube),
		},
		{
			id: "block.embed.maps",
			category: CommandCategory.Embed,
			label: t("editor.block.googleMaps"),
			description: t("editor.block.googleMaps.description"),
			icon: <MapPinIcon />,
			keywords: ["maps", "map", "google", "place", "location", "address", "embed"],
			run: ({ editor }) => insertUrlPrompt(editor, EmbedKind.GoogleMaps),
		},
	];
}
