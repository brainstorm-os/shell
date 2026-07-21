import {
	type AiGenerateRequest,
	type AiGenerateResult,
	MessageRole,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { makeAiServiceHandler } from "./ai-service";
import type { ModelProvider } from "./provider";
import { ProviderRegistry } from "./provider-registry";

const baseEnvelope = (method: string, args: unknown[]): Envelope => ({
	v: 1,
	msg: "m1",
	app: "io.brainstorm.agent",
	service: "ai",
	method,
	args,
	caps: ["ai.use"],
});

const result: AiGenerateResult = {
	content: "hi",
	provider: "ollama",
	model: "llama3.2",
};

function fakeProvider(id: string, gen = vi.fn(async () => result)): ModelProvider {
	return { id, generate: gen };
}

describe("makeAiServiceHandler", () => {
	it("routes generate to the default provider and returns its result", async () => {
		const reg = new ProviderRegistry();
		const provider = fakeProvider("ollama");
		reg.register(provider);
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });

		const out = await handler(
			baseEnvelope("generate", [{ messages: [{ role: MessageRole.User, content: "Hi" }] }]),
		);
		expect(out).toEqual(result);
		expect(provider.generate).toHaveBeenCalledOnce();
	});

	it("routes to a pinned provider id", async () => {
		const reg = new ProviderRegistry();
		reg.register(fakeProvider("ollama"));
		const cloud = fakeProvider(
			"cloud",
			vi.fn(async () => ({ ...result, provider: "cloud" })),
		);
		reg.register(cloud);
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });

		const out = (await handler(
			baseEnvelope("generate", [
				{ provider: "cloud", messages: [{ role: MessageRole.User, content: "Hi" }] },
			]),
		)) as AiGenerateResult;
		expect(out.provider).toBe("cloud");
		expect(cloud.generate).toHaveBeenCalledOnce();
	});

	it("throws Unavailable when no provider is configured", async () => {
		const reg = new ProviderRegistry();
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });
		await expect(
			handler(baseEnvelope("generate", [{ messages: [{ role: MessageRole.User, content: "x" }] }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("throws Unavailable when a pinned provider is unknown", async () => {
		const reg = new ProviderRegistry();
		reg.register(fakeProvider("ollama"));
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });
		await expect(
			handler(
				baseEnvelope("generate", [
					{ provider: "ghost", messages: [{ role: MessageRole.User, content: "x" }] },
				]),
			),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("rejects an empty / malformed request and unknown methods with Invalid", async () => {
		const reg = new ProviderRegistry();
		reg.register(fakeProvider("ollama"));
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });

		await expect(handler(baseEnvelope("generate", [{ messages: [] }]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(
			handler(baseEnvelope("generate", [{ messages: [{ role: "shout", content: "x" }] }])),
		).rejects.toMatchObject({ name: "Invalid" });
		await expect(handler(baseEnvelope("explode", [{}]))).rejects.toMatchObject({ name: "Invalid" });
	});
});

describe("ai.transform (11.5)", () => {
	function handlerWith(gen = vi.fn(async () => result)) {
		const reg = new ProviderRegistry();
		const provider = fakeProvider("ollama", gen);
		reg.register(provider);
		return { handler: makeAiServiceHandler({ getProvider: (id) => reg.get(id) }), gen };
	}

	it("builds a system instruction from the kind + source as the user turn", async () => {
		const { handler, gen } = handlerWith();
		await handler(
			baseEnvelope("transform", [{ source: "Bonjour", kind: "translate", params: { to: "German" } }]),
		);
		const [req] = (gen.mock.calls[0] ?? []) as unknown as [
			{ messages: { role: string; content: string }[] },
		];
		expect(req.messages[0]?.role).toBe(MessageRole.System);
		expect(req.messages[0]?.content).toContain("German");
		expect(req.messages[1]).toEqual({ role: MessageRole.User, content: "Bonjour" });
	});

	it("returns the transformed content with provider/model provenance", async () => {
		const { handler } = handlerWith(
			vi.fn(async () => ({ content: "Hallo", provider: "ollama", model: "llama3.2" })),
		);
		const out = await handler(baseEnvelope("transform", [{ source: "Hi", kind: "rewrite" }]));
		expect(out).toEqual({ content: "Hallo", provider: "ollama", model: "llama3.2" });
	});

	it("rejects an empty source, an unknown kind, and non-string params with Invalid", async () => {
		const { handler } = handlerWith();
		await expect(
			handler(baseEnvelope("transform", [{ source: "", kind: "rewrite" }])),
		).rejects.toMatchObject({ name: "Invalid" });
		await expect(
			handler(baseEnvelope("transform", [{ source: "x", kind: "shout" }])),
		).rejects.toMatchObject({ name: "Invalid" });
		await expect(
			handler(baseEnvelope("transform", [{ source: "x", kind: "format", params: { as: 7 } }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("throws Unavailable when no provider is configured", async () => {
		const reg = new ProviderRegistry();
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });
		await expect(
			handler(baseEnvelope("transform", [{ source: "x", kind: "rewrite" }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});
});

describe("ai.extract (11.5)", () => {
	const fields = [
		{ name: "name", type: "string" },
		{ name: "age", type: "number" },
	];

	function handlerReturning(content: string) {
		const reg = new ProviderRegistry();
		reg.register(
			fakeProvider(
				"ollama",
				vi.fn(async () => ({ ...result, content })),
			),
		);
		return makeAiServiceHandler({ getProvider: (id) => reg.get(id) });
	}

	it("returns the coerced fields with provider/model provenance", async () => {
		const handler = handlerReturning('{"name":"Ada","age":"36"}');
		const out = await handler(baseEnvelope("extract", [{ source: "Ada, 36", fields }]));
		expect(out).toEqual({ fields: { name: "Ada", age: 36 }, provider: "ollama", model: "llama3.2" });
	});

	it("throws Unavailable when the model returns no recoverable JSON", async () => {
		const handler = handlerReturning("sorry, no JSON here");
		await expect(handler(baseEnvelope("extract", [{ source: "x", fields }]))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("rejects empty source, empty fields, and a bad field type with Invalid", async () => {
		const handler = handlerReturning("{}");
		await expect(handler(baseEnvelope("extract", [{ source: "", fields }]))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(
			handler(baseEnvelope("extract", [{ source: "x", fields: [] }])),
		).rejects.toMatchObject({ name: "Invalid" });
		await expect(
			handler(baseEnvelope("extract", [{ source: "x", fields: [{ name: "a", type: "date" }] }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});
});

describe("ai.extract intoType (11.5)", () => {
	function handlerWithType(
		content: string,
		resolveTypeFields: (typeId: string) => Promise<readonly { name: string; type?: string }[] | null>,
	) {
		const gen = vi.fn(async (_req: AiGenerateRequest) => ({ ...result, content }));
		const reg = new ProviderRegistry();
		reg.register({ id: "ollama", generate: gen } satisfies ModelProvider);
		return {
			gen,
			handler: makeAiServiceHandler({
				getProvider: (id) => reg.get(id),
				resolveTypeFields: resolveTypeFields as never,
			}),
		};
	}

	it("derives fields from the resolved type and coerces them", async () => {
		const { handler, gen } = handlerWithType('{"name":"Ada","age":"36"}', async () => [
			{ name: "name", type: "string" },
			{ name: "age", type: "number" },
		]);
		const out = await handler(
			baseEnvelope("extract", [{ source: "Ada is 36", intoType: "brainstorm/Person/v1" }]),
		);
		expect(out).toEqual({ fields: { name: "Ada", age: 36 }, provider: "ollama", model: "llama3.2" });
		// The derived field names reached the prompt builder (system message lists them).
		const sent = gen.mock.calls[0]?.[0];
		expect(sent?.messages[0]?.content).toContain("name");
		expect(sent?.messages[0]?.content).toContain("age");
	});

	it("lets explicit fields override the type-derived fields by name", async () => {
		const { handler, gen } = handlerWithType(
			'{"name":"Ada","age":36,"city":"Lovelace"}',
			async () => [
				{ name: "name", type: "string" },
				{ name: "age", type: "number" },
			],
		);
		await handler(
			baseEnvelope("extract", [
				{
					source: "x",
					intoType: "brainstorm/Person/v1",
					fields: [{ name: "city", type: "string" }],
				},
			]),
		);
		const sent = gen.mock.calls[0]?.[0];
		expect(sent?.messages[0]?.content).toContain("city");
	});

	it("fails closed (Unavailable) when the type has no extractable fields", async () => {
		const { handler } = handlerWithType("{}", async () => []);
		await expect(
			handler(baseEnvelope("extract", [{ source: "x", intoType: "brainstorm/Unknown/v1" }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("fails closed (Unavailable) when no resolver is configured", async () => {
		const reg = new ProviderRegistry();
		reg.register(fakeProvider("ollama"));
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });
		await expect(
			handler(baseEnvelope("extract", [{ source: "x", intoType: "brainstorm/Person/v1" }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("rejects an empty intoType string with Invalid", async () => {
		const { handler } = handlerWithType("{}", async () => [{ name: "a", type: "string" }]);
		await expect(
			handler(baseEnvelope("extract", [{ source: "x", intoType: "" }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});
});

describe("ai.cost (11.5)", () => {
	it("estimates prompt tokens + echoes the resolved provider without calling it", async () => {
		const reg = new ProviderRegistry();
		const provider = fakeProvider("ollama");
		reg.register(provider);
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });
		const out = (await handler(
			baseEnvelope("cost", [
				{ model: "llama3.2", messages: [{ role: MessageRole.User, content: "12345678" }] },
			]),
		)) as { promptTokens: number; provider: string; model?: string };
		expect(out).toEqual({ promptTokens: 6, provider: "ollama", model: "llama3.2" });
		expect(provider.generate).not.toHaveBeenCalled();
	});

	it("throws Unavailable when no provider is configured", async () => {
		const reg = new ProviderRegistry();
		const handler = makeAiServiceHandler({ getProvider: (id) => reg.get(id) });
		await expect(
			handler(baseEnvelope("cost", [{ messages: [{ role: MessageRole.User, content: "x" }] }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});
});

describe("provenance recording (11.8)", () => {
	function recordingHandler(gen = vi.fn(async () => result)) {
		const reg = new ProviderRegistry();
		reg.register(fakeProvider("ollama", gen));
		const onUsage = vi.fn();
		const handler = makeAiServiceHandler({
			getProvider: (id) => reg.get(id),
			onUsage,
			now: () => 5000,
		});
		return { handler, onUsage };
	}

	it("records a usage row on a successful generate", async () => {
		const gen = vi.fn(async () => ({
			...result,
			usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
		}));
		const { handler, onUsage } = recordingHandler(gen);
		await handler(
			baseEnvelope("generate", [{ messages: [{ role: MessageRole.User, content: "Hi" }] }]),
		);
		expect(onUsage).toHaveBeenCalledOnce();
		expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
			appId: "io.brainstorm.agent",
			verb: "generate",
			provider: "ollama",
			model: "llama3.2",
			promptTokens: 10,
			completionTokens: 4,
			totalTokens: 14,
			outcome: "ok",
		});
	});

	it("records an error row when the provider throws, then re-throws", async () => {
		const gen = vi.fn(async () => {
			throw new Error("boom");
		});
		const { handler, onUsage } = recordingHandler(gen);
		await expect(
			handler(baseEnvelope("generate", [{ messages: [{ role: MessageRole.User, content: "Hi" }] }])),
		).rejects.toThrow();
		expect(onUsage).toHaveBeenCalledOnce();
		expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ verb: "generate", outcome: "error" });
	});

	it("does NOT record cost (a pre-send estimate, no model call)", async () => {
		const { handler, onUsage } = recordingHandler();
		await handler(baseEnvelope("cost", [{ messages: [{ role: MessageRole.User, content: "Hi" }] }]));
		expect(onUsage).not.toHaveBeenCalled();
	});

	it("records exactly once when extract gets invalid JSON (no double-record)", async () => {
		const gen = vi.fn(async () => ({ ...result, content: "not json" }));
		const { handler, onUsage } = recordingHandler(gen);
		await expect(
			handler(baseEnvelope("extract", [{ source: "x", fields: [{ name: "title" }] }])),
		).rejects.toMatchObject({ name: "Unavailable" });
		expect(onUsage).toHaveBeenCalledOnce();
		expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
			verb: "extract",
			outcome: "error",
			provider: "ollama",
		});
	});
});

describe("budget gate (14.8)", () => {
	function gatedHandler(checkBudget: (appId: string) => Promise<void>, onUsage = vi.fn()) {
		const reg = new ProviderRegistry();
		const gen = vi.fn(async () => result);
		reg.register(fakeProvider("ollama", gen));
		const handler = makeAiServiceHandler({
			getProvider: (id) => reg.get(id),
			quota: { checkBudget },
			onUsage,
		});
		return { handler, gen, onUsage };
	}

	const budgetError = () => {
		const err = new Error("ai: io.brainstorm.agent exhausted its 30-day AI budget");
		err.name = "AiBudgetExhausted";
		return err;
	};

	it("checks the budget before dispatching generate, with the envelope's app id", async () => {
		const checkBudget = vi.fn(async () => {});
		const { handler, gen } = gatedHandler(checkBudget);
		await handler(
			baseEnvelope("generate", [{ messages: [{ role: MessageRole.User, content: "Hi" }] }]),
		);
		expect(checkBudget).toHaveBeenCalledExactlyOnceWith("io.brainstorm.agent");
		expect(gen).toHaveBeenCalledOnce();
	});

	it("an exhausted budget blocks generate/transform/extract with the distinct error — the provider is never called", async () => {
		const checkBudget = vi.fn(async () => {
			throw budgetError();
		});
		const { handler, gen } = gatedHandler(checkBudget);
		const calls: Array<[string, unknown]> = [
			["generate", { messages: [{ role: MessageRole.User, content: "Hi" }] }],
			["transform", { source: "text", kind: "rewrite" }],
			["extract", { source: "text", fields: [{ name: "title" }] }],
		];
		for (const [method, arg] of calls) {
			await expect(handler(baseEnvelope(method, [arg]))).rejects.toMatchObject({
				name: "AiBudgetExhausted",
			});
		}
		expect(gen).not.toHaveBeenCalled();
	});

	it("never gates cost (a free pre-send estimate)", async () => {
		const checkBudget = vi.fn(async () => {
			throw budgetError();
		});
		const { handler } = gatedHandler(checkBudget);
		const out = await handler(
			baseEnvelope("cost", [{ messages: [{ role: MessageRole.User, content: "12345678" }] }]),
		);
		expect(out).toMatchObject({ provider: "ollama" });
		expect(checkBudget).not.toHaveBeenCalled();
	});

	it("a budget rejection still records an error provenance row", async () => {
		const checkBudget = vi.fn(async () => {
			throw budgetError();
		});
		const { handler, onUsage } = gatedHandler(checkBudget);
		await expect(
			handler(baseEnvelope("generate", [{ messages: [{ role: MessageRole.User, content: "x" }] }])),
		).rejects.toMatchObject({ name: "AiBudgetExhausted" });
		expect(onUsage).toHaveBeenCalledOnce();
		expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
			appId: "io.brainstorm.agent",
			verb: "generate",
			provider: "",
			outcome: "error",
		});
	});
});

describe("ProviderRegistry", () => {
	it("first registered is the default; setDefault overrides; get(undefined) resolves it", () => {
		const reg = new ProviderRegistry();
		reg.register(fakeProvider("a"));
		reg.register(fakeProvider("b"));
		expect(reg.get(undefined)?.id).toBe("a");
		reg.setDefault("b");
		expect(reg.get(undefined)?.id).toBe("b");
		expect(reg.get("a")?.id).toBe("a");
		expect(reg.get("missing")).toBeNull();
	});
});
