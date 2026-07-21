/**
 * `io.brainstorm.graph/embedded-graph` — a saved Graph (a pattern filter +
 * its views), rendered inline in a host document (e.g. a Notes doc) via the
 * BP block frame. Shows the graph's name plus a shape summary ("3 subjects ·
 * 2 connections · 1 view"); a click opens it in the Graph app. Read-only — a
 * graph's pattern is edited in the app. Runs INSIDE the sandboxed
 * opaque-origin iframe (no ambient authority, no `window.brainstorm`); its
 * only channel to the vault is the `@brainstorm-os/sdk/block-runtime` harness
 * (`getEntity` over the BP graph module). Pure DOM — no framework, no SDK
 * i18n: the bundle is a single self-contained IIFE inlined into the frame's
 * srcdoc, so it carries its own literals (mirrors `embedded-whiteboard` /
 * `embedded-list`).
 *
 * Why a summary card and not a live force-layout render: the graph's renderer
 * is a Pixi stage with a force-simulation worker that assumes the full app
 * shell (camera, instruments, pattern toolbar). A doc embed is a preview + an
 * "open" affordance, mirroring the whiteboard `embedded-whiteboard` block. The
 * `pattern` shape (subjects, edges) + `views` is enough to identify the graph
 * at a glance.
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

function graphName(props: Record<string, unknown>): string {
	const name = str(props.name);
	return name.length > 0 ? name : "Untitled graph";
}

/** Count the pattern's subjects + connections and the saved views from the
 *  inlined `pattern` / `views`. `pattern.subjects` is a binding map (object),
 *  `pattern.edges` is an array; `views` is a string array. Defensive against
 *  missing / malformed shapes (→ zeros, not a throw). */
function summarize(props: Record<string, unknown>): {
	subjects: number;
	connections: number;
	views: number;
} {
	const pattern = props.pattern;
	let subjects = 0;
	let connections = 0;
	if (pattern && typeof pattern === "object") {
		const p = pattern as { subjects?: unknown; edges?: unknown };
		if (p.subjects && typeof p.subjects === "object") {
			subjects = Object.keys(p.subjects as Record<string, unknown>).length;
		}
		if (Array.isArray(p.edges)) connections = p.edges.length;
	}
	const views = Array.isArray(props.views) ? props.views.length : 0;
	return { subjects, connections, views };
}

function plural(count: number, one: string, other: string): string {
	return count === 1 ? one : other;
}

function summaryLabel(subjects: number, connections: number, views: number): string {
	const parts = [
		`${subjects} ${plural(subjects, "subject", "subjects")}`,
		`${connections} ${plural(connections, "connection", "connections")}`,
	];
	if (views > 0) parts.push(`${views} ${plural(views, "view", "views")}`);
	return parts.join(" · ");
}

// Colours come from the host theme tokens the block-runtime mirrors onto
// `:root` (`@brainstorm-os/sdk/block-runtime` BlockControlKind.Theme); the literal
// fallbacks in each `var(--…, fallback)` only paint before the theme lands / in
// standalone tests. No `prefers-color-scheme` overrides — the active theme (not
// the OS) is the source of truth.
const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; }
.bsgr { display: flex; align-items: center; gap: 10px; padding: 10px 12px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--color-text-primary, #1c1c1e); cursor: pointer; }
.bsgr:hover { background: var(--color-accent-subtle, rgba(127,127,127,.07)); }
.bsgr__icon { flex: 0 0 auto; width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: var(--color-surface-sunken, rgba(127,127,127,.12)); color: var(--color-text-tertiary, #8a8a8e); }
.bsgr__icon svg { width: 16px; height: 16px; }
.bsgr__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bsgr__title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsgr__meta { color: var(--color-text-tertiary, #8a8a8e); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsgr__error { padding: 10px 12px; color: var(--color-text-tertiary, #8a8a8e); }
`;

const ICON_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M6.9 7.4 11 16M17.1 7.4 13 16M7 6h10"/></svg>';

function injectStyles(doc: Document): void {
	if (doc.getElementById("bsgr-styles")) return;
	const style = doc.createElement("style");
	style.id = "bsgr-styles";
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

export function bootEmbeddedGraph(ctx: BlockRuntimeContext): void {
	injectStyles(ctx.root.ownerDocument);
	const doc = ctx.root.ownerDocument;

	ctx.onLoad(async () => {
		let graph: BpEntity | null = null;
		try {
			graph = await ctx.graph<BpEntity>("getEntity", { entityId: ctx.entityId });
		} catch {
			graph = null;
		}
		ctx.root.replaceChildren();
		if (!graph) {
			ctx.root.className = "";
			const err = doc.createElement("div");
			err.className = "bsgr__error";
			err.textContent = "Couldn't load this graph.";
			ctx.root.append(err);
			ctx.reportHeight(ctx.root.scrollHeight);
			return;
		}
		renderGraph(ctx, graph);
		ctx.reportHeight(ctx.root.scrollHeight);
	});
}

startBlock(bootEmbeddedGraph);

function renderGraph(
	ctx: {
		root: HTMLElement;
		navigate: (id: string, type: string) => void;
	},
	graph: BpEntity,
): void {
	const doc = ctx.root.ownerDocument;
	ctx.root.className = "bsgr";
	ctx.root.addEventListener("click", () => ctx.navigate(graph.entityId, graph.entityTypeId));

	const icon = doc.createElement("span");
	icon.className = "bsgr__icon";
	const iconSvg = new DOMParser().parseFromString(ICON_SVG, "image/svg+xml").documentElement;
	icon.append(doc.importNode(iconSvg, true));

	const body = doc.createElement("div");
	body.className = "bsgr__body";

	const title = doc.createElement("span");
	title.className = "bsgr__title";
	title.textContent = graphName(graph.properties);
	body.append(title);

	const { subjects, connections, views } = summarize(graph.properties);
	const meta = doc.createElement("span");
	meta.className = "bsgr__meta";
	meta.textContent = summaryLabel(subjects, connections, views);
	body.append(meta);

	ctx.root.append(icon, body);
}
