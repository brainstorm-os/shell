/**
 * BlockEmbedNode — block-level reference to a vault entity, rendered as a
 * preview card (icon + title + type label). The data payload is a
 * `{blockId, entityId}` reference — never the embedded entity's content.
 *
 * Hoisted from `apps/notes` (F-070 embed parity) so every editor host that
 * mounts `<FullEditorPlugins>` (Journal / Tasks / Bookmarks / Contacts)
 * registers, renders, and navigates the same embed card Notes always had.
 * The host coupling is behind two seams the package already owns:
 *   - reactive entity titles/icons via `entity-index` (`setEntityIndexSource`),
 *   - imperative shell ops via `editor-host` (`setEditorHost`): `openEntity`
 *     for navigation, `blocks` (`forType`/`source`) for the live-block
 *     upgrade, `bp` for the mounted block's graph transport.
 * Unwired seams degrade to the chrome card — never a throw.
 *
 * v1 ships the *fallback card* path by default — an embed renders through
 * the shell-provided generic preview (`io.brainstorm.shell/entity-card/v1`).
 * When a providing app contributes a BP block for `blockId`, the same
 * persisted node lights up the live sandboxed-iframe mount; the on-disk
 * shape doesn't change.
 *
 * Persisted shape (`SerializedBlockEmbedNode`) carries `entityType` +
 * `label` snapshots alongside `entityId` so a freshly-imported document
 * paints a recognisable card even before the title/icon index for the
 * target has loaded. Mirrors the same fields MentionNode already persists —
 * keeping the shell-side body walker's edge extraction a single-pass scan.
 */

import { navModeFromEvent } from "@brainstorm/sdk";
import { BpBlockMount, type BpBlockMountHandle } from "@brainstorm/sdk/block-mount";
import {
	BlockRendererKind,
	SHELL_ENTITY_CARD_BLOCK_ID,
	useBlockRenderer,
} from "@brainstorm/sdk/block-registry";
import { BlockControlKind, collectBlockThemeVars } from "@brainstorm/sdk/block-runtime";
import {
	type DOMConversionMap,
	type DOMConversionOutput,
	type DOMExportOutput,
	DecoratorNode,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EntityIcon } from "../entity-icon";
import { type EditorT, createEditorT, useEditorT } from "../i18n";
import { getEditorHost } from "../plugins/editor-host";
import {
	entityIconsSnapshot,
	entityTitlesSnapshot,
	getEntityDisplayIcon,
	getEntityTitle,
	subscribeEntityIcons,
	subscribeEntityTitles,
} from "../plugins/entity-index";
import { dispatchOpenEntity } from "../plugins/open-entity-dispatch";

/** Non-React `t` for the imperative `exportDOM` clipboard path (English
 *  defaults — the live decorator uses the reactive `useEditorT`). */
const DEFAULT_T = createEditorT();

export const BLOCK_EMBED_NODE_TYPE = "block-embed";
const BLOCK_EMBED_NODE_VERSION = 1 as const;

/** The shell-provided generic preview block id every embed falls back to
 *  until a providing app claims the entity type. Re-exported from the SDK
 *  registry so the editor and the shell agree on one constant. */
export { SHELL_ENTITY_CARD_BLOCK_ID };

/** Sole load-bearing attribute that distinguishes a BlockEmbedNode-shaped
 *  anchor from a regular link on paste. Both `exportDOM` and `importDOM`
 *  reference this constant so a future rename stays consistent. */
export const BLOCK_EMBED_DOM_FLAG = "data-lexical-block-embed";

/** The exact value the export side stamps onto {@link BLOCK_EMBED_DOM_FLAG}.
 *  `importDOM` matches on this value (not just on attribute presence) so an
 *  attacker-shaped `data-lexical-block-embed="false"` (or empty) can't sneak
 *  through a contract-mismatched conversion. */
export const BLOCK_EMBED_DOM_FLAG_VALUE = "true";

/** Hard cap on every persisted string field. A hostile imported body
 *  could otherwise round-trip multi-megabyte ids/labels into the vault
 *  graph; 1024 chars is comfortably past every legitimate value we emit
 *  (entity ids are short, type ids are reverse-DNS paths, labels we
 *  truncate at the render layer anyway). */
const MAX_FIELD_LEN = 1024;

/** ASCII C0 controls + Unicode bidi-override / zero-width / format codes.
 *  These are the load-bearing characters in Trojan-Source / homoglyph label
 *  attacks: a label containing U+202E (`RIGHT-TO-LEFT OVERRIDE`) visually
 *  flips rendering so `"Q3-Budget‮evil"` paints as `"Q3-Budget live"`
 *  and the attacker-controlled segment is hidden inside the rendered text.
 *  U+0000-001F (minus \t \n \r) are C0 controls; U+200B-200F are
 *  zero-width / ZWNJ / ZWJ / LRM / RLM; U+202A-202E are the explicit
 *  bidi overrides; U+2066-2069 are the isolate variants. Stripping in
 *  `clampField` catches the label render path AND every `data-*` attribute
 *  (since those flow through `clampField` too) — uniform defense across
 *  every field that reaches a user-visible surface. */
const STRIP_FORMAT_CONTROLS_RE = new RegExp(
	"[" +
		"\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F" +
		"\\u200B-\\u200F" +
		"\\u202A-\\u202E" +
		"\\u2066-\\u2069" +
		"]",
	"g",
);

function clampField(value: unknown): string {
	if (typeof value !== "string") return "";
	const stripped = value.replace(STRIP_FORMAT_CONTROLS_RE, "");
	return stripped.length > MAX_FIELD_LEN ? stripped.slice(0, MAX_FIELD_LEN) : stripped;
}

/** URL-encode the entityId before splicing into the `brainstorm://entity/<id>`
 *  href. The literal `brainstorm:` prefix already defangs `javascript:` /
 *  `data:` scheme injection (the browser parses the whole thing as one URL
 *  with scheme `brainstorm`), but unescaped `#` / `?` / `/` in the id would
 *  truncate the parser at `parseBrainstormEntityUri` and route navigation to
 *  a different target than the URL bar shows — a confused-deputy in any
 *  future link-preview / `target=_blank` flow. Legitimate entity ids are
 *  alphanumeric + hyphen + underscore, so `encodeURIComponent` is a no-op
 *  for them and lossless on round-trip. */
function entityIdToUriSegment(entityId: string): string {
	return encodeURIComponent(entityId);
}

/** Inline-styled card chrome for the clipboard export. Mirrors the live
 *  `<BlockEmbedView>` layout (icon + title + type-label) so pasting into
 *  Word / Google Docs / Gmail produces a visual card, not a bare link.
 *  We can't reach the user's CSS variables in a foreign rich-text app, so
 *  the palette is fixed to neutral grays + a subtle border — readable on
 *  both light and dark targets. All values inline because external apps
 *  strip <style> blocks and CSS classes on paste. */
// BlockEmbedNode is `isInline(): false` (block-level), so the clipboard
// surface uses `display:flex` not `inline-flex` — paste into a block-child
// context (Google Docs paragraph, Word, etc.) gets the card on its own
// line, not inline-wrapped next to surrounding text.
//
// `color:inherit` on the title lets the paste-target's body color
// drive the title shade (better dark-theme behavior on Word/Gmail/Docs
// than a hardcoded gray-900); only the subtitle pins a neutral gray.
const BLOCK_EMBED_CARD_STYLE =
	"display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;color:inherit;text-decoration:none;max-width:480px;min-width:200px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
const BLOCK_EMBED_ICON_STYLE =
	"display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:6px;background:#e5e7eb;color:#374151;font-weight:600;font-size:16px;flex:0 0 auto;";
const BLOCK_EMBED_BODY_STYLE =
	"display:flex;flex-direction:column;gap:2px;min-width:0;line-height:1.2;";
// Title clips at the render layer too (the 1024-char data clamp is the
// data-layer guard; this is the surface-layer one — `[[long-strings-must-be-clipped]]`).
const BLOCK_EMBED_TITLE_STYLE =
	"font-weight:600;color:inherit;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
const BLOCK_EMBED_SUBTITLE_STYLE =
	"color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

export type SerializedBlockEmbedNode = SerializedLexicalNode & {
	type: typeof BLOCK_EMBED_NODE_TYPE;
	version: typeof BLOCK_EMBED_NODE_VERSION;
	/** BP block id — the registry key the shell uses to pick a renderer.
	 *  v1 always emits {@link SHELL_ENTITY_CARD_BLOCK_ID} ; foreign values
	 *  round-trip unchanged so a future app-provided embed survives
	 *  pre-B9.5 builds. */
	blockId: string;
	entityId: string;
	entityType: string;
	label: string;
};

export class BlockEmbedNode extends DecoratorNode<JSX.Element> {
	__blockId: string;
	__entityId: string;
	__entityType: string;
	__label: string;

	static override getType(): string {
		return BLOCK_EMBED_NODE_TYPE;
	}

	static override clone(node: BlockEmbedNode): BlockEmbedNode {
		return new BlockEmbedNode(
			node.__blockId,
			node.__entityId,
			node.__entityType,
			node.__label,
			node.__key,
		);
	}

	constructor(blockId: string, entityId: string, entityType: string, label: string, key?: NodeKey) {
		super(key);
		this.__blockId = blockId;
		this.__entityId = entityId;
		this.__entityType = entityType;
		this.__label = label;
	}

	static override importJSON(s: SerializedBlockEmbedNode): BlockEmbedNode {
		const blockId = clampField(s.blockId);
		return new BlockEmbedNode(
			blockId.length > 0 ? blockId : SHELL_ENTITY_CARD_BLOCK_ID,
			clampField(s.entityId),
			clampField(s.entityType),
			clampField(s.label),
		);
	}

	override exportJSON(): SerializedBlockEmbedNode {
		return {
			type: BLOCK_EMBED_NODE_TYPE,
			version: BLOCK_EMBED_NODE_VERSION,
			blockId: this.__blockId,
			entityId: this.__entityId,
			entityType: this.__entityType,
			label: this.__label,
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

	/** HTML clipboard representation — the doc-15 invariant
	 *  ("copy gives you a portable representation; paste re-mounts the
	 *  embed — the reference travels; the underlying entity stays put").
	 *  The Lexical→Lexical JSON path already round-trips via `exportJSON` /
	 *  `importJSON` (clipboard MIME `application/x-lexical-editor`). This
	 *  is the HTML fallback for paste flows where the JSON gets stripped:
	 *  cross-Electron-window, into Word / Google Docs / mail clients, or
	 *  paste-as-plain-text. Every persisted field is clamped through
	 *  `clampField` so a hostile note can't emit a multi-megabyte
	 *  clipboard payload. The label is set via `textContent`, never
	 *  `innerHTML` — that's the load-bearing XSS regression-fence. */
	override exportDOM(): DOMExportOutput {
		const anchor = document.createElement("a");
		const entityId = clampField(this.__entityId);
		const entityType = clampField(this.__entityType);
		const blockId = clampField(this.__blockId);
		const label = clampField(this.__label);
		const typeLabel = entityTypeLabel(entityType, DEFAULT_T);
		anchor.setAttribute("href", `brainstorm://entity/${entityIdToUriSegment(entityId)}`);
		anchor.setAttribute(BLOCK_EMBED_DOM_FLAG, BLOCK_EMBED_DOM_FLAG_VALUE);
		anchor.setAttribute("data-block-id", blockId);
		anchor.setAttribute("data-entity-id", entityId);
		anchor.setAttribute("data-entity-type", entityType);
		anchor.setAttribute("data-label", label);
		anchor.setAttribute("style", BLOCK_EMBED_CARD_STYLE);
		// Icon stand-in: type-label's first letter against a tinted box.
		// We can't carry the user's icon choice across the clipboard (it's
		// a vault-resident asset reference), so the box gives the embed a
		// visual anchor that distinguishes it from a plain hyperlink in
		// every paste target — without leaking any vault data.
		const icon = document.createElement("span");
		icon.setAttribute("style", BLOCK_EMBED_ICON_STYLE);
		icon.setAttribute("aria-hidden", "true");
		icon.textContent = typeLabel.charAt(0).toUpperCase() || "•";
		const body = document.createElement("span");
		body.setAttribute("style", BLOCK_EMBED_BODY_STYLE);
		const title = document.createElement("span");
		title.setAttribute("style", BLOCK_EMBED_TITLE_STYLE);
		title.textContent = label;
		const subtitle = document.createElement("span");
		subtitle.setAttribute("style", BLOCK_EMBED_SUBTITLE_STYLE);
		subtitle.textContent = typeLabel;
		body.appendChild(title);
		body.appendChild(subtitle);
		anchor.appendChild(icon);
		anchor.appendChild(body);
		return { element: anchor };
	}

	/** HTML paste path. Only an `<a>` whose `BLOCK_EMBED_DOM_FLAG`
	 *  attribute value matches the exact stamp this editor emits
	 *  ({@link BLOCK_EMBED_DOM_FLAG_VALUE}) converts back to a
	 *  `BlockEmbedNode` — a plain `<a>` (no flag) keeps the regular
	 *  link-paste behaviour, and an attacker-shaped flag with the wrong
	 *  value (e.g. `="false"`, `=""`) is rejected. All four string attrs
	 *  are clamped through `clampField` on the way in, mirroring the JSON
	 *  hostile-body hardening. An empty `data-entity-id` rejects the
	 *  conversion outright — a reference to nothing is not a reference. */
	static override importDOM(): DOMConversionMap | null {
		return {
			a: (node: HTMLElement) => {
				if (node.getAttribute(BLOCK_EMBED_DOM_FLAG) !== BLOCK_EMBED_DOM_FLAG_VALUE) return null;
				return {
					conversion: (element: HTMLElement): DOMConversionOutput => {
						const rawBlockId = clampField(element.getAttribute("data-block-id"));
						const entityId = clampField(element.getAttribute("data-entity-id"));
						const entityType = clampField(element.getAttribute("data-entity-type"));
						const label = clampField(element.getAttribute("data-label"));
						if (entityId.length === 0) return { node: null };
						const blockId = rawBlockId.length > 0 ? rawBlockId : SHELL_ENTITY_CARD_BLOCK_ID;
						return {
							node: new BlockEmbedNode(blockId, entityId, entityType, label),
						};
					},
					priority: 1,
				};
			},
		};
	}

	getBlockId(): string {
		return this.__blockId;
	}

	getEntityId(): string {
		return this.__entityId;
	}

	getEntityType(): string {
		return this.__entityType;
	}

	getLabel(): string {
		return this.__label;
	}

	/** Plain-text view of the embed. Read by screen readers, Markdown
	 *  export, and search indexing — all of which want the human-readable
	 *  label, NOT the `brainstorm://entity/…` URI. The URI already reaches
	 *  the clipboard via the HTML `<a href>` (see `exportDOM`), so plain-
	 *  text terminals still receive a clickable link through the standard
	 *  "copied URL" path. Don't re-litigate switching this to the URI. */
	override getTextContent(): string {
		return this.__label;
	}

	override isInline(): false {
		return false;
	}

	override isKeyboardSelectable(): boolean {
		return true;
	}

	override decorate(): JSX.Element {
		return (
			<BlockEmbedView
				blockId={this.__blockId}
				entityId={this.__entityId}
				entityType={this.__entityType}
				label={this.__label}
			/>
		);
	}
}

/** Per-blockId cache of the block bundle source — one broker round-trip per
 *  distinct block, shared across every embed of it in the doc (mirrors the
 *  block-registry's resolve cache). A bundle is immutable for the life of an
 *  installed app version, so a process-lifetime cache is correct. */
const blockSourceCache = new Map<string, Promise<string | null>>();

function fetchBlockSource(blockId: string): Promise<string | null> {
	let cached = blockSourceCache.get(blockId);
	if (!cached) {
		const blocks = getEditorHost().blocks;
		cached = blocks ? blocks.source(blockId).catch(() => null) : Promise.resolve(null);
		blockSourceCache.set(blockId, cached);
	}
	return cached;
}

/** Resolve the block's bundle source once the registry says it's a BP block.
 *  `undefined` while loading, `null` when the block ships no bundle (→ keep
 *  the chrome card), a string when ready to mount. */
function useBlockSource(blockId: string, enabled: boolean): string | null | undefined {
	const [source, setSource] = useState<string | null | undefined>(undefined);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		fetchBlockSource(blockId).then((s) => {
			if (live) setSource(s);
		});
		return () => {
			live = false;
		};
	}, [blockId, enabled]);
	return source;
}

/** Hard ceiling on a live embed's height — beyond this the grid scrolls
 *  internally (the block reports its content height; an unbounded report
 *  can't blow out the host doc). */
const MAX_EMBED_HEIGHT_PX = 600;

/** DOM event the app-preload fires after it re-applies theme tokens to the
 *  document `:root` on a live theme switch. We re-push the embed theme on it so
 *  every live block repaints in lockstep with the host doc. */
const THEME_CHANGED_EVENT = "brainstorm:theme-changed";

/** Snapshot the host document's resolved theme custom properties so they can be
 *  forwarded into the opaque-origin block frame (which can't read the
 *  embedder's `:root`). Shared with the whiteboard's embed host — the SDK
 *  collector reads COMPUTED values (theme tokens live in stylesheets, not
 *  inline — the inline-only harvest shipped blocks three header-padding vars
 *  and a light grid inside dark themes, F-210). */
const collectThemeVars = collectBlockThemeVars;

export function BlockEmbedView({
	blockId,
	entityId,
	entityType,
	label,
}: {
	blockId: string;
	entityId: string;
	entityType: string;
	label: string;
}) {
	const t = useEditorT();
	useSyncExternalStore(subscribeEntityIcons, entityIconsSnapshot);
	useSyncExternalStore(subscribeEntityTitles, entityTitlesSnapshot);
	// 9.4.3 — ask the registry "which app renders this blockId?". 9.11
	// is the consumer-side wire-up that swaps the card body for a live
	// `<BpBlockMount>` when the resolution returns `BlockProtocol`. For
	// every other branch (`null` loading, `CustomNode` shell card,
	// `Fallback` no-provider) the existing card paints exactly as
	// before. The `data-renderer-kind` attribute exposes the resolved
	// kind so a Playwright fence can pin "this embed reached BP-block
	// mount" without poking the iframe internals.
	// Forward-compat upgrade: an embed inserted before its provider app
	// registered a block froze the fallback card id (`forType` returned null at
	// insert time). Re-resolve by entity type at render so the SAME persisted
	// node lights up the live block once a provider exists — the documented
	// "node lights up later" promise — without rewriting the on-disk node. Only
	// the fallback sentinel is re-resolved; an explicitly-chosen block id is
	// always honoured.
	const [typeBlockId, setTypeBlockId] = useState<string | null>(null);
	useEffect(() => {
		const blocks = getEditorHost().blocks;
		if (blockId !== SHELL_ENTITY_CARD_BLOCK_ID || !blocks) {
			setTypeBlockId(null);
			return;
		}
		let cancelled = false;
		blocks
			.forType(entityType)
			.then((id) => {
				if (!cancelled) setTypeBlockId(id && id !== SHELL_ENTITY_CARD_BLOCK_ID ? id : null);
			})
			.catch(() => {
				if (!cancelled) setTypeBlockId(null);
			});
		return () => {
			cancelled = true;
		};
	}, [blockId, entityType]);
	const effectiveBlockId =
		blockId === SHELL_ENTITY_CARD_BLOCK_ID && typeBlockId ? typeBlockId : blockId;
	const renderer = useBlockRenderer(effectiveBlockId);
	const rendererKind = renderer?.kind ?? "loading";
	const liveTitle = getEntityTitle(entityId);
	const display = liveTitle?.trim() || label.trim() || t("editor.embed.untitled");
	const icon = getEntityDisplayIcon(entityId, entityType);
	const isBp = renderer?.kind === BlockRendererKind.BlockProtocol;
	const typeLabel =
		isBp && renderer
			? blockProtocolSubtitle(renderer, entityType, t)
			: entityTypeLabel(entityType, t);
	const bpService = getEditorHost().bp;
	const source = useBlockSource(effectiveBlockId, isBp);
	const [height, setHeight] = useState<number | null>(null);
	const mountHandle = useRef<BpBlockMountHandle | null>(null);
	// The entity-index tick advances on every vault write; when the embedded
	// entity (or any of its rows) changes, ping the live block so it re-queries
	// and repaints — the embed stays current without a manual reload.
	const iconTick = useSyncExternalStore(subscribeEntityIcons, entityIconsSnapshot);
	// biome-ignore lint/correctness/useExhaustiveDependencies: iconTick is the re-run trigger — the effect fires the refresh ping whenever the vault index advances, it doesn't read the tick value
	useEffect(() => {
		mountHandle.current?.send({ kind: BlockControlKind.Refresh });
	}, [iconTick]);

	// The chrome anchor carries a `brainstorm://entity/<id>` href for
	// keyboard/middle-click affordance, but a plain left-click must dispatch the
	// in-app navigation (same path as the transclusion card) — the renderer does
	// not navigate `brainstorm://` hrefs on its own, so without this the card
	// looks clickable but does nothing.
	const onCardClick = useCallback(
		(event: React.MouseEvent) => {
			if (event.defaultPrevented) return;
			if (event.button !== 0) return;
			event.preventDefault();
			dispatchOpenEntity({ entityId, entityType, mode: navModeFromEvent(event) });
		},
		[entityId, entityType],
	);

	const sendTheme = useCallback(() => {
		const { vars, colorScheme } = collectThemeVars();
		mountHandle.current?.send({ kind: BlockControlKind.Theme, vars, colorScheme });
	}, []);

	// Re-push the theme whenever the host doc repaints its tokens (live theme
	// switch) so the embedded block tracks it in lockstep. Only matters once a
	// live mount exists; the request/response on Startup covers first paint.
	useEffect(() => {
		if (!isBp) return;
		const onThemeChanged = (): void => sendTheme();
		window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged);
		return () => window.removeEventListener(THEME_CHANGED_EVENT, onThemeChanged);
	}, [isBp, sendTheme]);

	// Block→host control messages: `navigate` opens the clicked entity in its
	// app (same path as the chrome anchor); `height` autosizes the iframe to
	// the block's content (bounded); `theme-request` asks for the current theme
	// vars (the block can't read them itself). Graph traffic falls through to `bp`.
	const onBlockMessage = useCallback(
		(payload: unknown) => {
			const m = payload as { kind?: string; entityId?: string; entityType?: string; px?: number };
			if (m?.kind === BlockControlKind.Navigate && typeof m.entityId === "string") {
				dispatchOpenEntity({
					entityId: m.entityId,
					entityType: typeof m.entityType === "string" ? m.entityType : "",
				});
			} else if (m?.kind === BlockControlKind.Height && typeof m.px === "number") {
				setHeight(Math.max(0, Math.min(m.px, MAX_EMBED_HEIGHT_PX)));
			} else if (m?.kind === BlockControlKind.ThemeRequest) {
				sendTheme();
			}
		},
		[sendTheme],
	);

	if (isBp) {
		// Live BP-block mount. The card is a thin chrome row (icon + title +
		// provider hint, wrapped in the `brainstorm://entity/<id>` anchor for
		// keyboard/click navigation to the underlying entity) above the live
		// sandboxed iframe. The iframe runs the providing app's real block
		// bundle (`source`) inside the pinned security shell; until the source
		// loads — or when the block ships none — only the chrome card shows.
		const liveMount = typeof source === "string" && source.length > 0;
		return (
			<div
				className="notes__embed-card notes__embed-card--bp"
				data-entity-id={entityId}
				data-entity-type={entityType}
				data-block-id={effectiveBlockId}
				data-renderer-kind={rendererKind}
				data-block-live={liveMount ? "true" : "false"}
			>
				<a
					className="notes__embed-card-chrome"
					href={`brainstorm://entity/${entityIdToUriSegment(entityId)}`}
					data-entity-id={entityId}
					data-entity-type={entityType}
					onClick={onCardClick}
				>
					<span className="notes__embed-card-icon" aria-hidden="true">
						<EntityIcon icon={icon} size={36} className="notes__embed-card-icon-glyph" />
					</span>
					<span className="notes__embed-card-body">
						<span className="notes__embed-card-title">{display}</span>
						<span className="notes__embed-card-type">{typeLabel}</span>
					</span>
				</a>
				{liveMount ? (
					<BpBlockMount
						entityId={entityId}
						capabilities={EMPTY_CAPS}
						blockId={effectiveBlockId}
						handleRef={mountHandle}
						onMessage={onBlockMessage}
						{...(bpService ? { bp: bpService } : {})}
						className="notes__embed-card-mount"
						title={display}
						{...(height !== null ? { style: { height } } : {})}
					/>
				) : null}
			</div>
		);
	}
	return (
		<a
			className="notes__embed-card"
			href={`brainstorm://entity/${entityIdToUriSegment(entityId)}`}
			data-entity-id={entityId}
			data-entity-type={entityType}
			data-block-id={effectiveBlockId}
			data-renderer-kind={rendererKind}
			onClick={onCardClick}
		>
			<span className="notes__embed-card-icon" aria-hidden="true">
				<EntityIcon icon={icon} size={36} className="notes__embed-card-icon-glyph" />
			</span>
			<span className="notes__embed-card-body">
				<span className="notes__embed-card-title">{display}</span>
				<span className="notes__embed-card-type">{typeLabel}</span>
			</span>
		</a>
	);
}

/** Stable empty-capabilities reference. `<BpBlockMount>` keys its remount
 *  on capability-list contents, but it's still kinder to pass a stable
 *  reference so React's prop comparator can short-circuit identity-equal
 *  pairs in dev tools / future profilers. v1 grants no capabilities to
 *  embedded BP blocks; the broker plumbing arrives with 9.3.3's BP Hook
 *  handler. */
const EMPTY_CAPS: readonly string[] = Object.freeze([]);

/** Subtitle hint when the registry resolved a BP-block provider but the
 *  mount seam (9.4.4) hasn't lit up yet — surfaces "{type} · provided by
 *  {appId}" so a user can tell that a provider IS installed and the
 *  fallback card is intentional, not a missing-provider situation. The
 *  live BP-block iframe at 9.11 replaces this subtle text with the
 *  block's own rendering. */
function blockProtocolSubtitle(
	renderer: { appId: string },
	entityType: string,
	t: EditorT,
): string {
	return t("editor.embed.providedBy", { type: entityTypeLabel(entityType, t), app: renderer.appId });
}

/** Human-readable type label for the card's bottom-line. Reverse-DNS
 *  ids collapse to their last `/`-segment minus the `/v\d+` suffix —
 *  `io.brainstorm.notes/Note/v1` → `Note`. */
function entityTypeLabel(entityType: string, t: EditorT): string {
	if (!entityType) return t("editor.embed.typeUnknown");
	const lastSlash = entityType.lastIndexOf("/");
	const tail = lastSlash >= 0 ? entityType.slice(lastSlash + 1) : entityType;
	const trimmed = tail.replace(/^v\d+$/, "");
	if (trimmed.length > 0) return trimmed;
	const penultimate = entityType.slice(0, lastSlash);
	const prevSlash = penultimate.lastIndexOf("/");
	return prevSlash >= 0 ? penultimate.slice(prevSlash + 1) : penultimate;
}

export function $createBlockEmbedNode(
	entityId: string,
	entityType: string,
	label: string,
	blockId: string = SHELL_ENTITY_CARD_BLOCK_ID,
): BlockEmbedNode {
	return new BlockEmbedNode(blockId, entityId, entityType, label);
}

export function $isBlockEmbedNode(node: LexicalNode | null | undefined): node is BlockEmbedNode {
	return node instanceof BlockEmbedNode;
}
