import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { makeAiServiceHandler } from "./ai-service";
import { pinCustomDefaultProvider } from "./default-route-gate";
import type { ModelProvider } from "./provider";

const env = (method: string, args: unknown[]): Envelope =>
	({
		v: 1,
		msg: "m1",
		app: "io.test",
		service: "ai",
		method,
		args,
		caps: ["ai.use"],
	}) as unknown as Envelope;

describe("pinCustomDefaultProvider (Agent-14)", () => {
	it("pins an unpinned model call to a custom default, so the custom-endpoint gate sees it", async () => {
		const inner = vi.fn(async (e: Envelope) => e.args[0]);
		const gated = pinCustomDefaultProvider(inner, () => "custom-abc123");
		for (const verb of ["generate", "cost", "transform", "extract"]) {
			expect(await gated(env(verb, [{ messages: [] }]))).toEqual({
				messages: [],
				provider: "custom-abc123",
			});
		}
	});

	it("leaves pinned calls, built-in defaults and non-model verbs untouched", async () => {
		const inner = vi.fn(async (e: Envelope) => e.args[0]);
		expect(
			await pinCustomDefaultProvider(
				inner,
				() => "custom-abc123",
			)(env("generate", [{ messages: [], provider: "ollama" }])),
		).toEqual({ messages: [], provider: "ollama" });
		expect(
			await pinCustomDefaultProvider(inner, () => "ollama")(env("generate", [{ messages: [] }])),
		).toEqual({
			messages: [],
		});
		expect(
			await pinCustomDefaultProvider(inner, () => "custom-abc123")(env("providers", [{}])),
		).toEqual({});
	});

	it("end to end: an unpinned call cannot reach a custom default on ai.use alone", async () => {
		const generate = vi.fn(async () => ({ content: "x", provider: "custom-abc123", model: "m" }));
		const custom: ModelProvider = { id: "custom-abc123", generate };
		const handler = pinCustomDefaultProvider(
			makeAiServiceHandler({
				getProvider: (id) => (id === undefined || id === custom.id ? custom : null),
				appHoldsCapability: async (_app, cap) => cap === "ai.use",
			}),
			() => custom.id,
		);
		await expect(
			handler(env("generate", [{ messages: [{ role: "user", content: "hi" }] }])),
		).rejects.toMatchObject({ name: "Unavailable" });
		expect(generate).not.toHaveBeenCalled();
	});
});
