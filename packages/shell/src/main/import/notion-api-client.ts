/**
 * IE-7 rung 2 — the Notion **API client**: paging + guards, no credentials.
 *
 * The one-shot API Source (OQ-243 → (a)) never lets a credential reach this
 * module: it takes an injected {@link NotionTransport} — one
 * `(method, path, body) → {status, json}` call — and `notion-api-transport.ts`
 * binds that to the stored workspace token + Net-1's checked fetch (SSRF guard,
 * size/time caps, per-host audit). Keeping the transport injected also means the
 * whole paging surface is unit-tested without credentials or a network.
 *
 * Everything here is bounded, because the far side is a third party we don't
 * control: every listing stops at {@link NOTION_MAX_PAGE_REQUESTS} requests,
 * a repeated cursor terminates the walk (a buggy/hostile API can't spin us
 * forever), a page's block tree stops at {@link NOTION_MAX_BLOCKS_PER_PAGE} and
 * {@link NOTION_MAX_BLOCK_DEPTH}, and a malformed payload degrades to "no
 * results" rather than throwing mid-import. A non-2xx reply raises a typed
 * {@link NotionApiError} carrying the status so the wizard can say *why*
 * (401 → reconnect, 429 → slow down) instead of "import failed".
 */

import type { NotionBlock } from "./notion-api-blocks";

/** Notion's API version pin — sent by the transport binding, kept here so the
 *  version the client's shapes were written against is visible in one place. */
export const NOTION_API_VERSION = "2022-06-28";

/** Max paged requests per listing (search / database query / block children). */
export const NOTION_MAX_PAGE_REQUESTS = 50;
/** Max blocks collected for a single page, across paging AND descent. */
export const NOTION_MAX_BLOCKS_PER_PAGE = 2000;
/** How deep the block-children walk descends before it stops. */
export const NOTION_MAX_BLOCK_DEPTH = 6;
/** Notion's own maximum page size. */
const PAGE_SIZE = 100;

/** The one call the client needs. Bound to the authenticated Net-1 transport in
 *  production (auth injected there, never here); a stub in tests. */
export type NotionTransport = (req: {
	method: string;
	path: string;
	body?: unknown;
}) => Promise<{ status: number; json: unknown }>;

/** A non-2xx reply from Notion. `status` drives the message the wizard shows. */
export class NotionApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "NotionApiError";
		this.status = status;
	}
}

/** A Notion `page` or `database` object (the fields the importer reads). */
export type NotionObject = {
	readonly id: string;
	readonly object?: string;
	readonly properties?: Record<string, unknown>;
	readonly parent?: { readonly type?: string; readonly [key: string]: unknown };
	readonly title?: readonly unknown[];
	readonly url?: string;
	readonly archived?: boolean;
};

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function messageOf(json: unknown, fallback: string): string {
	const message = (json as { message?: unknown } | null)?.message;
	return typeof message === "string" && message.length > 0 ? message.slice(0, 200) : fallback;
}

async function request(
	transport: NotionTransport,
	method: string,
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const reply = await transport(body === undefined ? { method, path } : { method, path, body });
	if (reply.status < 200 || reply.status >= 300) {
		throw new NotionApiError(
			reply.status,
			messageOf(reply.json, `Notion API returned ${reply.status}`),
		);
	}
	const json = reply.json;
	return json && typeof json === "object" && !Array.isArray(json)
		? (json as Record<string, unknown>)
		: {};
}

/** Walk a Notion cursor-paged endpoint, accumulating `results`. `next(cursor)`
 *  issues one request; the walk stops on `has_more: false`, on a repeated or
 *  missing cursor, at the request cap, or when `limit` results are collected. */
async function paged<T>(
	next: (cursor: string | null) => Promise<Record<string, unknown>>,
	limit = Number.POSITIVE_INFINITY,
): Promise<T[]> {
	const out: T[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | null = null;
	for (let i = 0; i < NOTION_MAX_PAGE_REQUESTS; i++) {
		const payload = await next(cursor);
		for (const item of asArray(payload.results)) {
			out.push(item as T);
			if (out.length >= limit) return out;
		}
		if (payload.has_more !== true) return out;
		const nextCursor = typeof payload.next_cursor === "string" ? payload.next_cursor : null;
		if (!nextCursor || seenCursors.has(nextCursor)) return out;
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
	return out;
}

/** Every page + database the integration has been granted access to. Notion's
 *  `search` with no query returns exactly that — the workspace surface the user
 *  shared, never more. */
export async function searchWorkspace(transport: NotionTransport): Promise<NotionObject[]> {
	return paged<NotionObject>((cursor) =>
		request(transport, "POST", "/v1/search", {
			page_size: PAGE_SIZE,
			...(cursor ? { start_cursor: cursor } : {}),
		}),
	);
}

/** One database's rows (each row is itself a page object). */
export async function queryDatabaseRows(
	transport: NotionTransport,
	databaseId: string,
): Promise<NotionObject[]> {
	return paged<NotionObject>((cursor) =>
		request(transport, "POST", `/v1/databases/${databaseId}/query`, {
			page_size: PAGE_SIZE,
			...(cursor ? { start_cursor: cursor } : {}),
		}),
	);
}

/** One database's schema object (`properties` = its columns). */
export async function retrieveDatabase(
	transport: NotionTransport,
	databaseId: string,
): Promise<NotionObject> {
	const json = await request(transport, "GET", `/v1/databases/${databaseId}`);
	return json as unknown as NotionObject;
}

/**
 * A page's full block tree, ready for {@link notionBlocksToMarkdown}. Children
 * are resolved depth-first within the depth + total-block caps; a child fetch
 * that fails leaves that block childless rather than failing the whole page
 * (a partial body beats no page).
 */
export async function fetchPageBlocks(
	transport: NotionTransport,
	blockId: string,
): Promise<NotionBlock[]> {
	const budget = { left: NOTION_MAX_BLOCKS_PER_PAGE };
	return fetchChildren(transport, blockId, 0, budget);
}

async function fetchChildren(
	transport: NotionTransport,
	blockId: string,
	depth: number,
	budget: { left: number },
): Promise<NotionBlock[]> {
	if (budget.left <= 0) return [];
	const raw = await paged<NotionBlock>(
		(cursor) =>
			request(
				transport,
				"GET",
				`/v1/blocks/${blockId}/children?page_size=${PAGE_SIZE}${
					cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""
				}`,
			),
		budget.left,
	);
	const blocks: NotionBlock[] = [];
	for (const block of raw) {
		if (budget.left <= 0) break;
		budget.left -= 1;
		if (block?.has_children !== true || depth >= NOTION_MAX_BLOCK_DEPTH) {
			blocks.push(block);
			continue;
		}
		const id = typeof block.id === "string" ? block.id : "";
		if (!id) {
			blocks.push(block);
			continue;
		}
		try {
			const children = await fetchChildren(transport, id, depth + 1, budget);
			blocks.push(children.length > 0 ? { ...block, children } : block);
		} catch {
			// A failed sub-fetch costs that block's children, not the page.
			blocks.push(block);
		}
	}
	return blocks;
}
