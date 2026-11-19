/**
 * BookmarkNode — a link rendered as a rich card (favicon + title +
 * description + host). No metadata-fetch service is required: the
 * favicon is loaded best-effort straight from the origin and falls back
 * to a glyph `onerror`; title/description default to the host/URL and
 * are user-editable inline. A future shell-brokered unfurl only has to
 * fill the same optional fields — the node shape already carries them.
 *
 * The card is a real `<a target="_blank" rel="noopener">`, matching how
 * plain external links open (the shell owns external navigation), so no
 * new renderer network surface is introduced.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$getNodeByKey,
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import { type JSX, useCallback, useState } from "react";
import { type EditorI18nKey, useEditorT } from "../i18n";
import { GlobeIcon } from "../icons";
import {
	EMBED_PROVIDERS,
	EmbedKind,
	type EmbedProviderKind,
	classifyEmbed,
	faviconUrl,
	parseHttpUrl,
	safeExternalHref,
} from "../plugins/embed-providers";
import { $createWebEmbedNode } from "./web-embed-node";

export const BOOKMARK_NODE_TYPE = "bookmark";
const BOOKMARK_NODE_VERSION = 1 as const;

export type SerializedBookmarkNode = SerializedLexicalNode & {
	type: typeof BOOKMARK_NODE_TYPE;
	version: typeof BOOKMARK_NODE_VERSION;
	url: string;
	title: string;
	description: string;
	/** Set by a provider slash row (`/youtube`, `/maps`): the URL prompt is
	 *  that provider's, and a link the allowlist accepts becomes an embed
	 *  on save instead of a card. Absent on an ordinary bookmark. */
	embedHint?: EmbedProviderKind;
};

const HINT_PLACEHOLDER: Partial<Record<EmbedProviderKind, EditorI18nKey>> = {
	[EmbedKind.YouTube]: "editor.bookmark.urlPlaceholder.youtube",
	[EmbedKind.GoogleMaps]: "editor.bookmark.urlPlaceholder.googleMaps",
};

function coerceHint(raw: unknown): EmbedProviderKind | null {
	return typeof raw === "string" && Object.hasOwn(EMBED_PROVIDERS, raw)
		? (raw as EmbedProviderKind)
		: null;
}

export class BookmarkNode extends DecoratorNode<JSX.Element> {
	__url: string;
	__title: string;
	__description: string;
	__embedHint: EmbedProviderKind | null;

	static override getType(): string {
		return BOOKMARK_NODE_TYPE;
	}

	static override clone(node: BookmarkNode): BookmarkNode {
		return new BookmarkNode(
			node.__url,
			node.__title,
			node.__description,
			node.__embedHint,
			node.__key,
		);
	}

	constructor(
		url: string,
		title = "",
		description = "",
		embedHint: EmbedProviderKind | null = null,
		key?: NodeKey,
	) {
		super(key);
		this.__url = url;
		this.__title = title;
		this.__description = description;
		this.__embedHint = embedHint;
	}

	static override importJSON(s: SerializedBookmarkNode): BookmarkNode {
		return new BookmarkNode(s.url, s.title ?? "", s.description ?? "", coerceHint(s.embedHint));
	}

	override exportJSON(): SerializedBookmarkNode {
		return {
			type: BOOKMARK_NODE_TYPE,
			version: BOOKMARK_NODE_VERSION,
			url: this.__url,
			title: this.__title,
			description: this.__description,
			...(this.__embedHint ? { embedHint: this.__embedHint } : {}),
		};
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		el.className = "notes__bookmark-host";
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	getUrl(): string {
		return this.__url;
	}

	setUrl(url: string): void {
		this.getWritable().__url = url;
	}

	setMeta(title: string, description: string): void {
		const w = this.getWritable();
		w.__title = title;
		w.__description = description;
	}

	override decorate(): JSX.Element {
		return (
			<BookmarkView
				nodeKey={this.getKey()}
				url={this.__url}
				title={this.__title}
				description={this.__description}
				embedHint={coerceHint(this.__embedHint)}
			/>
		);
	}

	override isInline(): false {
		return false;
	}
}

function BookmarkView({
	nodeKey,
	url,
	title,
	description,
	embedHint,
}: {
	nodeKey: NodeKey;
	url: string;
	title: string;
	description: string;
	embedHint: EmbedProviderKind | null;
}) {
	const t = useEditorT();
	const host = parseHttpUrl(url)?.hostname.replace(/^www\./, "") ?? url;
	const favicon = faviconUrl(url);
	const [editor] = useLexicalComposerContext();
	// A freshly slash-inserted bookmark has no URL yet — open straight
	// into the editor so the URL field is the first thing focused.
	const [editing, setEditing] = useState(url.trim().length === 0);
	const [draftUrl, setDraftUrl] = useState(url);
	const [draftTitle, setDraftTitle] = useState(title);
	const [draftDesc, setDraftDesc] = useState(description);
	const embeddable = classifyEmbed(url);
	const href = safeExternalHref(url);
	const urlPlaceholder = t(
		(embedHint ? HINT_PLACEHOLDER[embedHint] : undefined) ?? "editor.bookmark.urlPlaceholder",
	);

	const commit = useCallback(() => {
		const nextUrl = draftUrl.trim();
		const hinted = embedHint ? classifyEmbed(nextUrl) : null;
		editor.update(() => {
			const node = $getNodeByKey(nodeKey);
			if (!$isBookmarkNode(node)) return;
			if (hinted) {
				node.replace($createWebEmbedNode(nextUrl, hinted.embedUrl, hinted.kind));
				return;
			}
			node.setUrl(nextUrl);
			node.setMeta(draftTitle.trim(), draftDesc.trim());
		});
		setEditing(false);
	}, [editor, nodeKey, draftUrl, draftTitle, draftDesc, embedHint]);

	const convertToEmbed = useCallback(() => {
		if (!embeddable) return;
		editor.update(() => {
			const node = $getNodeByKey(nodeKey);
			if ($isBookmarkNode(node)) {
				node.replace($createWebEmbedNode(url, embeddable.embedUrl, embeddable.kind));
			}
		});
	}, [editor, nodeKey, url, embeddable]);

	if (editing) {
		return (
			<div className="notes__bookmark notes__bookmark--editing">
				<input
					className="notes__bookmark-input"
					type="url"
					value={draftUrl}
					placeholder={urlPlaceholder}
					aria-label={urlPlaceholder}
					onChange={(e) => setDraftUrl(e.target.value)}
				/>
				{embedHint ? null : (
					<>
						<input
							className="notes__bookmark-input"
							value={draftTitle}
							placeholder={t("editor.bookmark.titlePlaceholder")}
							aria-label={t("editor.bookmark.titlePlaceholder")}
							onChange={(e) => setDraftTitle(e.target.value)}
						/>
						<textarea
							className="notes__bookmark-input notes__bookmark-input--desc"
							value={draftDesc}
							placeholder={t("editor.bookmark.descPlaceholder")}
							aria-label={t("editor.bookmark.descPlaceholder")}
							onChange={(e) => setDraftDesc(e.target.value)}
						/>
					</>
				)}
				<div className="notes__bookmark-actions">
					<button
						type="button"
						className="notes__bookmark-btn notes__bookmark-btn--primary"
						onClick={commit}
					>
						{t("editor.bookmark.save")}
					</button>
					<button type="button" className="notes__bookmark-btn" onClick={() => setEditing(false)}>
						{t("editor.bookmark.cancel")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="notes__bookmark">
			<a
				className="notes__bookmark-link"
				{...(href ? { href } : {})}
				target="_blank"
				rel="noopener noreferrer nofollow"
			>
				<span className="notes__bookmark-text">
					<span className="notes__bookmark-title">{title.trim() || host}</span>
					{description.trim() && <span className="notes__bookmark-desc">{description}</span>}
					<span className="notes__bookmark-host">
						{favicon ? (
							<img
								className="notes__bookmark-favicon"
								src={favicon}
								alt=""
								width={16}
								height={16}
								onError={(e) => {
									e.currentTarget.style.display = "none";
									e.currentTarget.nextElementSibling?.removeAttribute("hidden");
								}}
							/>
						) : null}
						<span className="notes__bookmark-favicon-fallback" hidden aria-hidden="true">
							<GlobeIcon />
						</span>
						{host}
					</span>
				</span>
			</a>
			<div className="notes__bookmark-tools">
				{embeddable && (
					<button
						type="button"
						className="notes__bookmark-edit"
						aria-label={t("editor.bookmark.convertEmbed")}
						title={t("editor.bookmark.convertEmbed")}
						onClick={convertToEmbed}
					>
						{t("editor.bookmark.convertEmbed")}
					</button>
				)}
				<button
					type="button"
					className="notes__bookmark-edit"
					aria-label={t("editor.bookmark.edit")}
					title={t("editor.bookmark.edit")}
					onClick={() => {
						setDraftUrl(url);
						setDraftTitle(title);
						setDraftDesc(description);
						setEditing(true);
					}}
				>
					{t("editor.bookmark.edit")}
				</button>
			</div>
		</div>
	);
}

export function $createBookmarkNode(
	url: string,
	title = "",
	description = "",
	embedHint: EmbedProviderKind | null = null,
): BookmarkNode {
	return new BookmarkNode(url, title, description, embedHint);
}

export function $isBookmarkNode(node: LexicalNode | null | undefined): node is BookmarkNode {
	return node instanceof BookmarkNode;
}
