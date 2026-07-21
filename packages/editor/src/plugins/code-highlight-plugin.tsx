/**
 * CodeHighlightPlugin — Shiki syntax highlighting for code blocks (B11.4).
 *
 * Lexical's `@lexical/code` highlighting uses Prism; we standardised on Shiki
 * (the shared `@brainstorm-os/sdk/code-highlight` tokenizer, also used by the
 * code-editor app). Shiki tokenization is **async** (grammars load on demand),
 * so it can't drive a synchronous Lexical node transform — instead this is a
 * read-only **overlay**: per `.notes__code` block we paint Shiki tokens into a
 * `<pre>` positioned over the block and make the block's own text transparent
 * (caret stays visible). Like `CodeLineNumbersPlugin`, it never touches the
 * node tree or serialization, so a misfire is cosmetic, never corrupting.
 *
 * Positioning that survives scroll without a per-frame relayout:
 *  - The overlays are portalled INTO `.notes__main` (the scroll container,
 *    `position: relative`) at each block's content-space offset, so VERTICAL
 *    scroll moves them natively with the content — no rAF scroll-sync, no lag.
 *  - A code block scrolls HORIZONTALLY on its own (`overflow-x: auto`, long
 *    lines), which the outer container doesn't see — so each overlay listens
 *    to its block's `scroll` and translates its inner content by `-scrollLeft`
 *    (clipped to the block width). Mirrors the code-editor overlay's
 *    `syncScroll`, per block.
 *
 * Every block gets an overlay even when its language is unknown / still
 * loading (a plain, uncoloured paint) so the transparent block text is always
 * backed by something readable. Theme follows the app's resolved `color-scheme`
 * (set on the document root from the active theme's background luminance), not
 * the OS — so light tokens never land on a dark code background.
 */

import { HighlightTheme, type ThemedToken, tokenizeShiki } from "@brainstorm-os/sdk/code-highlight";
import { CodeNode } from "@lexical/code";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, type LexicalEditor } from "lexical";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

export const CODE_HIGHLIGHT_ROOT_CLASS = "notes--code-highlighted";

/** `@lexical/code` language id → Shiki grammar id. Identity for most; the
 *  one rename is `bash → shellscript` (Shiki's id for shell). Languages not
 *  shipped by the SDK tokenizer map to `null` → plain (uncoloured) paint. */
const SHIKI_ID: Readonly<Record<string, string>> = Object.freeze({
	javascript: "javascript",
	typescript: "typescript",
	jsx: "jsx",
	tsx: "tsx",
	python: "python",
	json: "json",
	html: "html",
	css: "css",
	markdown: "markdown",
	bash: "shellscript",
	sql: "sql",
	go: "go",
	rust: "rust",
	java: "java",
	cpp: "cpp",
	yaml: "yaml",
});

function shikiIdFor(language: string | null | undefined): string | null {
	if (!language) return null;
	return SHIKI_ID[language] ?? null;
}

function resolvedTheme(): HighlightTheme {
	if (typeof document === "undefined") return HighlightTheme.Light;
	const scheme = getComputedStyle(document.documentElement).colorScheme || "";
	return scheme.includes("dark") ? HighlightTheme.Dark : HighlightTheme.Light;
}

type CodeBlock = {
	key: string;
	text: string;
	shikiId: string | null;
};

type PlacedBlock = CodeBlock & {
	/** Content-space box within `.notes__main` (scroll-independent). */
	top: number;
	left: number;
	width: number;
	style: {
		paddingTop: string;
		paddingRight: string;
		paddingBottom: string;
		paddingLeft: string;
		fontFamily: string;
		fontSize: string;
		lineHeight: string;
		tabSize: string;
		whiteSpace: string;
	};
};

/** Module-level token cache so an edit elsewhere doesn't re-tokenize an
 *  unchanged block. Keyed by theme + grammar + exact text. `undefined` = not
 *  yet requested; `null` = tokenized-as-plain (unknown grammar / failure). */
const tokenCache = new Map<string, ThemedToken[][] | null>();
const inFlight = new Set<string>();

function cacheKey(theme: HighlightTheme, shikiId: string | null, text: string): string {
	return `${theme}::${shikiId ?? "_plain"}::${text}`;
}

function readCodeBlocks(editor: LexicalEditor): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	editor.getEditorState().read(() => {
		for (const node of $getRoot().getChildren()) {
			if (node instanceof CodeNode) {
				blocks.push({
					key: node.getKey(),
					text: node.getTextContent(),
					shikiId: shikiIdFor(node.getLanguage()),
				});
			}
		}
	});
	return blocks;
}

function placeBlocks(editor: LexicalEditor, blocks: CodeBlock[], main: HTMLElement): PlacedBlock[] {
	const mainRect = main.getBoundingClientRect();
	const out: PlacedBlock[] = [];
	for (const block of blocks) {
		const el = editor.getElementByKey(block.key);
		if (!el) continue;
		const rect = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		out.push({
			...block,
			top: rect.top - mainRect.top + main.scrollTop,
			left: rect.left - mainRect.left + main.scrollLeft,
			width: rect.width,
			style: {
				paddingTop: cs.paddingTop,
				paddingRight: cs.paddingRight,
				paddingBottom: cs.paddingBottom,
				paddingLeft: cs.paddingLeft,
				fontFamily: cs.fontFamily,
				fontSize: cs.fontSize,
				lineHeight: cs.lineHeight,
				tabSize: cs.tabSize,
				whiteSpace: cs.whiteSpace,
			},
		});
	}
	return out;
}

export function CodeHighlightPlugin(): ReactNode {
	const [editor] = useLexicalComposerContext();
	const [main, setMain] = useState<HTMLElement | null>(null);
	const [placed, setPlaced] = useState<PlacedBlock[]>([]);
	const [theme, setTheme] = useState<HighlightTheme>(resolvedTheme);
	// Bumped whenever an async tokenization resolves, to re-read the cache.
	const [, setTick] = useState(0);

	// The scroll container is the overlay host; resolve it once the editor's
	// root element exists. Mark it so CSS makes the block text transparent.
	useEffect(() => {
		const root = editor.getRootElement();
		const host = root?.closest<HTMLElement>(".notes__main") ?? null;
		setMain(host);
		host?.classList.add(CODE_HIGHLIGHT_ROOT_CLASS);
		return () => host?.classList.remove(CODE_HIGHLIGHT_ROOT_CLASS);
	}, [editor]);

	// Re-measure on editor update + resize. NOT on scroll — the overlays live
	// in the scroll container and move with it natively.
	useEffect(() => {
		if (!main) return;
		let raf = 0;
		const schedule = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				setPlaced(placeBlocks(editor, readCodeBlocks(editor), main));
			});
		};
		schedule();
		const off = editor.registerUpdateListener(schedule);
		window.addEventListener("resize", schedule);
		// Content ABOVE a code block can change height with NO editor update and
		// NO window resize — a GFM table settling its column widths, an image /
		// cover or an async live-embed loading, a web-font swap. Each shifts the
		// block down while the overlay keeps its stale (higher) offset, so it
		// floats over the content above (the "code overlaps the table" report). A
		// ResizeObserver on the editable root re-measures on every such reflow;
		// the overlays are absolute siblings of the root, so they never feed back
		// into its size (no observer loop).
		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined") {
			ro = new ResizeObserver(schedule);
			const root = editor.getRootElement();
			if (root) ro.observe(root);
		}
		// Web-font swaps relayout text-heavy blocks after first paint.
		const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
		fonts?.ready.then(schedule).catch(() => {});
		return () => {
			if (raf) cancelAnimationFrame(raf);
			off();
			window.removeEventListener("resize", schedule);
			ro?.disconnect();
		};
	}, [editor, main]);

	// Follow theme changes: the shell rewrites the root `color-scheme` when the
	// appearance flips. A style-attribute observer on the document root catches
	// it without a bespoke event channel.
	useEffect(() => {
		if (typeof MutationObserver === "undefined") return;
		const obs = new MutationObserver(() => setTheme(resolvedTheme()));
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
		return () => obs.disconnect();
	}, []);

	// Kick off tokenization for any (theme, grammar, text) not yet cached.
	useEffect(() => {
		for (const block of placed) {
			const key = cacheKey(theme, block.shikiId, block.text);
			if (tokenCache.has(key) || inFlight.has(key)) continue;
			if (!block.shikiId) {
				tokenCache.set(key, null);
				continue;
			}
			inFlight.add(key);
			void tokenizeShiki(block.text, block.shikiId, theme)
				.then((tokens) => tokenCache.set(key, tokens))
				.catch(() => tokenCache.set(key, null))
				.finally(() => {
					inFlight.delete(key);
					setTick((n) => n + 1);
				});
		}
	}, [placed, theme]);

	if (!main || placed.length === 0) return null;
	return createPortal(
		placed.map((block) => (
			<CodeOverlay
				key={block.key}
				block={block}
				tokens={tokenCache.get(cacheKey(theme, block.shikiId, block.text))}
			/>
		)),
		main,
	);
}

function CodeOverlay({
	block,
	tokens,
}: {
	block: PlacedBlock;
	tokens: ThemedToken[][] | null | undefined;
}): ReactNode {
	const [editor] = useLexicalComposerContext();
	const [scrollLeft, setScrollLeft] = useState(0);

	// Sync the block's own horizontal scroll (long lines) onto the overlay.
	useEffect(() => {
		const el = editor.getElementByKey(block.key);
		if (!el) return;
		const onScroll = () => setScrollLeft(el.scrollLeft);
		onScroll();
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [editor, block.key]);

	return (
		<pre
			className="notes__code-highlight"
			aria-hidden="true"
			style={{
				top: `${block.top}px`,
				left: `${block.left}px`,
				width: `${block.width}px`,
				paddingTop: block.style.paddingTop,
				paddingRight: block.style.paddingRight,
				paddingBottom: block.style.paddingBottom,
				paddingLeft: block.style.paddingLeft,
				fontFamily: block.style.fontFamily,
				fontSize: block.style.fontSize,
				lineHeight: block.style.lineHeight,
				tabSize: block.style.tabSize as unknown as number,
				whiteSpace: block.style.whiteSpace as "pre" | "pre-wrap",
			}}
		>
			<code style={{ transform: `translateX(${-scrollLeft}px)` }}>
				{tokens ? paintTokens(tokens) : block.text}
			</code>
		</pre>
	);
}

/** Render Shiki's 2-D token grid to React: one line span per source line,
 *  newline-joined so a `white-space: pre`/`pre-wrap` container lays them out
 *  exactly as the editable block does. Per-token foreground colour inline. */
function paintTokens(lines: ThemedToken[][]): ReactNode[] {
	return lines.map((tokens, lineIdx) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: positional line list painted from a fresh tokenization each render.
		<span key={lineIdx} className="notes__code-highlight-line">
			{tokens.map((token, tokenIdx) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: positional token list, regenerated wholesale per paint.
					key={tokenIdx}
					style={token.color ? { color: token.color } : undefined}
				>
					{token.content}
				</span>
			))}
			{lineIdx < lines.length - 1 ? "\n" : null}
		</span>
	));
}
