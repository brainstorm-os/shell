// @vitest-environment jsdom
import {
	BLOCK_FRAME_BOOTSTRAP_GLOBAL,
	BLOCK_FRAME_ROOT_ID,
	type BlockFrameEnvelope,
	BlockFrameMessageDirection,
	BlockFrameMessageKind,
} from "@brainstorm-os/sdk/block-frame";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BlockRuntimeContext, startBlock } from "./index";

const CHANNEL = "chan-test";
const ENTITY = "ent-db";

interface Harness {
	win: Window;
	parent: Pick<Window, "postMessage">;
	deliver(payload: unknown, kind?: BlockFrameMessageKind): void;
	outbound(): unknown[];
}

function makeHarness(): Harness {
	let handler: EventListener | null = null;
	const post = vi.fn();
	const parent = { postMessage: post } as unknown as Pick<Window, "postMessage">;
	const root = document.createElement("div");
	root.id = BLOCK_FRAME_ROOT_ID;
	document.body.appendChild(root);
	const win = {
		document,
		addEventListener: (_t: string, h: EventListener) => {
			handler = h;
		},
		removeEventListener: () => {
			handler = null;
		},
	} as unknown as Window;
	(win as unknown as Record<string, unknown>)[BLOCK_FRAME_BOOTSTRAP_GLOBAL] = {
		channelId: CHANNEL,
		entityId: ENTITY,
	};
	return {
		win,
		parent,
		deliver(payload, kind = BlockFrameMessageKind.Message): void {
			const env: BlockFrameEnvelope = {
				channelId: CHANNEL,
				entityId: ENTITY,
				direction: BlockFrameMessageDirection.HostToBlock,
				kind,
				payload,
			};
			handler?.({ source: parent, data: env } as unknown as MessageEvent);
		},
		// The block's outbound is wrapped in a transport envelope; unwrap the
		// payloads for assertions.
		outbound(): unknown[] {
			return post.mock.calls.map((c) => (c[0] as BlockFrameEnvelope).payload);
		},
	};
}

describe("startBlock — in-iframe harness", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
	});
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("does not run the loader until Startup arrives, then runs it", () => {
		const load = vi.fn();
		startBlock(
			(ctx) => {
				ctx.onLoad(load);
			},
			{ win: h.win, parent: h.parent },
		);
		expect(load).not.toHaveBeenCalled();
		h.deliver({ capabilities: ["entities.read:*"] }, BlockFrameMessageKind.Startup);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("exposes the Startup capability snapshot to the block", () => {
		let seen: readonly string[] = [];
		startBlock(
			(ctx) => {
				ctx.onLoad(() => {
					seen = ctx.capabilities();
				});
			},
			{ win: h.win, parent: h.parent },
		);
		h.deliver({ capabilities: ["entities.read:Database"] }, BlockFrameMessageKind.Startup);
		expect(seen).toEqual(["entities.read:Database"]);
	});

	it("frames a BP graph request and resolves the correlated *Response", async () => {
		let ctxRef: BlockRuntimeContext | null = null;
		startBlock(
			(ctx) => {
				ctxRef = ctx;
			},
			{ win: h.win, parent: h.parent },
		);
		h.deliver({ capabilities: [] }, BlockFrameMessageKind.Startup);
		const ctx = ctxRef as unknown as BlockRuntimeContext;
		const promise = ctx.graph<{ ok: boolean }>("queryEntities", {
			operation: { entityTypeId: "brainstorm/Task/v1" },
		});
		const sent = h.outbound().at(-1) as {
			requestId: string;
			messageName: string;
			module: string;
			source: string;
		};
		expect(sent.messageName).toBe("queryEntities");
		expect(sent.module).toBe("graph");
		expect(sent.source).toBe("block");
		// Host replies with the correlated response.
		h.deliver({
			requestId: sent.requestId,
			messageName: "queryEntitiesResponse",
			module: "graph",
			source: "embedder",
			data: { ok: true },
		});
		await expect(promise).resolves.toEqual({ ok: true });
	});

	it("rejects a graph request whose response carries a BP error", async () => {
		let ctxRef: BlockRuntimeContext | null = null;
		startBlock(
			(ctx) => {
				ctxRef = ctx;
			},
			{ win: h.win, parent: h.parent },
		);
		h.deliver({ capabilities: [] }, BlockFrameMessageKind.Startup);
		const ctx = ctxRef as unknown as BlockRuntimeContext;
		const promise = ctx.graph("getEntity", { entityId: "missing" });
		const sent = h.outbound().at(-1) as { requestId: string };
		h.deliver({
			requestId: sent.requestId,
			messageName: "getEntityResponse",
			module: "graph",
			source: "embedder",
			errors: [{ code: "NOT_FOUND", message: "not found" }],
		});
		await expect(promise).rejects.toThrow("NOT_FOUND");
	});

	it("re-runs the loader on a host refresh ping", () => {
		const load = vi.fn();
		startBlock(
			(ctx) => {
				ctx.onLoad(load);
			},
			{ win: h.win, parent: h.parent },
		);
		h.deliver({ capabilities: [] }, BlockFrameMessageKind.Startup);
		expect(load).toHaveBeenCalledTimes(1);
		h.deliver({ kind: "refresh" });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("requests the host theme on Startup (the frame can't read the embedder's :root)", () => {
		startBlock(() => {}, { win: h.win, parent: h.parent });
		expect(h.outbound()).not.toContainEqual({ kind: "theme-request" });
		h.deliver({ capabilities: [] }, BlockFrameMessageKind.Startup);
		expect(h.outbound()).toContainEqual({ kind: "theme-request" });
	});

	it("mirrors a Theme control message's vars + color-scheme onto the frame :root", () => {
		const root = document.documentElement;
		root.style.removeProperty("--color-text-primary");
		root.style.removeProperty("color-scheme");
		startBlock(() => {}, { win: h.win, parent: h.parent });
		h.deliver({
			kind: "theme",
			vars: { "--color-text-primary": "#abcdef", "javascript:evil": "x", "--bad key": "y" },
			colorScheme: "dark",
		});
		expect(root.style.getPropertyValue("--color-text-primary")).toBe("#abcdef");
		// Malformed keys are rejected (defence-in-depth against injected declarations).
		expect(root.style.getPropertyValue("javascript:evil")).toBe("");
		expect(root.style.getPropertyValue("--bad key")).toBe("");
		expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
		root.style.removeProperty("--color-text-primary");
		root.style.removeProperty("color-scheme");
	});

	it("sends navigate + height as kind-tagged (non-BP) control messages", () => {
		let ctxRef: BlockRuntimeContext | null = null;
		startBlock(
			(ctx) => {
				ctxRef = ctx;
			},
			{ win: h.win, parent: h.parent },
		);
		const ctx = ctxRef as unknown as BlockRuntimeContext;
		ctx.navigate("ent-row", "brainstorm/Task/v1");
		ctx.reportHeight(123.4);
		const sent = h.outbound() as Array<{ kind?: string; entityId?: string; px?: number }>;
		expect(sent).toContainEqual({
			kind: "navigate",
			entityId: "ent-row",
			entityType: "brainstorm/Task/v1",
		});
		expect(sent).toContainEqual({ kind: "height", px: 124 });
	});
});
