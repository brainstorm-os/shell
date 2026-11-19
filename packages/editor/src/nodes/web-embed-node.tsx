/**
 * WebEmbedNode — the one node behind every external embed provider
 * (catalogue in `plugins/embed-providers.ts`). It persists the URL the
 * user gave; what actually renders is re-derived from that URL by
 * `classifyEmbed` on every render, so neither a hand-edited document nor a
 * CRDT peer writing `__embedUrl` directly can point the iframe anywhere
 * the allowlist would not.
 *
 * Nothing loads on render: the block is a local click-to-load facade
 * until the user asks for the provider's content.
 */

import {
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import { type JSX, type ReactNode, useMemo, useState } from "react";
import { useEditorT } from "../i18n";
import { AudioIcon, EmbedIcon, GlobeIcon, MapPinIcon, PlayIcon } from "../icons";
import {
	EMBED_PROVIDERS,
	EmbedAspect,
	EmbedKind,
	classifyEmbed,
	safeExternalHref,
} from "../plugins/embed-providers";

export const WEB_EMBED_NODE_TYPE = "web-embed";
const WEB_EMBED_NODE_VERSION = 1 as const;

const KNOWN_KINDS = new Set<string>(Object.values(EmbedKind));

function coerceKind(raw: unknown): EmbedKind {
	return typeof raw === "string" && KNOWN_KINDS.has(raw) ? (raw as EmbedKind) : EmbedKind.Bookmark;
}

// A serialized node only keeps its provider when a fresh classification of
// its `url` agrees with the declared kind; otherwise it imports as a link.
function reclassifyEmbed(
	rawUrl: unknown,
	rawKind: unknown,
): { embedUrl: string | null; kind: EmbedKind } {
	const match = typeof rawUrl === "string" ? classifyEmbed(rawUrl) : null;
	if (!match || coerceKind(rawKind) !== match.kind) {
		return { embedUrl: null, kind: EmbedKind.Bookmark };
	}
	return { embedUrl: match.embedUrl, kind: match.kind };
}

export type SerializedWebEmbedNode = SerializedLexicalNode & {
	type: typeof WEB_EMBED_NODE_TYPE;
	version: typeof WEB_EMBED_NODE_VERSION;
	url: string;
	embedUrl: string | null;
	kind: EmbedKind;
};

export class WebEmbedNode extends DecoratorNode<JSX.Element> {
	__url: string;
	__embedUrl: string | null;
	__kind: EmbedKind;

	static override getType(): string {
		return WEB_EMBED_NODE_TYPE;
	}

	static override clone(node: WebEmbedNode): WebEmbedNode {
		return new WebEmbedNode(node.__url, node.__embedUrl, node.__kind, node.__key);
	}

	constructor(url: string, embedUrl: string | null, kind: EmbedKind, key?: NodeKey) {
		super(key);
		this.__url = url;
		this.__embedUrl = embedUrl;
		this.__kind = kind;
	}

	static override importJSON(s: SerializedWebEmbedNode): WebEmbedNode {
		const { embedUrl, kind } = reclassifyEmbed(s.url, s.kind);
		return new WebEmbedNode(typeof s.url === "string" ? s.url : "", embedUrl, kind);
	}

	override exportJSON(): SerializedWebEmbedNode {
		return {
			type: WEB_EMBED_NODE_TYPE,
			version: WEB_EMBED_NODE_VERSION,
			url: this.__url,
			embedUrl: this.__embedUrl,
			kind: this.__kind,
		};
	}

	override createDOM(_config: EditorConfig): HTMLElement {
		const el = document.createElement("div");
		el.className = "notes__embed-host";
		return el;
	}

	override updateDOM(): false {
		return false;
	}

	override decorate(): JSX.Element {
		return <WebEmbedView url={this.__url} />;
	}

	override isInline(): false {
		return false;
	}
}

const ASPECT_ICON: Readonly<Record<EmbedAspect, () => ReactNode>> = {
	[EmbedAspect.Video]: PlayIcon,
	[EmbedAspect.Map]: MapPinIcon,
	[EmbedAspect.Canvas]: EmbedIcon,
	[EmbedAspect.Audio]: AudioIcon,
	[EmbedAspect.AudioList]: AudioIcon,
};

export function WebEmbedView({ url }: { url: string }): JSX.Element {
	const t = useEditorT();
	const match = useMemo(() => classifyEmbed(url), [url]);
	const [loaded, setLoaded] = useState(false);

	if (!match) {
		const href = safeExternalHref(url);
		return (
			<div className="notes__embed notes__embed--link" data-kind={EmbedKind.Bookmark}>
				<GlobeIcon />
				{href ? (
					<a
						href={href}
						target="_blank"
						rel="noopener noreferrer nofollow"
						className="notes__embed-link"
					>
						{url}
					</a>
				) : (
					<span className="notes__embed-link">{url}</span>
				)}
			</div>
		);
	}

	const provider = EMBED_PROVIDERS[match.kind];
	const name = t(provider.labelKey);
	const frameHost = new URL(provider.frameOrigin).host;
	const Glyph = ASPECT_ICON[match.aspect];

	if (!loaded) {
		return (
			<div className="notes__embed" data-kind={match.kind} data-aspect={match.aspect}>
				<button
					type="button"
					className="notes__embed-facade"
					onClick={() => setLoaded(true)}
					aria-label={t("editor.embed.facade.load", { provider: name })}
				>
					<span className="notes__embed-facade-glyph" aria-hidden="true">
						<Glyph />
					</span>
					<span className="notes__embed-facade-name">{name}</span>
					<span className="notes__embed-facade-url">{url}</span>
					<span className="notes__embed-facade-cta">
						{t("editor.embed.facade.load", { provider: name })}
					</span>
					<span className="notes__embed-facade-notice">
						{t("editor.embed.facade.notice", { host: frameHost })}
					</span>
				</button>
			</div>
		);
	}

	// `credentialless` is not in React's attribute table; a lower-case string
	// attribute passes straight through to the DOM.
	const partition = provider.credentialless ? { credentialless: "" } : {};
	return (
		<div className="notes__embed" data-kind={match.kind} data-aspect={match.aspect} data-loaded="">
			<iframe
				className="notes__embed-frame"
				// iframe-src-exempt — the one sanctioned remote-origin frame: src is
				// rebuilt by classifyEmbed on an allowlisted provider origin (block-frame
				// is srcdoc-only and does not cover third-party players).
				src={match.embedUrl}
				title={t("editor.embed.frameTitle", { provider: name })}
				referrerPolicy="no-referrer"
				sandbox={provider.sandbox}
				allow={provider.allow}
				{...partition}
			/>
		</div>
	);
}

export function $createWebEmbedNode(
	url: string,
	embedUrl: string | null,
	kind: EmbedKind,
): WebEmbedNode {
	return new WebEmbedNode(url, embedUrl, kind);
}

export function $isWebEmbedNode(node: LexicalNode | null | undefined): node is WebEmbedNode {
	return node instanceof WebEmbedNode;
}
