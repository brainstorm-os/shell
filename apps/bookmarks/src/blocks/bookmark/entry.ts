/**
 * `io.brainstorm.bookmarks/bookmark` — a single saved link, rendered inline in
 * a host document via the BP block frame. Shows the bookmark's favicon, title,
 * and host; a click opens the bookmark in the Bookmarks app. Read-only (a
 * bookmark's edits live in the app). Runs in the sandbox (no ambient
 * authority) via `@brainstorm-os/sdk/block-runtime`. Pure DOM.
 *
 * The favicon is rendered only when it is a `data:` URI — the block frame CSP
 * is `img-src data:` (no remote pixels), so a scraped `https://` faviconUrl
 * can't load inside the frame and is dropped in favour of the text monogram.
 */

import { type BlockRuntimeContext, startBlock } from "@brainstorm-os/sdk/block-runtime";

interface BpEntity {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The host (`example.com`) of a saved URL, or the raw URL when it doesn't
 *  parse. Standalone (no app-logic import) so the bundle stays self-contained
 *  for the no-module-loader frame. */
function hostLabel(url: string): string {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function bookmarkTitle(props: Record<string, unknown>): string {
	const title = str(props.title);
	if (title.length > 0) return title;
	const host = hostLabel(str(props.url));
	return host.length > 0 ? host : "Untitled bookmark";
}

// Colours come from the host theme tokens the block-runtime mirrors onto
// `:root` (BlockControlKind.Theme); the `var(--…, fallback)` literals only
// paint before the theme lands / in standalone tests. No
// `prefers-color-scheme` overrides — the active theme is the source of truth.
const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; }
.bsbm { display: flex; align-items: center; gap: 10px; padding: 10px 12px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--color-text-primary, #1c1c1e); cursor: pointer; }
.bsbm:hover { background: var(--color-accent-subtle, rgba(127,127,127,.07)); }
.bsbm__icon { flex: 0 0 auto; width: 18px; height: 18px; border-radius: 4px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--color-surface-sunken, rgba(127,127,127,.12)); color: var(--color-text-tertiary, #8a8a8e); font-size: 11px; font-weight: 600; text-transform: uppercase; }
.bsbm__icon img { width: 100%; height: 100%; object-fit: contain; }
.bsbm__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bsbm__title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsbm__meta { color: var(--color-text-tertiary, #8a8a8e); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsbm__error { padding: 10px 12px; color: var(--color-text-tertiary, #8a8a8e); }
`;

function injectStyles(doc: Document): void {
	if (doc.getElementById("bsbm-styles")) return;
	const style = doc.createElement("style");
	style.id = "bsbm-styles";
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

export function bootBookmark(ctx: BlockRuntimeContext): void {
	injectStyles(ctx.root.ownerDocument);
	const doc = ctx.root.ownerDocument;

	ctx.onLoad(async () => {
		let bookmark: BpEntity | null = null;
		try {
			bookmark = await ctx.graph<BpEntity>("getEntity", { entityId: ctx.entityId });
		} catch {
			bookmark = null;
		}
		ctx.root.replaceChildren();
		if (!bookmark) {
			ctx.root.className = "";
			const err = doc.createElement("div");
			err.className = "bsbm__error";
			err.textContent = "Couldn't load this bookmark.";
			ctx.root.append(err);
			ctx.reportHeight(ctx.root.scrollHeight);
			return;
		}
		renderBookmark(ctx, bookmark);
		ctx.reportHeight(ctx.root.scrollHeight);
	});
}

startBlock(bootBookmark);

function renderBookmark(
	ctx: {
		root: HTMLElement;
		navigate: (id: string, type: string) => void;
	},
	bookmark: BpEntity,
): void {
	const doc = ctx.root.ownerDocument;
	ctx.root.className = "bsbm";
	ctx.root.addEventListener("click", () => ctx.navigate(bookmark.entityId, bookmark.entityTypeId));

	const props = bookmark.properties;
	const title = bookmarkTitle(props);
	const url = str(props.url);
	const host = url.length > 0 ? hostLabel(url) : "";

	const icon = doc.createElement("span");
	icon.className = "bsbm__icon";
	const favicon = str(props.faviconUrl);
	// CSP `img-src data:` only — a remote favicon URL can't load in the frame.
	if (favicon.startsWith("data:image/")) {
		const img = doc.createElement("img");
		img.src = favicon;
		img.alt = "";
		icon.append(img);
	} else {
		icon.textContent = (title[0] ?? "•").toUpperCase();
	}

	const body = doc.createElement("div");
	body.className = "bsbm__body";

	const titleEl = doc.createElement("span");
	titleEl.className = "bsbm__title";
	titleEl.textContent = title;
	body.append(titleEl);

	if (host) {
		const meta = doc.createElement("span");
		meta.className = "bsbm__meta";
		meta.textContent = host;
		body.append(meta);
	}

	ctx.root.append(icon, body);
}
