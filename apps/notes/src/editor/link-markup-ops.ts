/**
 * Pure-logic helpers for the B6.2 link-markup surface.
 *
 *   - `buildEntityLinkUrl` — formats a `brainstorm://entity/<id>` URI from
 *     a vault entity id. The persisted form is *protocol* (see
 *     `extract-references.ts`'s `parseBrainstormEntityUri`): both the
 *     Notes-side walker and the shell-side mirror walker parse the same
 *     prefix when scanning serialised note bodies.
 *
 *   - `resolveLinkClick` — given a raw click event's URL + modifier state,
 *     decide whether to short-circuit the navigation and dispatch an
 *     `intent.open` against the embedded entity id, or pass through to
 *     the default `<a>` behaviour (used by external `https://` links).
 *
 *   - `findEntityLinkFromEvent` — walks up from the click target looking
 *     for the nearest `<a>` whose `href` resolves to an entity URI. Lets
 *     the click handler attach to the editor root and ignore unrelated
 *     elements with one helper.
 *
 *  Kept separate from `link-markup-plugin.tsx` so the click + URL logic
 *  can be unit-tested without jsdom or Lexical, and so the URL shape
 *  stays one source of truth across the plugin + future tooling.
 */

import { parseBrainstormEntityUri } from "./extract-references";

export const BRAINSTORM_ENTITY_LINK_PREFIX = "brainstorm://entity/";

/** Build a `brainstorm://entity/<id>` URI for a freshly-picked entity.
 *  Throws on empty id — the picker filters those out, but the guard
 *  protects callers from silently producing `brainstorm://entity/` which
 *  the parser rejects anyway. */
export function buildEntityLinkUrl(entityId: string): string {
	if (!entityId || entityId.trim().length === 0) {
		throw new Error("[notes/link-markup] entity id is required");
	}
	return `${BRAINSTORM_ENTITY_LINK_PREFIX}${entityId}`;
}

/** Decision returned by `resolveLinkClick`. */
export enum LinkClickAction {
	OpenEntity = "open-entity",
	PassThrough = "pass-through",
}

export type LinkClickDecision =
	| { action: LinkClickAction.OpenEntity; entityId: string; blockId?: string }
	| { action: LinkClickAction.PassThrough };

export type LinkClickInput = {
	href: string | null | undefined;
	/** True when any modifier key is held (Cmd / Ctrl / Shift / Alt /
	 *  middle-click) — those should let the user open in a new window or
	 *  override the entity routing, so we pass through. */
	hasModifier?: boolean;
};

/** Decide what to do with a click on an `<a>` inside the editor. Returns
 *  `OpenEntity` only when the href is a well-formed
 *  `brainstorm://entity/<id>` URI AND no modifier was held. Modifier-held
 *  clicks pass through so power users can keep the default behaviour
 *  (Ctrl+click "open in new tab" etc.). External URLs always pass
 *  through. */
export function resolveLinkClick(input: LinkClickInput): LinkClickDecision {
	const href = input.href ?? "";
	if (input.hasModifier) return { action: LinkClickAction.PassThrough };
	const parsed = parseBrainstormEntityUri(href);
	if (!parsed) return { action: LinkClickAction.PassThrough };
	return {
		action: LinkClickAction.OpenEntity,
		entityId: parsed.entityId,
		// `#block-<id>` anchor (B11.13) — forwarded so the open lands on
		// (scrolls to + flashes) the linked block.
		...(parsed.blockId ? { blockId: parsed.blockId } : {}),
	};
}

/** Walk up from a DOM event target looking for the nearest `<a>` whose
 *  href resolves to a Brainstorm entity URI. Returns the anchor + parsed
 *  decision, or `null` when no such ancestor exists.
 *
 *  Bounded by `root` so the walk stops at the editor's contenteditable
 *  rather than wandering into shell chrome. */
export function findEntityLinkFromEvent(
	target: EventTarget | null,
	root: Element,
): { anchor: HTMLAnchorElement; entityId: string; entityType?: string } | null {
	if (!(target instanceof Element)) return null;
	const anchor = target.closest("a");
	if (!anchor) return null;
	if (!root.contains(anchor)) return null;
	const href = anchor.getAttribute("href");
	const parsed = parseBrainstormEntityUri(href ?? "");
	if (!parsed) return null;
	// A block-embed / page-ref anchor stamps `data-entity-type` so the open
	// dispatch reaches the type-specific opener WITHOUT a shell resolver
	// round-trip — the same direct-routing mention chips already get. Without
	// it an embed click opens id-only; if nothing claims the resolved type the
	// shell falls back to the generic editor and the user sees an empty object.
	const entityType = anchor.getAttribute("data-entity-type") ?? "";
	return {
		anchor: anchor as HTMLAnchorElement,
		entityId: parsed.entityId,
		...(entityType.length > 0 ? { entityType } : {}),
	};
}

/** `brainstorm://` hosts that serve raw binary content (the shell's
 *  protocol handler, packages/shell `src/main/index.ts`): `asset/` is a
 *  sealed imported binary (the Anytype/Obsidian media pass rewrites a
 *  PDF's `link.url` to it), `app-file/` a content-addressed upload. A
 *  link anchor to either can't just navigate — the app view's
 *  will-navigate guard (`wireExternalLinkRouting`) blocks every non-http
 *  navigation — so the click interceptor downloads it instead, the same
 *  `<a download>` path the editor's file chip (`FileBlockNode`) uses. */
const BRAINSTORM_BINARY_PREFIXES = ["brainstorm://asset/", "brainstorm://app-file/"] as const;

/** True when the URL points at binary-serving `brainstorm://` content
 *  (an asset or uploaded app file) rather than an entity. */
export function isBrainstormBinaryUrl(url: string): boolean {
	return BRAINSTORM_BINARY_PREFIXES.some(
		(prefix) => url.startsWith(prefix) && url.length > prefix.length,
	);
}

/** Walk up from a DOM event target to the nearest `<a>` whose href is a
 *  binary-serving `brainstorm://` URL (imported PDF / uploaded file link).
 *  Bounded by `root` like {@link findEntityLinkFromEvent}. Returns the
 *  anchor + its href, or `null`. */
export function findBinaryLinkFromEvent(
	target: EventTarget | null,
	root: Element,
): { anchor: HTMLAnchorElement; url: string } | null {
	if (!(target instanceof Element)) return null;
	const anchor = target.closest("a");
	if (!anchor || !root.contains(anchor)) return null;
	const href = anchor.getAttribute("href") ?? "";
	if (!isBrainstormBinaryUrl(href)) return null;
	return { anchor: anchor as HTMLAnchorElement, url: href };
}

/** Trigger a save of a binary `brainstorm://` URL by clicking a transient
 *  `<a download>` — the same mechanism `FileBlockNode`'s chip relies on
 *  ("renders an `<a download>` so the shell handles the save"). A plain
 *  in-page navigation would be dropped by the Electron will-navigate
 *  guard; the download attribute routes it to the download pipeline
 *  instead. `name` (the link's text — the display filename for imported
 *  files) becomes the suggested filename when present. */
export function triggerBinaryLinkDownload(url: string, name?: string | null): void {
	const a = document.createElement("a");
	a.href = url;
	a.download = name?.trim() || "";
	a.rel = "noopener noreferrer";
	a.style.display = "none";
	document.body.appendChild(a);
	a.click();
	a.remove();
}

/** Walk up from a click target to the nearest `MentionNode` chip and read
 *  its entity coordinates. `MentionNode.createDOM` stamps both
 *  `data-entity-id` and `data-entity-type` on its outer span (the inner
 *  decorator chip only carries the id), so the combined-attribute
 *  selector lands on the node element regardless of which inner span the
 *  pointer hit. Bounded by `root` so the walk stops at the editor's
 *  contenteditable. Returns `null` when the click wasn't on a mention or
 *  the id is empty (a half-built node). */
export function findMentionFromEvent(
	target: EventTarget | null,
	root: Element,
): { entityId: string; entityType: string } | null {
	if (!(target instanceof Element)) return null;
	const el = target.closest("[data-entity-id][data-entity-type]");
	if (!el || !root.contains(el)) return null;
	const entityId = el.getAttribute("data-entity-id") ?? "";
	const entityType = el.getAttribute("data-entity-type") ?? "";
	if (entityId.length === 0) return null;
	return { entityId, entityType };
}
