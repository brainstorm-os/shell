import { describe, expect, it, vi } from "vitest";
import {
	NOTION_MAX_BLOCKS_PER_PAGE,
	NOTION_MAX_PAGE_REQUESTS,
	NotionApiError,
	fetchPageBlocks,
	queryDatabaseRows,
	retrieveDatabase,
	searchWorkspace,
} from "./notion-api-client";

type Reply = { status?: number; json: unknown };

/** A transport stub that replies per `METHOD path` (queued for repeat calls). */
function stubTransport(replies: Record<string, Reply | Reply[]>) {
	const calls: { method: string; path: string; body?: unknown }[] = [];
	const queues = new Map<string, Reply[]>(
		Object.entries(replies).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
	);
	const transport = vi.fn(async (req: { method: string; path: string; body?: unknown }) => {
		calls.push(req);
		const key = `${req.method} ${req.path}`;
		const queue = queues.get(key);
		if (!queue || queue.length === 0) throw new Error(`unexpected request: ${key}`);
		const reply = queue.length > 1 ? (queue.shift() as Reply) : (queue[0] as Reply);
		return { status: reply.status ?? 200, json: reply.json };
	});
	return { transport, calls };
}

const page = (id: string) => ({ id, object: "page", properties: {} });

describe("searchWorkspace", () => {
	it("pages through the cursor until has_more is false", async () => {
		const { transport, calls } = stubTransport({
			"POST /v1/search": [
				{ json: { results: [page("a")], has_more: true, next_cursor: "c1" } },
				{ json: { results: [page("b")], has_more: false, next_cursor: null } },
			],
		});
		const results = await searchWorkspace(transport);
		expect(results.map((r) => r.id)).toEqual(["a", "b"]);
		expect((calls[1]?.body as { start_cursor?: string }).start_cursor).toBe("c1");
	});

	it("stops when the API repeats a cursor (never loops forever)", async () => {
		const { transport } = stubTransport({
			"POST /v1/search": { json: { results: [page("a")], has_more: true, next_cursor: "same" } },
		});
		const results = await searchWorkspace(transport);
		expect(results.length).toBeGreaterThan(0);
		expect(transport.mock.calls.length).toBeLessThanOrEqual(NOTION_MAX_PAGE_REQUESTS + 1);
	});

	it("stops at the request cap even when the API keeps advancing the cursor", async () => {
		let n = 0;
		const transport = vi.fn(async () => {
			n += 1;
			return {
				status: 200,
				json: { results: [page(`p${n}`)], has_more: true, next_cursor: `c${n}` },
			};
		});
		const results = await searchWorkspace(transport);
		expect(transport.mock.calls.length).toBe(NOTION_MAX_PAGE_REQUESTS);
		expect(results).toHaveLength(NOTION_MAX_PAGE_REQUESTS);
	});

	it("raises a typed error on a non-2xx reply, carrying the status", async () => {
		const { transport } = stubTransport({
			"POST /v1/search": { status: 401, json: { message: "API token is invalid." } },
		});
		await expect(searchWorkspace(transport)).rejects.toBeInstanceOf(NotionApiError);
		await expect(searchWorkspace(transport)).rejects.toMatchObject({ status: 401 });
	});

	it("tolerates a malformed payload instead of throwing", async () => {
		const { transport } = stubTransport({ "POST /v1/search": { json: { results: "nope" } } });
		expect(await searchWorkspace(transport)).toEqual([]);
	});
});

describe("queryDatabaseRows", () => {
	it("pages a database's rows", async () => {
		const { transport, calls } = stubTransport({
			"POST /v1/databases/db1/query": [
				{ json: { results: [page("r1")], has_more: true, next_cursor: "c1" } },
				{ json: { results: [page("r2")], has_more: false } },
			],
		});
		const rows = await queryDatabaseRows(transport, "db1");
		expect(rows.map((r) => r.id)).toEqual(["r1", "r2"]);
		expect(calls).toHaveLength(2);
	});
});

describe("retrieveDatabase", () => {
	it("returns the database object", async () => {
		const { transport } = stubTransport({
			"GET /v1/databases/db1": { json: { id: "db1", object: "database", properties: {} } },
		});
		expect((await retrieveDatabase(transport, "db1")).id).toBe("db1");
	});
});

describe("fetchPageBlocks", () => {
	it("pages a block list", async () => {
		const { transport } = stubTransport({
			"GET /v1/blocks/p1/children?page_size=100": {
				json: { results: [{ type: "paragraph" }], has_more: true, next_cursor: "c1" },
			},
			"GET /v1/blocks/p1/children?page_size=100&start_cursor=c1": {
				json: { results: [{ type: "divider" }], has_more: false },
			},
		});
		const blocks = await fetchPageBlocks(transport, "p1");
		expect(blocks.map((b) => b.type)).toEqual(["paragraph", "divider"]);
	});

	it("resolves children of a block that has them", async () => {
		const { transport } = stubTransport({
			"GET /v1/blocks/p1/children?page_size=100": {
				json: {
					results: [{ id: "b1", type: "bulleted_list_item", has_children: true }],
					has_more: false,
				},
			},
			"GET /v1/blocks/b1/children?page_size=100": {
				json: { results: [{ id: "b2", type: "paragraph" }], has_more: false },
			},
		});
		const blocks = await fetchPageBlocks(transport, "p1");
		expect(blocks[0]?.children?.map((c) => c.type)).toEqual(["paragraph"]);
	});

	it("stops descending at the depth cap (a cyclic/deep tree can't hang the import)", async () => {
		// Every block claims a child, forever.
		const transport = vi.fn(async (req: { path: string }) => ({
			status: 200,
			json: {
				results: [{ id: `${req.path.length}`, type: "paragraph", has_children: true }],
				has_more: false,
			},
		}));
		const blocks = await fetchPageBlocks(transport, "p1");
		let depth = 0;
		let node = blocks[0];
		while (node?.children?.[0]) {
			depth += 1;
			node = node.children[0];
		}
		expect(depth).toBeLessThanOrEqual(8);
	});

	it("stops at the per-page block cap", async () => {
		const many = Array.from({ length: 120 }, () => ({ type: "paragraph" }));
		const transport = vi.fn(async () => ({
			status: 200,
			json: { results: many, has_more: true, next_cursor: `c${Math.random()}` },
		}));
		const blocks = await fetchPageBlocks(transport, "p1");
		expect(blocks.length).toBeLessThanOrEqual(NOTION_MAX_BLOCKS_PER_PAGE);
	});

	it("degrades to the blocks it already has when a child fetch fails", async () => {
		const { transport } = stubTransport({
			"GET /v1/blocks/p1/children?page_size=100": {
				json: { results: [{ id: "b1", type: "paragraph", has_children: true }], has_more: false },
			},
			"GET /v1/blocks/b1/children?page_size=100": { status: 502, json: {} },
		});
		const blocks = await fetchPageBlocks(transport, "p1");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.children).toBeUndefined();
	});
});
