import { AiContentPartKind, MessageRole, OLLAMA_PROVIDER_ID } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { type OllamaHttp, createOllamaProvider } from "./ollama-provider";

const cannedOk = (content: string): { status: number; text: string } => ({
	status: 200,
	text: JSON.stringify({
		model: "llama3.2",
		message: { role: "assistant", content },
		done: true,
		done_reason: "stop",
		prompt_eval_count: 12,
		eval_count: 5,
	}),
});

describe("createOllamaProvider", () => {
	it("maps multimodal content to content text + the images array (vision)", async () => {
		const http = vi.fn(async () => cannedOk("ok"));
		await createOllamaProvider({
			endpoint: "http://localhost:11434",
			defaultModel: "llava",
			http,
		}).generate({
			messages: [
				{
					role: MessageRole.User,
					content: [
						{ kind: AiContentPartKind.Text, text: "what is this?" },
						{ kind: AiContentPartKind.Image, mimeType: "image/png", data: "B64" },
					],
				},
			],
		});
		const [call] = (http.mock.calls[0] ?? []) as unknown as [{ bodyJson: { messages: unknown[] } }];
		expect(call.bodyJson.messages).toEqual([
			{ role: "user", content: "what is this?", images: ["B64"] },
		]);
	});

	it("posts to <endpoint>/api/chat with the transcript + default model and maps the result", async () => {
		const http = vi.fn<OllamaHttp>(async () => cannedOk("Hello there"));
		const provider = createOllamaProvider({
			endpoint: "http://localhost:11434/",
			defaultModel: "llama3.2",
			http,
		});

		const result = await provider.generate({
			messages: [{ role: MessageRole.User, content: "Hi" }],
		});

		expect(provider.id).toBe(OLLAMA_PROVIDER_ID);
		expect(http).toHaveBeenCalledOnce();
		const call = http.mock.calls[0]?.[0];
		expect(call?.url).toBe("http://localhost:11434/api/chat"); // trailing slash trimmed
		expect(call?.bodyJson).toMatchObject({
			model: "llama3.2",
			stream: false,
			messages: [{ role: "user", content: "Hi" }],
		});
		expect(result).toEqual({
			content: "Hello there",
			provider: OLLAMA_PROVIDER_ID,
			model: "llama3.2",
			finishReason: "stop",
			usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
		});
	});

	it("honours a per-request model + temperature/maxTokens options", async () => {
		const http = vi.fn<OllamaHttp>(async () => cannedOk("ok"));
		const provider = createOllamaProvider({
			endpoint: "http://localhost:11434",
			defaultModel: "llama3.2",
			http,
		});
		await provider.generate({
			messages: [{ role: MessageRole.User, content: "x" }],
			model: "qwen2.5",
			temperature: 0.2,
			maxTokens: 64,
		});
		expect(http.mock.calls[0]?.[0]?.bodyJson).toMatchObject({
			model: "qwen2.5",
			options: { temperature: 0.2, num_predict: 64 },
		});
	});

	it("throws Unavailable when the transport rejects (server down)", async () => {
		const http = vi.fn<OllamaHttp>(async () => {
			throw new Error("ECONNREFUSED");
		});
		const provider = createOllamaProvider({
			endpoint: "http://localhost:11434",
			defaultModel: "m",
			http,
		});
		await expect(
			provider.generate({ messages: [{ role: MessageRole.User, content: "x" }] }),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("throws Unavailable on a non-2xx status", async () => {
		const http = vi.fn<OllamaHttp>(async () => ({ status: 500, text: "boom" }));
		const provider = createOllamaProvider({
			endpoint: "http://localhost:11434",
			defaultModel: "m",
			http,
		});
		await expect(
			provider.generate({ messages: [{ role: MessageRole.User, content: "x" }] }),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("throws Unavailable on a malformed / contentless body", async () => {
		const http = vi.fn<OllamaHttp>(async () => ({ status: 200, text: "{not json" }));
		const provider = createOllamaProvider({
			endpoint: "http://localhost:11434",
			defaultModel: "m",
			http,
		});
		await expect(
			provider.generate({ messages: [{ role: MessageRole.User, content: "x" }] }),
		).rejects.toMatchObject({ name: "Unavailable" });
	});
});
