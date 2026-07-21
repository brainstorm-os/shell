/**
 * EmbedPlugin — turns pasted links into rich blocks.
 *
 *   - Pasting a *lone* URL onto an empty line is intercepted: instead of
 *     dropping raw text we offer a chooser (Bookmark / Embed / Plain
 *     link / Dismiss). Embed is offered only for allowlisted providers.
 *   - INSERT_BOOKMARK_COMMAND / INSERT_EMBED_COMMAND give the same
 *     conversions a programmatic entry point.
 *
 * Nothing here fetches the network: embeds use the provider's own
 * embeddable URL (frozen at insert), bookmarks load a best-effort
 * favicon with a glyph fallback.
 */

import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { $createLinkNode } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
	$createTextNode,
	$getNodeByKey,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	COMMAND_PRIORITY_LOW,
	type LexicalNode,
	type NodeKey,
	PASTE_COMMAND,
	createCommand,
} from "lexical";
import { useEffect } from "react";
import { useEditorT } from "../i18n";
import { $createBookmarkNode } from "../nodes/bookmark-node";
import { $createWebEmbedNode } from "../nodes/web-embed-node";
import { EmbedKind, classifyUrl, isLoneUrl } from "./embed-providers";

export const INSERT_BOOKMARK_COMMAND = createCommand<string>("INSERT_BOOKMARK_COMMAND");
export const INSERT_EMBED_COMMAND = createCommand<string>("INSERT_EMBED_COMMAND");

export function EmbedPlugin() {
	const [editor] = useLexicalComposerContext();
	const t = useEditorT();

	useEffect(() => {
		// Open the shared fancy-menu (Bookmark / Embed / Plain link) anchored
		// under the pasted-into block. Escape / outside-click dismisses (which
		// leaves the line empty — the paste was intercepted). Deferred a
		// microtask so the menu's host render doesn't run inside the Lexical
		// command dispatch.
		function openChooser(url: string, blockKey: NodeKey, rect: DOMRect): void {
			const replaceWith = (make: () => LexicalNode): void => {
				editor.update(() => {
					const block = $getNodeByKey(blockKey);
					if (block) block.replace(make());
				});
			};
			const asBookmark = () => replaceWith(() => $createBookmarkNode(url));
			const asEmbed = () => {
				const c = classifyUrl(url);
				if (!c || !c.embedUrl || c.kind === EmbedKind.Bookmark) {
					asBookmark();
					return;
				}
				const { embedUrl, kind } = c;
				replaceWith(() => $createWebEmbedNode(url, embedUrl, kind));
			};
			const asLink = () => {
				editor.update(() => {
					const block = $getNodeByKey(blockKey);
					if (!block || !$isElementNode(block)) return;
					const link = $createLinkNode(url).append($createTextNode(url));
					block.append(link);
					link.selectEnd();
				});
			};
			const c = classifyUrl(url);
			const embeddable = Boolean(c && c.kind !== EmbedKind.Bookmark && c.embedUrl);
			const items: AnchoredMenuItem[] = [
				{ label: t("editor.embed.chooser.bookmark"), onSelect: asBookmark },
				...(embeddable ? [{ label: t("editor.embed.chooser.embed"), onSelect: asEmbed }] : []),
				{ label: t("editor.embed.chooser.link"), onSelect: asLink },
			];
			openAnchoredMenu({ x: rect.left, y: rect.bottom + 6 }, items, {
				menuLabel: t("editor.embed.chooser.region"),
			});
		}

		return mergeRegister(
			editor.registerCommand(
				PASTE_COMMAND,
				(event: ClipboardEvent) => {
					const text = event.clipboardData?.getData("text/plain") ?? "";
					if (!isLoneUrl(text)) return false;
					const selection = $getSelection();
					if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
					const anchor = selection.anchor.getNode();
					const block = anchor.getTopLevelElement();
					if (!block || !$isElementNode(block) || block.getTextContent().trim().length > 0) {
						return false;
					}
					const el = editor.getElementByKey(block.getKey());
					if (!el) return false;
					event.preventDefault();
					const url = text.trim();
					const blockKey = block.getKey();
					const rect = el.getBoundingClientRect();
					queueMicrotask(() => openChooser(url, blockKey, rect));
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				INSERT_BOOKMARK_COMMAND,
				(url) => {
					const sel = $getSelection();
					if (!$isRangeSelection(sel)) return false;
					const block = sel.anchor.getNode().getTopLevelElement();
					if (block) block.replace($createBookmarkNode(url));
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				INSERT_EMBED_COMMAND,
				(url) => {
					const sel = $getSelection();
					if (!$isRangeSelection(sel)) return false;
					const block = sel.anchor.getNode().getTopLevelElement();
					if (!block) return false;
					const c = classifyUrl(url);
					block.replace(
						c && c.kind !== EmbedKind.Bookmark && c.embedUrl
							? $createWebEmbedNode(url, c.embedUrl, c.kind)
							: $createBookmarkNode(url),
					);
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
		);
	}, [editor, t]);

	return null;
}
