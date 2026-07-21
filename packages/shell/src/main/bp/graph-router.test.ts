import {
	BpErrorCode,
	BpModule,
	type BpRouterContext,
	BpSource,
} from "@brainstorm-os/block-protocol";
import type { Entity } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";

import type { Envelope } from "../../ipc/envelope";
import { type EntitiesInvoker, makeBpGraphRouter } from "./graph-router";

const ctx: BpRouterContext = {
	app: "io.example.test",
	entityId: "ent_embed",
};

function envReq(messageName: string, data: unknown) {
	return {
		requestId: "rq_1",
		messageName,
		module: BpModule.Graph,
		source: BpSource.Block,
		timestamp: "2026-05-21T00:00:00.000Z",
		data,
	};
}

function nameThrow(name: string, message = "test") {
	const err = new Error(message);
	err.name = name;
	return err;
}

function fakeEntity(id: string, type: string, properties: Record<string, unknown> = {}): Entity {
	return {
		id,
		type,
		properties,
		links: [],
		createdBy: "io.example.test",
		createdAt: 1,
		updatedAt: 2,
	};
}

describe("makeBpGraphRouter — createEntity", () => {
	it("forwards entityTypeId + properties as type + properties to entities.create", async () => {
		const calls: Envelope[] = [];
		const entities: EntitiesInvoker = (env) => {
			calls.push(env);
			return fakeEntity("ent_new", "io.example/Note/v1", { title: "hi" });
		};
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("createEntity", { entityTypeId: "io.example/Note/v1", properties: { title: "hi" } }),
			ctx,
		);
		expect(calls).toHaveLength(1);
		const c = calls[0];
		expect(c?.service).toBe("entities");
		expect(c?.method).toBe("create");
		expect(c?.app).toBe(ctx.app);
		expect(c?.args[0]).toEqual({ type: "io.example/Note/v1", properties: { title: "hi" } });
		expect(response).toEqual({
			data: {
				entityId: "ent_new",
				entityTypeId: "io.example/Note/v1",
				properties: { title: "hi" },
				updatedAt: 2,
			},
		});
	});

	it("rejects missing entityTypeId with INVALID_INPUT", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(envReq("createEntity", { properties: {} }), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
	});

	it("rejects non-object data with INVALID_INPUT", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(envReq("createEntity", 42), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
	});

	it("returns NOT_IMPLEMENTED when linkData is supplied (v1 deferral)", async () => {
		const entities = vi.fn();
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("createEntity", {
				entityTypeId: "io.example/Link/v1",
				properties: {},
				linkData: { leftEntityId: "a", rightEntityId: "b" },
			}),
			ctx,
		);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.NotImplemented);
		expect(entities).not.toHaveBeenCalled();
	});

	it("maps service Denied to FORBIDDEN", async () => {
		const entities: EntitiesInvoker = () => {
			throw nameThrow("Denied");
		};
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("createEntity", { entityTypeId: "io.example/Note/v1", properties: {} }),
			ctx,
		);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.Forbidden);
	});

	it("maps service Invalid to INVALID_INPUT", async () => {
		const entities: EntitiesInvoker = () => {
			throw nameThrow("Invalid", "vault/path/leak");
		};
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("createEntity", { entityTypeId: "io.example/Note/v1", properties: {} }),
			ctx,
		);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
		// no payload bleed — message must not contain the thrown error's text
		expect(response?.errors?.[0]?.message).not.toContain("vault/path");
	});

	it("maps service Unavailable to INTERNAL_ERROR", async () => {
		const entities: EntitiesInvoker = () => {
			throw nameThrow("Unavailable");
		};
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("createEntity", { entityTypeId: "io.example/Note/v1", properties: {} }),
			ctx,
		);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InternalError);
	});
});

describe("makeBpGraphRouter — getEntity", () => {
	it("forwards entityId and maps the entity to BP shape", async () => {
		const entities: EntitiesInvoker = () => fakeEntity("ent_42", "io.example/Note/v1", { x: 1 });
		const router = makeBpGraphRouter({ entities });
		const response = await router(envReq("getEntity", { entityId: "ent_42" }), ctx);
		expect(response?.data).toEqual({
			entityId: "ent_42",
			entityTypeId: "io.example/Note/v1",
			properties: { x: 1 },
			updatedAt: 2,
		});
	});

	it("returns NOT_FOUND on null (entity doesn't exist OR no read cap)", async () => {
		const entities: EntitiesInvoker = () => null;
		const router = makeBpGraphRouter({ entities });
		const response = await router(envReq("getEntity", { entityId: "ent_missing" }), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.NotFound);
	});

	it("rejects missing entityId with INVALID_INPUT", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(envReq("getEntity", {}), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
	});
});

describe("makeBpGraphRouter — updateEntity", () => {
	it("forwards properties as a patch and reshapes the result", async () => {
		const calls: Envelope[] = [];
		const entities: EntitiesInvoker = (env) => {
			calls.push(env);
			return fakeEntity("ent_42", "io.example/Note/v1", { title: "new" });
		};
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("updateEntity", {
				entityId: "ent_42",
				entityTypeId: "io.example/Note/v1",
				properties: { title: "new" },
			}),
			ctx,
		);
		expect(calls[0]?.method).toBe("update");
		expect(calls[0]?.args[0]).toEqual({ id: "ent_42", patch: { title: "new" } });
		expect(response?.data).toMatchObject({
			entityId: "ent_42",
			entityTypeId: "io.example/Note/v1",
			properties: { title: "new" },
		});
	});

	it("rejects missing properties with INVALID_INPUT", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(
			envReq("updateEntity", { entityId: "ent_42", entityTypeId: "io.example/Note/v1" }),
			ctx,
		);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
	});

	it("maps a not-found service Invalid to INVALID_INPUT (no payload bleed)", async () => {
		const entities: EntitiesInvoker = () => {
			throw nameThrow("Invalid", "vault/path/leak");
		};
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("updateEntity", {
				entityId: "ent_x",
				entityTypeId: "io.example/Note/v1",
				properties: {},
			}),
			ctx,
		);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
		expect(response?.errors?.[0]?.message).not.toContain("vault");
	});
});

describe("makeBpGraphRouter — deleteEntity", () => {
	it("accepts entityId as a bare string (BP schema form)", async () => {
		const calls: Envelope[] = [];
		const entities: EntitiesInvoker = (env) => {
			calls.push(env);
			return null;
		};
		const router = makeBpGraphRouter({ entities });
		const response = await router(envReq("deleteEntity", "ent_42"), ctx);
		expect(calls[0]?.method).toBe("delete");
		expect(calls[0]?.args[0]).toEqual({ id: "ent_42" });
		expect(response?.data).toBe(true);
	});

	it("also accepts entityId wrapped in an object (lenient)", async () => {
		const entities: EntitiesInvoker = () => null;
		const router = makeBpGraphRouter({ entities });
		const response = await router(envReq("deleteEntity", { entityId: "ent_42" }), ctx);
		expect(response?.data).toBe(true);
	});

	it("rejects missing entityId with INVALID_INPUT", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(envReq("deleteEntity", {}), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
	});
});

describe("makeBpGraphRouter — queryEntities", () => {
	it("translates {operation: {entityTypeId}} → entities.query({type})", async () => {
		const calls: Envelope[] = [];
		const entities: EntitiesInvoker = (env) => {
			calls.push(env);
			return [fakeEntity("ent_a", "io.example/Note/v1"), fakeEntity("ent_b", "io.example/Note/v1")];
		};
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("queryEntities", { operation: { entityTypeId: "io.example/Note/v1" } }),
			ctx,
		);
		expect(calls[0]?.args[0]).toEqual({ query: { type: "io.example/Note/v1" } });
		const wireData = response?.data as { results: { roots: string[]; vertices: object } };
		expect(wireData.results.roots).toEqual(["ent_a", "ent_b"]);
		expect(Object.keys(wireData.results.vertices)).toEqual(["ent_a", "ent_b"]);
	});

	it("returns NOT_IMPLEMENTED for graphResolveDepths > 0 (v1 deferral)", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(
			envReq("queryEntities", {
				operation: {},
				graphResolveDepths: { hasLeftEntity: { outgoing: 1 } },
			}),
			ctx,
		);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.NotImplemented);
	});

	it("rejects missing operation with INVALID_INPUT", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(envReq("queryEntities", {}), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.InvalidInput);
	});

	it("ignores unsupported `where`/`text` keys without erroring (v1 lenient)", async () => {
		const entities: EntitiesInvoker = () => [];
		const router = makeBpGraphRouter({ entities });
		const response = await router(
			envReq("queryEntities", {
				operation: { entityTypeId: "io.example/Note/v1", where: { foo: "bar" } },
			}),
			ctx,
		);
		expect(response?.data).toBeDefined();
		expect(response?.errors).toBeUndefined();
	});
});

describe("makeBpGraphRouter — uploadFile", () => {
	it("returns NOT_IMPLEMENTED for the {url} path (gated on Net-1)", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(envReq("uploadFile", { url: "https://example.test/a.png" }), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.NotImplemented);
	});

	it("returns NOT_IMPLEMENTED for the {file} path (gated on chunked-postMessage)", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(envReq("uploadFile", { file: { name: "a.png" } }), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.NotImplemented);
	});
});

describe("makeBpGraphRouter — unknown message", () => {
	it("returns NOT_IMPLEMENTED for an unrecognised graph messageName", async () => {
		const router = makeBpGraphRouter({ entities: vi.fn() });
		const response = await router(envReq("hypotheticalNewMessage", {}), ctx);
		expect(response?.errors?.[0]?.code).toBe(BpErrorCode.NotImplemented);
	});
});

describe("makeBpGraphRouter — envelope stamping", () => {
	it("stamps the entities envelope with the calling app + a fresh msg id", async () => {
		const calls: Envelope[] = [];
		const entities: EntitiesInvoker = (env) => {
			calls.push(env);
			return fakeEntity("ent_new", "io.example/Note/v1");
		};
		const idGen = vi.fn().mockReturnValueOnce("bp_test_1");
		const router = makeBpGraphRouter({ entities, newMsgId: idGen });
		await router(envReq("createEntity", { entityTypeId: "io.example/Note/v1", properties: {} }), ctx);
		expect(calls[0]?.app).toBe("io.example.test");
		expect(calls[0]?.msg).toBe("bp_test_1");
		expect(calls[0]?.service).toBe("entities");
		expect(calls[0]?.caps).toEqual([]);
	});
});
