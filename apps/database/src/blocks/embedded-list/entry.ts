/**
 * `io.brainstorm.database/embedded-list` — the live, read-only Database grid
 * that renders inside a host document (e.g. a Notes doc) via the BP block
 * frame. Runs INSIDE the sandboxed opaque-origin iframe: no ambient
 * authority, no `window.brainstorm`; its only channel to the vault is the
 * `@brainstorm/sdk/block-runtime` harness (`getEntity` / `queryEntities`
 * over the BP graph module).
 *
 * Data flow: the host hands us the embedded entity id (a `brainstorm/List/v1`).
 * We `getEntity` it for the title + membership, resolve its rows (explicit
 * `members.include`, else a type query against `source`), derive a small
 * column set from the rows' properties, resolve any referenced entities'
 * titles, and paint a grid. A row click asks the host to open that entity
 * (`navigate`); a host `refresh` ping re-queries. Pure DOM — no framework in
 * the sandbox. Display heuristics (headers / cell formatting) live in
 * `./format.ts`, shared with the main app's inference + SDK formatters.
 */

import { type BlockRuntimeContext, startBlock } from "@brainstorm/sdk/block-runtime";
import {
	EMPTY_REF_TITLES,
	MAX_ROWS,
	type RefTitles,
	collectRefIds,
	columnLabels,
	deriveColumns,
	formatCell,
	plainText,
} from "./format";

interface BpEntity {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

interface QueryResult {
	results?: { vertices?: Record<string, [BpEntity]> };
}

function asId(member: unknown): string | null {
	if (typeof member === "string") return member;
	if (member && typeof member === "object") {
		const id =
			(member as { id?: unknown; entityId?: unknown }).id ??
			(member as { entityId?: unknown }).entityId;
		if (typeof id === "string") return id;
	}
	return null;
}

/** Best-effort read of a type id from a List's `source` object (the
 *  type-derived list case). Defensive: the shape is app-internal and may
 *  evolve, so unknown shapes resolve to null (→ empty grid, not a throw). */
function sourceType(list: BpEntity): string | null {
	const source = list.properties.source as
		| { type?: unknown; query?: { type?: unknown } }
		| null
		| undefined;
	if (!source || typeof source !== "object") return null;
	if (typeof source.type === "string") return source.type;
	if (source.query && typeof source.query.type === "string") return source.query.type;
	return null;
}

async function resolveRows(
	graph: <T>(m: string, d: unknown) => Promise<T>,
	list: BpEntity,
): Promise<BpEntity[]> {
	const members = (list.properties.members as { include?: unknown } | undefined)?.include;
	if (Array.isArray(members) && members.length > 0) {
		const ids = members
			.map(asId)
			.filter((x): x is string => x !== null)
			.slice(0, MAX_ROWS);
		const got = await Promise.all(
			ids.map((entityId) => graph<BpEntity>("getEntity", { entityId }).catch(() => null)),
		);
		return got.filter((x): x is BpEntity => x !== null);
	}
	const type = sourceType(list);
	if (type) {
		const res = await graph<QueryResult>("queryEntities", { operation: { entityTypeId: type } });
		const vertices = res.results?.vertices ?? {};
		return Object.values(vertices)
			.map((v) => v[0])
			.slice(0, MAX_ROWS);
	}
	return [];
}

/** Resolve stored ref-like ids to their entities' titles via the graph.
 *  Entity ids (`ent_…`) resolve; catalog ids (`di_…` dictionary options the
 *  jail has no dictionary for) fail their `getEntity` and stay unresolved —
 *  the formatter renders those as a neutral placeholder, never the raw id. */
async function resolveRefTitles(
	graph: <T>(m: string, d: unknown) => Promise<T>,
	ids: readonly string[],
): Promise<RefTitles> {
	if (ids.length === 0) return EMPTY_REF_TITLES;
	const titles = new Map<string, string>();
	const got = await Promise.all(
		ids.map((entityId) => graph<BpEntity>("getEntity", { entityId }).catch(() => null)),
	);
	for (let i = 0; i < ids.length; i += 1) {
		const entity = got[i];
		const id = ids[i];
		if (!entity || id === undefined) continue;
		const title = plainText(entity.properties.name) || plainText(entity.properties.title);
		if (title) titles.set(id, title);
	}
	return titles;
}

// Colours come from the host theme tokens the block-runtime mirrors onto
// `:root` (`@brainstorm/sdk/block-runtime` BlockControlKind.Theme); the
// `light-dark()` fallbacks only paint before the theme lands / in standalone
// tests, and follow `prefers-color-scheme` via the `color-scheme: light dark`
// default below (the host's pushed `color-scheme` overrides it inline). The
// fallback pairs are sampled from packages/tokens default light/dark themes.
// No `@media (prefers-color-scheme)` overrides — a hardcoded media rule would
// beat the live token vars; `light-dark()` inside the fallback slot loses to
// them, which is the point.
const STYLES = `
* { box-sizing: border-box; }
:root { color-scheme: light dark; }
body { margin: 0; }
.bsdb { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--color-text-primary, light-dark(#1c1c1e, #f7f7f7)); }
.bsdb__title { font-weight: 600; font-size: 13px; padding: 8px 12px 6px; display: flex; align-items: center; gap: 8px; }
.bsdb__count { color: var(--color-text-tertiary, light-dark(#8a8a8e, rgba(247,247,247,.62))); font-weight: 400; }
.bsdb__scroll { overflow-x: auto; border-top: 1px solid var(--color-border-subtle, rgba(127,127,127,.16)); }
.bsdb__table { border-collapse: collapse; width: 100%; }
.bsdb__th { text-align: left; font-weight: 600; color: var(--color-text-secondary, light-dark(#6b6b70, #f7f7f7)); padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid var(--color-border-subtle, rgba(127,127,127,.16)); position: sticky; top: 0; background: var(--color-background-subtle, rgba(127,127,127,.04)); }
.bsdb__td { padding: 8px 12px; border-bottom: 1px solid var(--color-border-subtle, rgba(127,127,127,.1)); white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.bsdb__row { cursor: pointer; }
.bsdb__row:hover { background: var(--color-accent-subtle, rgba(127,127,127,.07)); }
.bsdb__ref { color: var(--color-text-tertiary, light-dark(#8a8a8e, rgba(247,247,247,.62))); font-style: italic; }
.bsdb__empty, .bsdb__error { padding: 16px 12px; color: var(--color-text-tertiary, light-dark(#8a8a8e, rgba(247,247,247,.62))); }
.bsdb__error { color: var(--color-state-error, light-dark(#dc2626, #f87171)); }
`;

function injectStyles(doc: Document): void {
	if (doc.getElementById("bsdb-styles")) return;
	const style = doc.createElement("style");
	style.id = "bsdb-styles";
	style.textContent = STYLES;
	doc.head.appendChild(style);
}

export function bootEmbeddedList(ctx: BlockRuntimeContext): void {
	injectStyles(ctx.root.ownerDocument);
	ctx.root.className = "bsdb";

	const report = (): void => ctx.reportHeight(ctx.root.scrollHeight);

	ctx.onLoad(async () => {
		try {
			const list = await ctx.graph<BpEntity>("getEntity", { entityId: ctx.entityId });
			const rows = await resolveRows(ctx.graph, list);
			const columns = deriveColumns(rows);
			const titles = await resolveRefTitles(ctx.graph, collectRefIds(rows, columns));
			renderGrid(ctx.root, list, rows, columns, titles, (row) =>
				ctx.navigate(row.entityId, row.entityTypeId),
			);
		} catch {
			renderError(ctx.root);
		}
		report();
	});
}

startBlock(bootEmbeddedList);

function renderGrid(
	root: HTMLElement,
	list: BpEntity,
	rows: BpEntity[],
	columns: string[],
	titles: RefTitles,
	onOpenRow: (row: BpEntity) => void,
): void {
	const doc = root.ownerDocument;
	root.replaceChildren();

	const title = doc.createElement("div");
	title.className = "bsdb__title";
	const name = plainText(list.properties.name) || plainText(list.properties.title) || "Database";
	title.append(name);
	const count = doc.createElement("span");
	count.className = "bsdb__count";
	count.textContent = `· ${rows.length}`;
	title.append(count);
	root.append(title);

	if (rows.length === 0) {
		const empty = doc.createElement("div");
		empty.className = "bsdb__empty";
		empty.textContent = "No items yet";
		root.append(empty);
		return;
	}

	const labels = columnLabels(columns, rows);
	const scroll = doc.createElement("div");
	scroll.className = "bsdb__scroll";
	const table = doc.createElement("table");
	table.className = "bsdb__table";

	const thead = doc.createElement("thead");
	const headRow = doc.createElement("tr");
	for (const label of labels) {
		const th = doc.createElement("th");
		th.className = "bsdb__th";
		th.textContent = label;
		headRow.append(th);
	}
	thead.append(headRow);
	table.append(thead);

	const tbody = doc.createElement("tbody");
	for (const row of rows) {
		const tr = doc.createElement("tr");
		tr.className = "bsdb__row";
		tr.addEventListener("click", () => onOpenRow(row));
		for (const key of columns) {
			const td = doc.createElement("td");
			td.className = "bsdb__td";
			const display = formatCell(key, row.properties[key], titles);
			if (display.placeholder) td.classList.add("bsdb__ref");
			td.textContent = display.text;
			tr.append(td);
		}
		tbody.append(tr);
	}
	table.append(tbody);
	scroll.append(table);
	root.append(scroll);
}

function renderError(root: HTMLElement): void {
	const doc = root.ownerDocument;
	root.replaceChildren();
	const err = doc.createElement("div");
	err.className = "bsdb__error";
	err.textContent = "Couldn't load this database.";
	root.append(err);
}
