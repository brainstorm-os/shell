import { describe, expect, it } from "vitest";

import { BpErrorCode, BpModule, BpSource } from "./envelope";
import { makeBpHookRouter } from "./hook-router";
import type { BpRouterContext } from "./router";

const ctx: BpRouterContext = {
	app: "io.example.test",
	entityId: "ent_host",
};

function hookReq(data: unknown, messageName = "hook") {
	return {
		requestId: "rq_h",
		messageName,
		module: BpModule.Hook,
		source: BpSource.Block,
		timestamp: "2026-05-21T00:00:00.000Z",
		data,
	};
}

describe("makeBpHookRouter — structural validation", () => {
	it("rejects non-record data", async () => {
		const r = makeBpHookRouter();
		const response = await r(hookReq(42), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
	});

	it("requires type/entityId/path/hookId/node fields", async () => {
		const r = makeBpHookRouter();
		// missing type
		expect(
			(await r(hookReq({ entityId: "ent_42", path: "$.body", hookId: null, node: {} }), ctx))
				?.errors?.[0]?.code,
		).toBe(BpErrorCode.InvalidInput);
		// missing entityId
		expect(
			(await r(hookReq({ type: "text", path: "$.body", hookId: null, node: {} }), ctx))?.errors?.[0]
				?.code,
		).toBe(BpErrorCode.InvalidInput);
		// wrong hookId type
		expect(
			(
				await r(
					hookReq({ type: "text", entityId: "ent_42", path: "$.body", hookId: 42, node: {} }),
					ctx,
				)
			)?.errors?.[0]?.code,
		).toBe(BpErrorCode.InvalidInput);
		// wrong node type
		expect(
			(
				await r(
					hookReq({
						type: "text",
						entityId: "ent_42",
						path: "$.body",
						hookId: null,
						node: "not-an-object",
					}),
					ctx,
				)
			)?.errors?.[0]?.code,
		).toBe(BpErrorCode.InvalidInput);
	});

	it("rejects an unknown messageName within the hook module", async () => {
		const r = makeBpHookRouter();
		const response = await r(hookReq({}, "hypothetical"), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.NotImplemented);
	});
});

describe("makeBpHookRouter — destroy semantics", () => {
	it("`node: null` + hookId returns OK idempotently (no host state to clean)", async () => {
		const r = makeBpHookRouter();
		const response = await r(
			hookReq({ type: "text", entityId: "ent_42", path: "$.body", hookId: "hk_1", node: null }),
			ctx,
		);
		expect(response?.errors).toBeUndefined();
		expect(response?.data).toEqual({ hookId: "hk_1" });
	});

	it("`node: null` without hookId is INVALID_INPUT (destroy needs a target)", async () => {
		const r = makeBpHookRouter();
		const response = await r(
			hookReq({ type: "text", entityId: "ent_42", path: "$.body", hookId: null, node: null }),
			ctx,
		);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
	});
});

describe("makeBpHookRouter — registration is v1 NOT_IMPLEMENTED", () => {
	it("any non-null `node` returns NOT_IMPLEMENTED with OQ-BP-5 pointer", async () => {
		const r = makeBpHookRouter();
		for (const type of ["text", "image", "video", "audio", "custom-thing"]) {
			const response = await r(
				hookReq({ type, entityId: "ent_42", path: "$.body", hookId: null, node: {} }),
				ctx,
			);
			expect(response?.errors?.[0]?.code).toBe(BpErrorCode.NotImplemented);
			expect(response?.errors?.[0]?.message).toMatch(/OQ-BP-5/);
			expect(response?.errors?.[0]?.message).toContain(type);
		}
	});
});
