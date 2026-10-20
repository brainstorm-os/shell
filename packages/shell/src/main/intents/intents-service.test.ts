import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import type { IntentsBus } from "./intents-bus";
import { makeIntentsServiceHandler } from "./intents-service";

function makeEnvelope(method: string, args: unknown[]): Envelope {
	return {
		v: 1,
		msg: "m_test",
		app: "io.example.notes",
		service: "intents",
		method,
		args,
		caps: ["intents.dispatch"],
	};
}

describe("makeIntentsServiceHandler", () => {
	it("dispatch forwards to the bus and returns the result", async () => {
		const bus = {
			dispatch: vi.fn().mockResolvedValue({ handled: true, handler: { appId: "io.example.editor" } }),
			suggest: vi.fn(),
		} as unknown as IntentsBus;
		const handler = makeIntentsServiceHandler({ getBus: async () => bus });
		const result = await handler(
			makeEnvelope("dispatch", [{ verb: "open", payload: { entityId: "ent_1" } }]),
		);
		expect(result).toEqual({ handled: true, handler: { appId: "io.example.editor" } });
		expect(bus.dispatch).toHaveBeenCalledWith(
			{ verb: "open", payload: { entityId: "ent_1" } },
			{ app: "io.example.notes" },
		);
	});

	it("dispatch passes the broker-verified sender renderer through to the bus", async () => {
		const bus = { dispatch: vi.fn().mockResolvedValue({ handled: true }), suggest: vi.fn() };
		const handler = makeIntentsServiceHandler({ getBus: async () => bus as unknown as IntentsBus });
		const envelope = makeEnvelope("dispatch", [{ verb: "open", payload: { entityId: "ent_1" } }]);
		await handler(envelope, 42);
		expect(bus.dispatch).toHaveBeenLastCalledWith(expect.anything(), {
			app: "io.example.notes",
			webContentsId: 42,
		});
		// A non-renderer source (tests, synthesized calls) carries no id.
		await handler(envelope, "test-source");
		expect(bus.dispatch).toHaveBeenLastCalledWith(expect.anything(), { app: "io.example.notes" });
	});

	it("suggest forwards to the bus", async () => {
		const bus = {
			dispatch: vi.fn(),
			suggest: vi
				.fn()
				.mockReturnValue([{ appId: "io.example.editor", label: null, priority: "primary" }]),
		} as unknown as IntentsBus;
		const handler = makeIntentsServiceHandler({ getBus: async () => bus });
		const result = await handler(
			makeEnvelope("suggest", [{ verb: "open", payload: { entityType: "io.example/Note/v1" } }]),
		);
		expect(result).toEqual([{ appId: "io.example.editor", label: null, priority: "primary" }]);
	});

	it("suggestActions forwards { target, verbs } to the bus (doc 63 / AS-2)", async () => {
		const actions = [
			{
				id: "process:summarize:io.agent",
				verb: "process",
				kind: "summarize",
				label: "Summarize",
				group: "actions",
				priority: "secondary",
				trustTier: "trusted",
				appId: "io.agent",
				appLabel: "Agent",
			},
		];
		const bus = {
			dispatch: vi.fn(),
			suggest: vi.fn(),
			suggestActions: vi.fn().mockResolvedValue(actions),
		} as unknown as IntentsBus;
		const handler = makeIntentsServiceHandler({ getBus: async () => bus });
		const result = await handler(
			makeEnvelope("suggestActions", [
				{ target: { entityType: "io.example/Note/v1" }, verbs: ["process", "share"] },
			]),
		);
		expect(result).toEqual(actions);
		expect(bus.suggestActions).toHaveBeenCalledWith(
			{ target: { entityType: "io.example/Note/v1" }, verbs: ["process", "share"] },
			{ app: "io.example.notes" },
		);
	});

	it("rejects a malformed suggestActions argument with Invalid", async () => {
		const bus = {
			dispatch: vi.fn(),
			suggest: vi.fn(),
			suggestActions: vi.fn(),
		} as unknown as IntentsBus;
		const handler = makeIntentsServiceHandler({ getBus: async () => bus });
		await expect(handler(makeEnvelope("suggestActions", [null]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(
			handler(makeEnvelope("suggestActions", [{ target: { entityId: "x" } }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("throws Unavailable when no bus is wired", async () => {
		const handler = makeIntentsServiceHandler({ getBus: async () => null });
		await expect(
			handler(makeEnvelope("dispatch", [{ verb: "open", payload: {} }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("rejects bad intent envelopes with Invalid", async () => {
		const bus = { dispatch: vi.fn(), suggest: vi.fn() } as unknown as IntentsBus;
		const handler = makeIntentsServiceHandler({ getBus: async () => bus });
		await expect(handler(makeEnvelope("dispatch", [null]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(handler(makeEnvelope("dispatch", [{ verb: "" }]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(handler(makeEnvelope("dispatch", [{ verb: "open" }]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects unknown methods with Invalid", async () => {
		const bus = { dispatch: vi.fn(), suggest: vi.fn() } as unknown as IntentsBus;
		const handler = makeIntentsServiceHandler({ getBus: async () => bus });
		await expect(
			handler(makeEnvelope("nonsense", [{ verb: "open", payload: {} }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});
});
