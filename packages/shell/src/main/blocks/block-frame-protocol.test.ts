/**
 * `bsblock://` protocol handler — serves a block's document with its OWN CSP
 * (escaping the embedder's). Pure-function tests via `serveBlockFrameRequest`;
 * electron's `protocol` is mocked so the module imports under vitest.
 */

import { BLOCK_FRAME_CSP } from "@brainstorm-os/sdk/block-frame";
import { describe, expect, it, vi } from "vitest";
import type { BlocksRepository } from "../storage/registry-repo/blocks-repo";

vi.mock("electron", () => ({ protocol: { handle: () => {} } }));

const { serveBlockFrameRequest } = await import("./block-frame-protocol");

function repoWith(sources: Record<string, string>): BlocksRepository {
	return { getSource: (id: string) => sources[id] ?? null } as unknown as BlocksRepository;
}

const present = {
	getBlocksRepo: async () => repoWith({ "io.example.db/grid": "/* bundle */ void 0;" }),
};
const noSession = { getBlocksRepo: async () => null };

function url(params: Record<string, string>, host = "frame"): string {
	return `bsblock://${host}/?${new URLSearchParams(params).toString()}`;
}

describe("serveBlockFrameRequest", () => {
	it("serves the block document with the block-frame CSP header", async () => {
		const res = await serveBlockFrameRequest(
			url({ b: "io.example.db/grid", c: "chan-1", e: "ent-1" }),
			present,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("content-security-policy")).toBe(BLOCK_FRAME_CSP);
		const body = await res.text();
		expect(body).toContain("/* bundle */ void 0;");
		expect(body).toContain("chan-1");
		expect(body).toContain("ent-1");
	});

	it("404s an unknown host", async () => {
		const res = await serveBlockFrameRequest(
			url({ b: "io.example.db/grid", c: "c", e: "e" }, "other"),
			present,
		);
		expect(res.status).toBe(404);
	});

	it("404s an unregistered block (no bundle)", async () => {
		const res = await serveBlockFrameRequest(
			url({ b: "io.example.db/missing", c: "c", e: "e" }),
			present,
		);
		expect(res.status).toBe(404);
	});

	it("404s when no vault session is active", async () => {
		const res = await serveBlockFrameRequest(
			url({ b: "io.example.db/grid", c: "c", e: "e" }),
			noSession,
		);
		expect(res.status).toBe(404);
	});

	it("400s a malformed blockId or missing routing params", async () => {
		for (const params of [
			{ b: "no-slash", c: "c", e: "e" },
			{ b: "io.example.db/grid", c: "", e: "e" },
			{ b: "io.example.db/grid", c: "c", e: "" },
			{ b: "", c: "c", e: "e" },
		]) {
			const res = await serveBlockFrameRequest(url(params), present);
			expect(res.status).toBe(400);
		}
	});
});
