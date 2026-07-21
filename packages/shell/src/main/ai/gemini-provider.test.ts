import {
	AiContentPartKind,
	type AiGenerateResult,
	GEMINI_PROVIDER_ID,
	MessageRole,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { type GeminiHttp, createGeminiProvider } from "./gemini-provider";

const OK_BODY = JSON.stringify({
	candidates: [
		{ content: { parts: [{ text: "Hello " }, { text: "world" }] }, finishReason: "STOP" },
	],
	usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
});

function provider(over: {
	http?: GeminiHttp;
	getApiKey?: () => Promise<string | null> | string | null;
}) {
	return createGeminiProvider({
		defaultModel: "gemini-2.0-flash",
		getApiKey: over.getApiKey ?? (() => "g-test"),
		http: over.http ?? vi.fn(async () => ({ status: 200, text: OK_BODY })),
	});
}

describe("createGeminiProvider", () => {
	it("maps multimodal content to text + inlineData parts (vision)", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await provider({ http }).generate({
			messages: [
				{
					role: MessageRole.User,
					content: [
						{ kind: AiContentPartKind.Text, text: "what is this?" },
						{ kind: AiContentPartKind.Image, mimeType: "image/webp", data: "B64" },
					],
				},
			],
		});
		const [call] = (http.mock.calls[0] ?? []) as unknown as [
			{ bodyJson: { contents: Array<{ parts: unknown[] }> } },
		];
		expect(call.bodyJson.contents[0]?.parts).toEqual([
			{ text: "what is this?" },
			{ inlineData: { mimeType: "image/webp", data: "B64" } },
		]);
	});

	it("lifts system → systemInstruction, maps assistant→model, and auths via x-goog-api-key", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await provider({ http }).generate({
			messages: [
				{ role: MessageRole.System, content: "Be terse." },
				{ role: MessageRole.User, content: "Hi" },
				{ role: MessageRole.Assistant, content: "Hello" },
			],
			model: "gemini-2.0-flash",
		});
		const [call] = (http.mock.calls[0] ?? []) as unknown as [
			{
				url: string;
				headers: Record<string, string>;
				bodyJson: {
					systemInstruction?: { parts: { text: string }[] };
					contents: { role: string; parts: { text: string }[] }[];
				};
			},
		];
		expect(call.url).toContain("/models/gemini-2.0-flash:generateContent");
		expect(call.headers["x-goog-api-key"]).toBe("g-test");
		expect(call.bodyJson.systemInstruction).toEqual({ parts: [{ text: "Be terse." }] });
		expect(call.bodyJson.contents).toEqual([
			{ role: "user", parts: [{ text: "Hi" }] },
			{ role: "model", parts: [{ text: "Hello" }] },
		]);
	});

	it("concatenates candidate parts + maps usageMetadata", async () => {
		const out = (await provider({}).generate({
			messages: [{ role: MessageRole.User, content: "Hi" }],
		})) as AiGenerateResult;
		expect(out).toEqual({
			content: "Hello world",
			provider: GEMINI_PROVIDER_ID,
			model: "gemini-2.0-flash",
			finishReason: "STOP",
			usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
		});
	});

	it("fails closed (Unavailable) with no key; rejects a system-only transcript (Invalid)", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await expect(
			provider({ getApiKey: () => null, http }).generate({
				messages: [{ role: MessageRole.User, content: "Hi" }],
			}),
		).rejects.toMatchObject({ name: "Unavailable" });
		expect(http).not.toHaveBeenCalled();
		await expect(
			provider({}).generate({ messages: [{ role: MessageRole.System, content: "only system" }] }),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("maps a non-2xx, a non-JSON body, and a transport throw to Unavailable", async () => {
		for (const http of [
			vi.fn(async () => ({ status: 403, text: "forbidden" })),
			vi.fn(async () => ({ status: 200, text: "<html>" })),
			vi.fn(async () => {
				throw new Error("ETIMEDOUT");
			}),
		]) {
			await expect(
				provider({ http }).generate({ messages: [{ role: MessageRole.User, content: "Hi" }] }),
			).rejects.toMatchObject({ name: "Unavailable" });
		}
	});
});
