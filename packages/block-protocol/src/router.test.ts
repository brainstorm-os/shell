import { describe, expect, it } from "vitest";

import { BpErrorCode, BpModule, BpSource } from "./envelope";
import { type BpModuleHandler, type BpRouterContext, makeBpRouter } from "./router";

const ctx: BpRouterContext = {
	app: "io.example.test",
	entityId: "ent_abc",
};

const fixedNow = () => Date.parse("2026-05-21T12:34:56.000Z");

function req(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		requestId: "rq_1",
		messageName: "createEntity",
		module: BpModule.Graph,
		source: BpSource.Block,
		timestamp: "2026-05-21T00:00:00.000Z",
		...overrides,
	};
}

describe("makeBpRouter — structural validation", () => {
	it("returns null when payload isn't an object", async () => {
		const router = makeBpRouter();
		for (const bad of [null, undefined, 42, "ping", true, [1, 2, 3]]) {
			expect(await router(ctx, bad)).toBeNull();
		}
	});

	it("returns null when messageName is missing or empty", async () => {
		const router = makeBpRouter();
		expect(await router(ctx, req({ messageName: undefined }))).toBeNull();
		expect(await router(ctx, req({ messageName: "" }))).toBeNull();
		expect(await router(ctx, req({ messageName: 42 }))).toBeNull();
	});

	it("returns null when requestId is missing or empty", async () => {
		const router = makeBpRouter();
		expect(await router(ctx, req({ requestId: undefined }))).toBeNull();
		expect(await router(ctx, req({ requestId: "" }))).toBeNull();
		expect(await router(ctx, req({ requestId: 42 }))).toBeNull();
	});

	it("returns null when module is missing or empty", async () => {
		const router = makeBpRouter();
		expect(await router(ctx, req({ module: undefined }))).toBeNull();
		expect(await router(ctx, req({ module: "" }))).toBeNull();
		expect(await router(ctx, req({ module: 42 }))).toBeNull();
	});

	it("rejects *Response-shaped payloads (source must be block, not embedder)", async () => {
		const router = makeBpRouter();
		expect(await router(ctx, req({ source: BpSource.Embedder }))).toBeNull();
	});

	it("tolerates absent source (BP request envelopes don't always carry one)", async () => {
		const router = makeBpRouter();
		const response = await router(ctx, req({ source: undefined }));
		expect(response).not.toBeNull();
		expect(response?.source).toBe(BpSource.Embedder);
	});
});

describe("makeBpRouter — fail-closed default", () => {
	it("returns NOT_IMPLEMENTED for an unknown module", async () => {
		const router = makeBpRouter({ now: fixedNow });
		const response = await router(ctx, req({ module: "nonexistent" }));
		expect(response).toMatchObject({
			requestId: "rq_1",
			messageName: "createEntityResponse",
			module: "nonexistent",
			source: BpSource.Embedder,
			errors: [{ code: BpErrorCode.NotImplemented }],
		});
		expect(response?.errors?.[0]?.message).toContain("nonexistent");
	});

	it("returns NOT_IMPLEMENTED for a known module with no handler wired", async () => {
		const router = makeBpRouter({ now: fixedNow });
		const response = await router(ctx, req({ module: BpModule.Graph }));
		expect(response).toMatchObject({
			messageName: "createEntityResponse",
			module: BpModule.Graph,
			source: BpSource.Embedder,
			errors: [{ code: BpErrorCode.NotImplemented }],
		});
		expect(response?.data).toBeUndefined();
	});

	it("returns NOT_IMPLEMENTED for the hook module with no handler wired", async () => {
		const router = makeBpRouter({ now: fixedNow });
		const response = await router(ctx, req({ module: BpModule.Hook, messageName: "hook" }));
		expect(response).toMatchObject({
			messageName: "hookResponse",
			module: BpModule.Hook,
			errors: [{ code: BpErrorCode.NotImplemented }],
		});
	});
});

describe("makeBpRouter — response envelope shape", () => {
	it("synthesises the BP-required response envelope fields", async () => {
		const router = makeBpRouter({ now: fixedNow });
		const response = await router(ctx, req({ requestId: "rq_42", messageName: "queryEntities" }));
		expect(response).toMatchObject({
			requestId: "rq_42",
			messageName: "queryEntitiesResponse",
			module: BpModule.Graph,
			source: BpSource.Embedder,
			timestamp: new Date(fixedNow()).toISOString(),
		});
	});
});

describe("makeBpRouter — handler delegation", () => {
	it("delegates to the graph handler and propagates its data", async () => {
		const graph: BpModuleHandler = async (request, context) => {
			expect(request.messageName).toBe("getEntity");
			expect(context.entityId).toBe("ent_abc");
			expect(context.app).toBe("io.example.test");
			return { data: { id: "ent_xyz", type: "io.example/Note/v1" } };
		};
		const router = makeBpRouter({ graph, now: fixedNow });
		const response = await router(ctx, req({ messageName: "getEntity", module: BpModule.Graph }));
		expect(response?.data).toEqual({ id: "ent_xyz", type: "io.example/Note/v1" });
		expect(response?.errors).toBeUndefined();
	});

	it("delegates to the hook handler", async () => {
		const hook: BpModuleHandler = async () => ({ data: { nodeId: "nid_1" } });
		const router = makeBpRouter({ hook, now: fixedNow });
		const response = await router(ctx, req({ messageName: "hook", module: BpModule.Hook }));
		expect(response?.data).toEqual({ nodeId: "nid_1" });
	});

	it("converts a handler throw into INTERNAL_ERROR (no payload bleed)", async () => {
		const sentinel = "vault key 0x0123abcd";
		const graph: BpModuleHandler = () => {
			throw new Error(sentinel);
		};
		const router = makeBpRouter({ graph, now: fixedNow });
		const response = await router(ctx, req({ messageName: "createEntity", module: BpModule.Graph }));
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InternalError);
		expect(response?.errors?.[0]?.message).not.toContain(sentinel);
		expect(response?.errors?.[0]?.message).not.toContain("0x");
	});

	it("returns null when a handler returns null (do-not-respond signal)", async () => {
		const graph: BpModuleHandler = () => null;
		const router = makeBpRouter({ graph, now: fixedNow });
		const response = await router(ctx, req({ messageName: "getEntity", module: BpModule.Graph }));
		expect(response).toBeNull();
	});

	it("omits the data field on errors-only responses", async () => {
		const graph: BpModuleHandler = () => ({
			errors: [{ code: BpErrorCode.Forbidden, message: "no entities.read" }],
		});
		const router = makeBpRouter({ graph, now: fixedNow });
		const response = await router(ctx, req({ messageName: "getEntity", module: BpModule.Graph }));
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.Forbidden);
		expect(response).not.toHaveProperty("data");
	});

	it("omits the errors field when the handler returns only data", async () => {
		const graph: BpModuleHandler = () => ({ data: 42 });
		const router = makeBpRouter({ graph, now: fixedNow });
		const response = await router(ctx, req({ messageName: "getEntity", module: BpModule.Graph }));
		expect(response).not.toHaveProperty("errors");
		expect(response?.data).toBe(42);
	});

	it("supports a sync handler", async () => {
		const graph: BpModuleHandler = (request) => ({
			data: { echoed: request.messageName },
		});
		const router = makeBpRouter({ graph });
		const response = await router(ctx, req({ messageName: "queryEntities", module: BpModule.Graph }));
		expect(response?.data).toEqual({ echoed: "queryEntities" });
	});
});
