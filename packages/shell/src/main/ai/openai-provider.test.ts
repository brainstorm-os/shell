import {
	AiContentPartKind,
	type AiGenerateResult,
	GLM_PROVIDER_ID,
	MessageRole,
	OPENAI_PROVIDER_ID,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { type OpenAiHttp, createOpenAiProvider } from "./openai-provider";

const OK_BODY = JSON.stringify({
	choices: [{ message: { content: "Hello world" }, finish_reason: "stop" }],
	model: "gpt-4o-mini",
	usage: { prompt_tokens: 12, completion_tokens: 3 },
});

function provider(over: {
	http?: OpenAiHttp;
	getApiKey?: () => Promise<string | null> | string | null;
	baseUrl?: string;
}) {
	return createOpenAiProvider({
		defaultModel: "gpt-4o-mini",
		getApiKey: over.getApiKey ?? (() => "sk-openai-test"),
		http: over.http ?? vi.fn(async () => ({ status: 200, text: OK_BODY })),
		...(over.baseUrl ? { baseUrl: over.baseUrl } : {}),
	});
}

describe("createOpenAiProvider", () => {
	it("posts to {baseUrl}/chat/completions with a Bearer header and flat messages (system passes through)", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await provider({ http, baseUrl: "https://openrouter.ai/api/v1" }).generate({
			messages: [
				{ role: MessageRole.System, content: "Be terse." },
				{ role: MessageRole.User, content: "Hi" },
			],
		});
		const [call] = (http.mock.calls[0] ?? []) as unknown as [
			{ url: string; headers: Record<string, string>; bodyJson: { messages: unknown[] } },
		];
		expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(call.headers.Authorization).toBe("Bearer sk-openai-test");
		// System stays in the messages array (unlike Anthropic).
		expect(call.bodyJson.messages).toEqual([
			{ role: "system", content: "Be terse." },
			{ role: "user", content: "Hi" },
		]);
	});

	it("maps multimodal content to text + image_url parts (vision)", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await provider({ http }).generate({
			messages: [
				{
					role: MessageRole.User,
					content: [
						{ kind: AiContentPartKind.Text, text: "what is this?" },
						{ kind: AiContentPartKind.Image, mimeType: "image/png", data: "BASE64DATA" },
					],
				},
			],
		});
		const [call] = (http.mock.calls[0] ?? []) as unknown as [{ bodyJson: { messages: unknown[] } }];
		expect(call.bodyJson.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "what is this?" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,BASE64DATA" } },
				],
			},
		]);
	});

	it("returns content + provenance from the first choice", async () => {
		const out = (await provider({}).generate({
			messages: [{ role: MessageRole.User, content: "Hi" }],
		})) as AiGenerateResult;
		expect(out).toEqual({
			content: "Hello world",
			provider: OPENAI_PROVIDER_ID,
			model: "gpt-4o-mini",
			finishReason: "stop",
			usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
		});
	});

	it("fails closed (Unavailable) with no key and never hits the network", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await expect(
			provider({ getApiKey: () => null, http }).generate({
				messages: [{ role: MessageRole.User, content: "Hi" }],
			}),
		).rejects.toMatchObject({ name: "Unavailable" });
		expect(http).not.toHaveBeenCalled();
	});

	it("maps a non-2xx, a non-JSON body, and a transport throw to Unavailable", async () => {
		for (const http of [
			vi.fn(async () => ({ status: 429, text: "rate limited" })),
			vi.fn(async () => ({ status: 200, text: "<html>" })),
			vi.fn(async () => {
				throw new Error("ENOTFOUND");
			}),
		]) {
			await expect(
				provider({ http }).generate({ messages: [{ role: MessageRole.User, content: "Hi" }] }),
			).rejects.toMatchObject({ name: "Unavailable" });
		}
	});

	it("rides the same shape for z.ai GLM under its own id, label, and base URL", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		const glm = createOpenAiProvider({
			id: GLM_PROVIDER_ID,
			label: "GLM",
			baseUrl: "https://api.z.ai/api/paas/v4",
			defaultModel: "glm-5.2",
			getApiKey: () => "glm-key",
			http,
		});
		expect(glm.id).toBe(GLM_PROVIDER_ID);
		const out = (await glm.generate({
			messages: [{ role: MessageRole.User, content: "Hi" }],
		})) as AiGenerateResult;
		const [glmCall] = (http.mock.calls[0] ?? []) as unknown as [{ url: string }];
		expect(glmCall.url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
		expect(out.provider).toBe(GLM_PROVIDER_ID);

		await expect(
			createOpenAiProvider({
				id: GLM_PROVIDER_ID,
				label: "GLM",
				defaultModel: "glm-5.2",
				getApiKey: () => null,
				http,
			}).generate({ messages: [{ role: MessageRole.User, content: "Hi" }] }),
		).rejects.toMatchObject({ name: "Unavailable", message: expect.stringContaining("GLM") });
	});
});
