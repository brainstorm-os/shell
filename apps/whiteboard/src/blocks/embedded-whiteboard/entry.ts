/**
 * `io.brainstorm.whiteboard/embedded-whiteboard` — a single board, rendered
 * inline in a host document (e.g. a Notes doc) via the BP block frame. Shows
 * the board's name plus a node-count summary ("12 items · 3 frames"); a click
 * opens the board in the Whiteboard app. Read-only — a board's edits live in
 * the app. Runs INSIDE the sandboxed opaque-origin iframe (no ambient
 * authority, no `window.brainstorm`); its only channel to the vault is the
 * `@brainstorm-os/sdk/block-runtime` harness (`getEntity` over the BP graph
 * module). Pure DOM — no framework in the sandbox.
 *
 * Why a summary card and not a live canvas render: the board's renderer is a
 * Pixi/DOM stage that assumes the full app shell (instruments, viewport,
 * pointer model). A doc embed is a preview + an "open" affordance, mirroring
 * the database `embedded-list` block (a preview grid, not the full app). The
 * canonical `nodes[]` summary is enough to identify the board at a glance.
 */

import { type BlockRuntimeContext, startBlock } from "@brainstorm-os/sdk/block-runtime";

interface BpEntity {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

/** Node kinds counted into the summary line. Mirrors the app's `NodeKind`
 *  string-enum values; standalone (no app-logic import) so the bundle stays
 *  self-contained for the no-module-loader frame. */
const FRAME_KIND = "frame";

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function boardName(props: Record<string, unknown>): string {
	const name = str(props.name);
	return name.length > 0 ? name : "Untitled board";
}

/** Count total nodes + frames from the board's inlined `nodes[]`. A frame is
 *  scenery (a grouping rectangle), so it's surfaced separately from the
 *  "items" tally. Defensive against a non-array / malformed `nodes`. */
function summarize(props: Record<string, unknown>): { items: number; frames: number } {
	const nodes = props.nodes;
	if (!Array.isArray(nodes)) return { items: 0, frames: 0 };
	let frames = 0;
	for (const node of nodes) {
		if (node && typeof node === "object" && (node as { kind?: unknown }).kind === FRAME_KIND) {
			frames += 1;
		}
	}
	return { items: nodes.length - frames, frames };
}

function plural(count: number, one: string, other: string): string {
	return count === 1 ? one : other;
}

function summaryLabel(items: number, frames: number): string {
	const itemsLabel = `${items} ${plural(items, "item", "items")}`;
	if (frames === 0) return itemsLabel;
	return `${itemsLabel} · ${frames} ${plural(frames, "frame", "frames")}`;
}

// Colours come from the host theme tokens the block-runtime mirrors onto
// `:root` (`@brainstorm-os/sdk/block-runtime` BlockControlKind.Theme); the literal
// fallbacks in each `var(--…, fallback)` only paint before the theme lands / in
// standalone tests. No `prefers-color-scheme` overrides — the active theme (not
// the OS) is the source of truth.
const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; }
.bswb { display: flex; align-items: center; gap: 10px; padding: 10px 12px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--color-text-primary, #1c1c1e); cursor: pointer; }
.bswb:hover { background: var(--color-accent-subtle, rgba(127,127,127,.07)); }
.bswb__icon { flex: 0 0 auto; width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: var(--color-surface-sunken, rgba(127,127,127,.12)); color: var(--color-text-tertiary, #8a8a8e); }
.bswb__icon svg { width: 16px; height: 16px; }
.bswb__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bswb__title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bswb__meta { color: var(--color-text-tertiary, #8a8a8e); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bswb__error { padding: 10px 12px; color: var(--color-text-tertiary, #8a8a8e); }
`;

const ICON_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>';

function injectStyles(doc: Document): void {
	if (doc.getElementById("bswb-styles")) return;
	const style = doc.createElement("style");
	style.id = "bswb-styles";
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

export function bootEmbeddedWhiteboard(ctx: BlockRuntimeContext): void {
	injectStyles(ctx.root.ownerDocument);
	const doc = ctx.root.ownerDocument;

	ctx.onLoad(async () => {
		let board: BpEntity | null = null;
		try {
			board = await ctx.graph<BpEntity>("getEntity", { entityId: ctx.entityId });
		} catch {
			board = null;
		}
		ctx.root.replaceChildren();
		if (!board) {
			ctx.root.className = "";
			const err = doc.createElement("div");
			err.className = "bswb__error";
			err.textContent = "Couldn't load this board.";
			ctx.root.append(err);
			ctx.reportHeight(ctx.root.scrollHeight);
			return;
		}
		renderBoard(ctx, board);
		ctx.reportHeight(ctx.root.scrollHeight);
	});
}

startBlock(bootEmbeddedWhiteboard);

function renderBoard(
	ctx: {
		root: HTMLElement;
		navigate: (id: string, type: string) => void;
	},
	board: BpEntity,
): void {
	const doc = ctx.root.ownerDocument;
	ctx.root.className = "bswb";
	ctx.root.addEventListener("click", () => ctx.navigate(board.entityId, board.entityTypeId));

	const icon = doc.createElement("span");
	icon.className = "bswb__icon";
	const iconSvg = new DOMParser().parseFromString(ICON_SVG, "image/svg+xml").documentElement;
	icon.append(doc.importNode(iconSvg, true));

	const body = doc.createElement("div");
	body.className = "bswb__body";

	const title = doc.createElement("span");
	title.className = "bswb__title";
	title.textContent = boardName(board.properties);
	body.append(title);

	const { items, frames } = summarize(board.properties);
	const meta = doc.createElement("span");
	meta.className = "bswb__meta";
	meta.textContent = summaryLabel(items, frames);
	body.append(meta);

	ctx.root.append(icon, body);
}
