// @vitest-environment jsdom
import type { BlockRuntimeContext } from "@brainstorm-os/sdk/block-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootEmbeddedList } from "./entry";
import {
	EMPTY_REF_TITLES,
	MAX_REF_LOOKUPS,
	collectRefIds,
	columnLabels,
	deriveColumns,
	formatCell,
	isOpaqueKey,
	isRefLikeId,
} from "./format";

const LIST_TYPE = "brainstorm/List/v1";
const ROW_TYPE = "io.brainstorm.crm/Client/v1";

function row(id: string, props: Record<string, unknown>) {
	return { entityId: id, entityTypeId: ROW_TYPE, properties: props, updatedAt: 1 };
}

/** Build a fake context whose `getEntity`/`queryEntities` are served from a
 *  fixture map, and capture the load callback so the test can run it. */
function makeCtx(opts: {
	list: unknown;
	rowsById?: Record<string, unknown>;
	queryRows?: unknown[];
	hostEntityId?: string | null;
}): {
	root: HTMLElement;
	navigate: ReturnType<typeof vi.fn>;
	queries: Array<string | undefined>;
	run(): Promise<void>;
} {
	const queries: Array<string | undefined> = [];
	const root = document.createElement("div");
	document.body.appendChild(root);
	const navigate = vi.fn();
	let loader: (() => void | Promise<void>) | null = null;
	const graph = (async (messageName: string, data: unknown) => {
		if (messageName === "getEntity") {
			const id = (data as { entityId: string }).entityId;
			if (id === "list-1") return opts.list;
			const r = opts.rowsById?.[id];
			if (!r) throw new Error("not found");
			return r;
		}
		if (messageName === "queryEntities") {
			const type = (data as { operation: { entityTypeId?: string } }).operation.entityTypeId;
			queries.push(type);
			const vertices: Record<string, [unknown]> = {};
			for (const r of opts.queryRows ?? []) {
				const e = r as { entityId: string; entityTypeId: string };
				if (type === undefined || e.entityTypeId === type) vertices[e.entityId] = [r];
			}
			return { results: { vertices } };
		}
		return null;
	}) as unknown as <T>(m: string, d: unknown) => Promise<T>;
	const ctx = {
		entityId: "list-1",
		capabilities: () => [],
		hostEntityId: () => opts.hostEntityId ?? null,
		root,
		graph,
		navigate,
		reportHeight: vi.fn(),
		onLoad: (run: () => void | Promise<void>) => {
			loader = run;
		},
	} satisfies BlockRuntimeContext;
	bootEmbeddedList(ctx);
	return { root, navigate, queries, run: async () => loader?.() };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("embedded-list (database grid) block", () => {
	it("renders a grid from explicit members.include with derived columns", async () => {
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: { name: "Clients", members: { include: ["c1", "c2"], exclude: [] } },
				updatedAt: 1,
			},
			rowsById: {
				c1: row("c1", { name: "Acme", tier: "A", status: "Live" }),
				c2: row("c2", { name: "Beta", tier: "B", status: "Lead" }),
			},
		});
		await h.run();
		expect(h.root.querySelector(".bsdb__title")?.textContent).toContain("Clients");
		expect(h.root.querySelectorAll(".bsdb__row")).toHaveLength(2);
		const headers = [...h.root.querySelectorAll(".bsdb__th")].map((n) => n.textContent);
		expect(headers).toContain("Name");
		expect(h.root.textContent).toContain("Acme");
		expect(h.root.textContent).toContain("Lead");
	});

	it("resolves rows via a type source when membership is empty", async () => {
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: {
					name: "All clients",
					members: { include: [], exclude: [] },
					source: { type: ROW_TYPE },
				},
				updatedAt: 1,
			},
			queryRows: [row("c1", { name: "Acme" }), row("c2", { name: "Beta" })],
		});
		await h.run();
		expect(h.root.querySelectorAll(".bsdb__row")).toHaveLength(2);
	});

	it("clicking a row navigates to that entity", async () => {
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: { name: "Clients", members: { include: ["c1"], exclude: [] } },
				updatedAt: 1,
			},
			rowsById: { c1: row("c1", { name: "Acme" }) },
		});
		await h.run();
		h.root.querySelector<HTMLElement>(".bsdb__row")?.click();
		expect(h.navigate).toHaveBeenCalledWith("c1", ROW_TYPE);
	});

	it("shows an empty state for a list with no resolvable rows", async () => {
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: { name: "Empty", members: { include: [], exclude: [] } },
				updatedAt: 1,
			},
		});
		await h.run();
		expect(h.root.querySelector(".bsdb__empty")).not.toBeNull();
		expect(h.root.querySelectorAll(".bsdb__row")).toHaveLength(0);
	});

	it("shows an error when the list entity can't be loaded", async () => {
		const root = document.createElement("div");
		document.body.appendChild(root);
		const held: { loader: (() => void | Promise<void>) | null } = { loader: null };
		const ctx = {
			entityId: "list-1",
			capabilities: () => [],
			root,
			hostEntityId: () => null,
			graph: (async () => {
				throw new Error("denied");
			}) as unknown as <T>(m: string, d: unknown) => Promise<T>,
			navigate: vi.fn(),
			reportHeight: vi.fn(),
			onLoad: (run: () => void | Promise<void>) => {
				held.loader = run;
			},
		} satisfies BlockRuntimeContext;
		bootEmbeddedList(ctx);
		await held.loader?.();
		expect(root.querySelector(".bsdb__error")).not.toBeNull();
	});

	it("labels minted opaque property keys by inferred type, never the raw id (F-210)", async () => {
		const dateMs = 1780963200000; // 2026-06-08T00:00:00Z
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: { name: "Clients", members: { include: ["c1", "c2"], exclude: [] } },
				updatedAt: 1,
			},
			rowsById: {
				c1: row("c1", { name: "Acme", prop_mpye0tff_8acd19: dateMs }),
				c2: row("c2", { name: "Beta", prop_mpye0tff_8acd19: dateMs }),
			},
		});
		await h.run();
		const headers = [...h.root.querySelectorAll(".bsdb__th")].map((n) => n.textContent);
		expect(headers).toEqual(["Name", "Date"]);
		expect(h.root.textContent).not.toContain("mpye0tff");
	});

	it("formats epoch-ms date values through the shared date formatter (F-210)", async () => {
		const dateMs = 1780963200000;
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: { name: "Clients", members: { include: ["c1"], exclude: [] } },
				updatedAt: 1,
			},
			rowsById: { c1: row("c1", { name: "Acme", dueDate: dateMs }) },
		});
		await h.run();
		expect(h.root.textContent).not.toContain(String(dateMs));
		expect(h.root.textContent).toContain("2026");
		const headers = [...h.root.querySelectorAll(".bsdb__th")].map((n) => n.textContent);
		expect(headers).toContain("Due date");
	});

	it("resolves entity-ref ids to the referenced entity's title via the graph (F-210)", async () => {
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: { name: "Deals", members: { include: ["c1"], exclude: [] } },
				updatedAt: 1,
			},
			rowsById: {
				c1: row("c1", { name: "Acme deal", prop_mpye2ond_2etq7m: "ent_mpyebi7o82fbln" }),
				ent_mpyebi7o82fbln: row("ent_mpyebi7o82fbln", { name: "Northbound" }),
			},
		});
		await h.run();
		expect(h.root.textContent).toContain("Northbound");
		expect(h.root.textContent).not.toContain("ent_mpyebi7o82fbln");
		const headers = [...h.root.querySelectorAll(".bsdb__th")].map((n) => n.textContent);
		expect(headers).toContain("Reference");
	});

	it("renders a neutral placeholder for unresolvable ref ids, never the raw id (F-210)", async () => {
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: { name: "Deals", members: { include: ["c1"], exclude: [] } },
				updatedAt: 1,
			},
			rowsById: {
				c1: row("c1", { name: "Acme deal", prop_mpye2ond_2etq7m: "di_mpyebi7o_82fbln" }),
			},
		});
		await h.run();
		expect(h.root.textContent).toContain("1 reference");
		expect(h.root.textContent).not.toContain("di_mpyebi7o_82fbln");
		expect(h.root.querySelector(".bsdb__ref")).not.toBeNull();
	});

	it("injects scheme-aware styles: color-scheme default + light-dark token fallbacks (F-210)", async () => {
		const h = makeCtx({
			list: {
				entityId: "list-1",
				entityTypeId: LIST_TYPE,
				properties: { name: "Clients", members: { include: [], exclude: [] } },
				updatedAt: 1,
			},
		});
		await h.run();
		const css = document.getElementById("bsdb-styles")?.textContent ?? "";
		// Pre-theme paint follows the OS scheme; the host's pushed theme
		// (inline `color-scheme` + token vars) overrides both.
		expect(css).toContain(":root { color-scheme: light dark; }");
		expect(css).toMatch(/var\(--color-text-primary,\s*light-dark\(/);
		expect(css).toMatch(/var\(--color-state-error,\s*light-dark\(/);
		expect(css).not.toMatch(/@media\s*\(prefers-color-scheme/);
	});
});

describe("embedded-list contextual views (9.12.24)", () => {
	const BOOK = "io.test/Book/v1";
	const VIEW_TYPE = "brainstorm/ListView/v1";
	const book = (id: string, author: unknown) => ({
		entityId: id,
		entityTypeId: BOOK,
		properties: { name: id, author },
		updatedAt: 1,
	});
	const list = (extra: Record<string, unknown> = {}) => ({
		entityId: "list-1",
		entityTypeId: LIST_TYPE,
		properties: {
			name: "Books",
			source: { kind: "byType", types: [BOOK] },
			members: { include: [], exclude: [] },
			defaultViewId: "view-1",
			...extra,
		},
		updatedAt: 1,
	});
	const view = (filters: unknown, extra: Record<string, unknown> = {}) => ({
		entityId: "view-1",
		entityTypeId: VIEW_TYPE,
		properties: { listId: "list-1", kind: "grid", filters, sorts: [], columns: [], ...extra },
		updatedAt: 1,
	});
	const hostFilter = {
		kind: "predicate",
		predicate: { $contains: { author: { $host: true } } },
	};
	const books = [book("b1", ["page-1"]), book("b2", ["page-2"]), book("b3", ["page-1", "page-2"])];
	const rowNames = (root: HTMLElement) =>
		[...root.querySelectorAll(".bsdb__row")].map((r) => r.querySelector(".bsdb__td")?.textContent);

	it("filters rows by the host document through the default view", async () => {
		const h = makeCtx({
			list: list(),
			queryRows: [...books, view(hostFilter)],
			hostEntityId: "page-1",
		});
		await h.run();
		expect(rowNames(h.root)).toEqual(["b1", "b3"]);
	});

	it("a host-relative view with no host shows nothing, never everything", async () => {
		const h = makeCtx({ list: list(), queryRows: [...books, view(hostFilter)] });
		await h.run();
		expect(h.root.querySelectorAll(".bsdb__row")).toHaveLength(0);
		expect(h.root.querySelector(".bsdb__empty")).not.toBeNull();
	});

	it("honours member excludes and a byFilter source with $host", async () => {
		const h = makeCtx({
			list: list({
				source: { kind: "byFilter", where: { $contains: { author: { $host: true } } } },
				members: { include: [], exclude: [{ entityId: "b3" }] },
			}),
			queryRows: books,
			hostEntityId: "page-2",
		});
		await h.run();
		expect(rowNames(h.root)).toEqual(["b2"]);
	});

	it("fetches the List's own view by id instead of scanning every ListView", async () => {
		const h = makeCtx({
			list: list(),
			rowsById: { "view-1": view(hostFilter) },
			queryRows: books,
			hostEntityId: "page-1",
		});
		await h.run();
		expect(rowNames(h.root)).toEqual(["b1", "b3"]);
		expect(h.queries).toEqual([BOOK]);
	});

	it("applies the view sort", async () => {
		const h = makeCtx({
			list: list(),
			queryRows: [
				...books,
				view(null, { sorts: [{ propertyId: "name", direction: "desc", emptyPlacement: "end" }] }),
			],
		});
		await h.run();
		expect(rowNames(h.root)).toEqual(["b3", "b2", "b1"]);
	});
});

describe("embedded-list format helpers (pure)", () => {
	it("classifies minted keys and ref-like ids", () => {
		expect(isOpaqueKey("prop_mpye0tff_8acd19")).toBe(true);
		expect(isOpaqueKey("dueDate")).toBe(false);
		expect(isOpaqueKey("status")).toBe(false);
		expect(isRefLikeId("ent_mpyebi7o82fbln")).toBe(true);
		expect(isRefLikeId("di_mpyebi7o_82fbln")).toBe(true);
		expect(isRefLikeId("dict_mpye0tff_8acd19")).toBe(true);
		expect(isRefLikeId("Acme Corp")).toBe(false);
		expect(isRefLikeId("entirely normal text")).toBe(false);
	});

	it("dedupes repeated type-derived headers", () => {
		const rows = [{ properties: { prop_a1_b1: 1780963200000, prop_a2_b2: 1781049600000 } }];
		expect(columnLabels(["prop_a1_b1", "prop_a2_b2"], rows)).toEqual(["Date", "Date 2"]);
	});

	it("labels opaque columns with no typeable value as Property", () => {
		const rows = [{ properties: { prop_a1_b1: { nested: true } } }];
		expect(columnLabels(["prop_a1_b1"], rows)).toEqual(["Property"]);
	});

	it("prefers legible keys over opaque ones at equal frequency when trimming columns", () => {
		const properties: Record<string, unknown> = { name: "x" };
		for (let i = 0; i < 5; i += 1) properties[`prop_a${i}_b${i}`] = i;
		properties.status = "Live";
		properties.owner = "Mira";
		const cols = deriveColumns([{ properties }]);
		expect(cols).toHaveLength(6);
		expect(cols[0]).toBe("name");
		expect(cols).toContain("status");
		expect(cols).toContain("owner");
	});

	it("formats cells: booleans, numbers, dates, arrays", () => {
		expect(formatCell("done", true, EMPTY_REF_TITLES).text).toBe("Yes");
		expect(formatCell("count", 1234, EMPTY_REF_TITLES).text).toBe((1234).toLocaleString());
		const date = formatCell("when", 1780963200000, EMPTY_REF_TITLES);
		expect(date.text).toContain("2026");
		expect(date.placeholder).toBe(false);
		expect(formatCell("tags", ["a", "b"], EMPTY_REF_TITLES).text).toBe("a, b");
	});

	it("collapses an all-unresolved ref array to a counted placeholder", () => {
		const out = formatCell("refs", ["di_aaa1_bbb1", "di_aaa2_bbb2"], EMPTY_REF_TITLES);
		expect(out.text).toBe("2 references");
		expect(out.placeholder).toBe(true);
	});

	it("resolves ref ids through the titles map", () => {
		const titles = new Map([["ent_mpyebi7o82fbln", "Northbound"]]);
		const out = formatCell("client", "ent_mpyebi7o82fbln", titles);
		expect(out.text).toBe("Northbound");
		expect(out.placeholder).toBe(false);
	});

	it("collects unique ref ids from visible columns, capped", () => {
		const rows = [
			{ properties: { a: "ent_aaaaaa1", b: ["ent_aaaaaa1", "di_x1_y1"], c: "plain" } },
			{ properties: { a: "ent_aaaaaa2" } },
		];
		expect(collectRefIds(rows, ["a", "b"]).sort()).toEqual([
			"di_x1_y1",
			"ent_aaaaaa1",
			"ent_aaaaaa2",
		]);
		const many = [
			{
				properties: {
					a: Array.from({ length: MAX_REF_LOOKUPS + 20 }, (_, i) => `ent_ref${i}aaa`),
				},
			},
		];
		expect(collectRefIds(many, ["a"])).toHaveLength(MAX_REF_LOOKUPS);
	});
});
