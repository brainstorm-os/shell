/**
 * `io.brainstorm.database/embedded-list` — the live, read-only Database grid
 * that renders inside a host document (e.g. a Notes doc) via the BP block
 * frame. Runs INSIDE the sandboxed opaque-origin iframe: no ambient
 * authority, no `window.brainstorm`; its only channel to the vault is the
 * `@brainstorm-os/sdk/block-runtime` harness (`getEntity` / `queryEntities`
 * over the BP graph module).
 *
 * Data flow: the host hands us the embedded entity id (a `brainstorm/List/v1`).
 * We `getEntity` it for the title + membership, resolve its rows the way the
 * Database app does — source ∪ include \ exclude, then the default view's
 * filter + sort, with the host document as the `$host` context so a
 * contextual filter ("author contains this page") resolves against the page
 * the block sits in (`./resolve-rows.ts`, 9.12.24) — derive a small
 * column set from the rows' properties, resolve any referenced entities'
 * titles, and paint a grid. A row click asks the host to open that entity
 * (`navigate`); a host `refresh` ping re-queries. Pure DOM — no framework in
 * the sandbox. Display heuristics (headers / cell formatting) live in
 * `./format.ts`, shared with the main app's inference + SDK formatters.
 */

import { type BlockRuntimeContext, startBlock } from "@brainstorm-os/sdk/block-runtime";
import { entityTitleOr, resolveEntityTitle } from "@brainstorm-os/sdk/entity-title";
import { createEmbeddedRow } from "./create-row";
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
import { type BpEntity, resolveEmbedded } from "./resolve-rows";
import { t } from "./strings";

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
		const title = resolveEntityTitle(entity.properties) ?? "";
		if (title) titles.set(id, title);
	}
	return titles;
}

// Colours come from the host theme tokens the block-runtime mirrors onto
// `:root` (`@brainstorm-os/sdk/block-runtime` BlockControlKind.Theme); the
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
.bsdb__new { margin-left: auto; font: inherit; font-weight: 500; font-size: 12px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--color-border-subtle, rgba(127,127,127,.24)); background: transparent; color: var(--color-text-secondary, light-dark(#6b6b70, #f7f7f7)); cursor: pointer; }
.bsdb__new:hover { background: var(--color-accent-subtle, rgba(127,127,127,.07)); }
.bsdb__new:disabled { opacity: .6; cursor: default; }
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

	const loadOnce = async (): Promise<void> => {
		try {
			const list = await ctx.graph<BpEntity>("getEntity", { entityId: ctx.entityId });
			const host = ctx.hostEntityId();
			const { rows, view } = await resolveEmbedded(ctx.graph, list, host);
			const columns = deriveColumns(rows);
			const titles = await resolveRefTitles(ctx.graph, collectRefIds(rows, columns));
			renderGrid(ctx.root, list, rows, columns, titles, {
				onOpenRow: (row) => ctx.navigate(row.entityId, row.entityTypeId),
				onNew: async () => {
					const created = await createEmbeddedRow(ctx.graph, list, view, host);
					await load();
					ctx.navigate(created.entityId, created.entityTypeId);
				},
			});
		} catch {
			renderError(ctx.root);
		}
		report();
	};
	// A reload asked for while one is in flight (onLoad + "New" + a host
	// refresh) runs once after it, never as a parallel duplicate resolve.
	let inFlight: Promise<void> | null = null;
	let again = false;
	const load = (): Promise<void> => {
		if (inFlight) {
			again = true;
			return inFlight;
		}
		inFlight = (async () => {
			do {
				again = false;
				await loadOnce();
			} while (again);
		})().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
	ctx.onLoad(load);
}

startBlock(bootEmbeddedList);

function renderGrid(
	root: HTMLElement,
	list: BpEntity,
	rows: BpEntity[],
	columns: string[],
	titles: RefTitles,
	actions: { onOpenRow: (row: BpEntity) => void; onNew: () => Promise<void> },
): void {
	const { onOpenRow } = actions;
	const doc = root.ownerDocument;
	root.replaceChildren();

	const title = doc.createElement("div");
	title.className = "bsdb__title";
	const name = entityTitleOr(list.properties, t("embed.fallbackTitle"));
	title.append(name);
	const count = doc.createElement("span");
	count.className = "bsdb__count";
	count.textContent = `· ${rows.length}`;
	title.append(count);
	const add = doc.createElement("button");
	add.type = "button";
	add.className = "bsdb__new";
	add.textContent = t("embed.new");
	add.setAttribute("aria-label", t("embed.newIn", { name }));
	add.addEventListener("click", () => {
		add.disabled = true;
		actions.onNew().catch(() => {
			add.disabled = false;
			add.textContent = t("embed.createFailed");
		});
	});
	title.append(add);
	root.append(title);

	if (rows.length === 0) {
		const empty = doc.createElement("div");
		empty.className = "bsdb__empty";
		empty.textContent = t("embed.empty");
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
	err.textContent = t("embed.loadFailed");
	root.append(err);
}
