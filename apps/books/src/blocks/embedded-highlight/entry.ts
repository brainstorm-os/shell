/**
 * `io.brainstorm.books/embedded-highlight` — a single anchored `Highlight/v1`
 * (a span of a book + its colour + optional note), rendered inline in a host
 * document (e.g. a Notes doc) via the BP block frame. Shows the highlight's
 * colour swatch, the captured quote, the source book's title, and the attached
 * note when present; a click opens the source book in the Books app (a
 * highlight has no opener of its own — the book does). Read-only: a
 * highlight's text + note are edited in the reader.
 *
 * Runs INSIDE the sandboxed opaque-origin iframe (no ambient authority, no
 * `window.brainstorm`); its only channel to the vault is the
 * `@brainstorm-os/sdk/block-runtime` harness (`getEntity` over the BP graph
 * module). It resolves the source book with a SECOND `getEntity` keyed by the
 * highlight's `bookId` (Books holds `entities.read:brainstorm/Book/v1`). Pure
 * DOM — no framework, no SDK i18n: the bundle is a single self-contained IIFE
 * inlined into the frame's srcdoc, so it carries its own literals (mirrors
 * `embedded-graph` / `bookmark`).
 *
 * The block frame CSP is `img-src data:` only (no remote pixels), so the
 * colour swatch is a CSS-painted chip, never a fetched asset.
 */

import { type BlockRuntimeContext, startBlock } from "@brainstorm-os/sdk/block-runtime";

interface BpEntity {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

const BOOK_ENTITY_TYPE = "brainstorm/Book/v1";

/** The CSS paint for each `HighlightColor` (mirrors the reader swatch). The
 *  block carries its own table — the `HighlightColor` enum lives in the app's
 *  type module, which the no-loader frame can't import. */
const DEFAULT_SWATCH = "#facc15";

const SWATCH: Record<string, string> = {
	yellow: DEFAULT_SWATCH,
	green: "#34d399",
	blue: "#60a5fa",
	pink: "#f472b6",
	purple: "#a78bfa",
};

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function swatchColor(color: string): string {
	return SWATCH[color] ?? DEFAULT_SWATCH;
}

function quoteText(props: Record<string, unknown>): string {
	const quote = str(props.quote);
	return quote.length > 0 ? quote : "Untitled highlight";
}

function bookTitle(book: BpEntity | null): string {
	if (!book) return "Unknown book";
	const name = str(book.properties.name);
	return name.length > 0 ? name : "Untitled book";
}

// Colours come from the host theme tokens the block-runtime mirrors onto
// `:root` (`@brainstorm-os/sdk/block-runtime` BlockControlKind.Theme); the literal
// fallbacks in each `var(--…, fallback)` only paint before the theme lands / in
// standalone tests. No `prefers-color-scheme` overrides — the active theme (not
// the OS) is the source of truth.
const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; }
.bshl { display: flex; gap: 10px; padding: 10px 12px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--color-text-primary, #1c1c1e); cursor: pointer; }
.bshl:hover { background: var(--color-accent-subtle, rgba(127,127,127,.07)); }
.bshl__swatch { flex: 0 0 auto; width: 4px; border-radius: 2px; align-self: stretch; }
.bshl__body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bshl__quote { font-weight: 500; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.bshl__note { color: var(--color-text-secondary, #555); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.bshl__meta { color: var(--color-text-tertiary, #8a8a8e); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bshl__error { padding: 10px 12px; color: var(--color-text-tertiary, #8a8a8e); }
`;

function injectStyles(doc: Document): void {
	if (doc.getElementById("bshl-styles")) return;
	const style = doc.createElement("style");
	style.id = "bshl-styles";
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

export function bootEmbeddedHighlight(ctx: BlockRuntimeContext): void {
	injectStyles(ctx.root.ownerDocument);
	const doc = ctx.root.ownerDocument;

	ctx.onLoad(async () => {
		let highlight: BpEntity | null = null;
		try {
			highlight = await ctx.graph<BpEntity>("getEntity", { entityId: ctx.entityId });
		} catch {
			highlight = null;
		}
		ctx.root.replaceChildren();
		if (!highlight) {
			ctx.root.className = "";
			const err = doc.createElement("div");
			err.className = "bshl__error";
			err.textContent = "Couldn't load this highlight.";
			ctx.root.append(err);
			ctx.reportHeight(ctx.root.scrollHeight);
			return;
		}

		const bookId = str(highlight.properties.bookId);
		let book: BpEntity | null = null;
		if (bookId.length > 0) {
			try {
				book = await ctx.graph<BpEntity>("getEntity", { entityId: bookId });
			} catch {
				book = null;
			}
		}

		renderHighlight(ctx, highlight, book);
		ctx.reportHeight(ctx.root.scrollHeight);
	});
}

startBlock(bootEmbeddedHighlight);

function renderHighlight(
	ctx: {
		root: HTMLElement;
		navigate: (id: string, type: string) => void;
	},
	highlight: BpEntity,
	book: BpEntity | null,
): void {
	const doc = ctx.root.ownerDocument;
	ctx.root.className = "bshl";
	// A highlight has no opener; clicking opens its source book in Books.
	const bookId = str(highlight.properties.bookId);
	ctx.root.addEventListener("click", () => {
		if (bookId.length > 0) ctx.navigate(bookId, BOOK_ENTITY_TYPE);
	});

	const swatch = doc.createElement("span");
	swatch.className = "bshl__swatch";
	swatch.style.background = swatchColor(str(highlight.properties.color));

	const body = doc.createElement("div");
	body.className = "bshl__body";

	const quote = doc.createElement("div");
	quote.className = "bshl__quote";
	quote.textContent = quoteText(highlight.properties);
	body.append(quote);

	const note = str(highlight.properties.note);
	if (note.length > 0) {
		const noteEl = doc.createElement("div");
		noteEl.className = "bshl__note";
		noteEl.textContent = note;
		body.append(noteEl);
	}

	const meta = doc.createElement("div");
	meta.className = "bshl__meta";
	meta.textContent = bookTitle(book);
	body.append(meta);

	ctx.root.append(swatch, body);
}
