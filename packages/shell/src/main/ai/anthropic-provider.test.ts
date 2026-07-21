import {
	ANTHROPIC_PROVIDER_ID,
	AiContentPartKind,
	type AiGenerateResult,
	MessageRole,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { type AnthropicHttp, createAnthropicProvider } from "./anthropic-provider";

const OK_BODY = JSON.stringify({
	content: [
		{ type: "text", text: "Hello " },
		{ type: "text", text: "world" },
	],
	model: "claude-opus-4-8",
	stop_reason: "end_turn",
	usage: { input_tokens: 12, output_tokens: 3 },
});

function provider(over: {
	http?: AnthropicHttp;
	getApiKey?: () => Promise<string | null> | string | null;
}) {
	return createAnthropicProvider({
		defaultModel: "claude-opus-4-8",
		getApiKey: over.getApiKey ?? (() => "sk-ant-test"),
		http: over.http ?? vi.fn(async () => ({ status: 200, text: OK_BODY })),
	});
}

describe("createAnthropicProvider (11.6)", () => {
	it("maps multimodal content to text + base64 image blocks (vision)", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await provider({ http }).generate({
			messages: [
				{
					role: MessageRole.User,
					content: [
						{ kind: AiContentPartKind.Text, text: "what is this?" },
						{ kind: AiContentPartKind.Image, mimeType: "image/jpeg", data: "B64" },
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
					{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "B64" } },
				],
			},
		]);
	});

	it("sends the api key + version header and maps system turns to the top-level system field", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await provider({ http }).generate({
			messages: [
				{ role: MessageRole.System, content: "Be terse." },
				{ role: MessageRole.User, content: "Hi" },
			],
			model: "claude-opus-4-8",
		});
		const [call] = (http.mock.calls[0] ?? []) as unknown as [
			{
				headers: Record<string, string>;
				bodyJson: { system?: string; messages: { role: string }[]; max_tokens: number };
			},
		];
		expect(call.headers["x-api-key"]).toBe("sk-ant-test");
		expect(call.headers["anthropic-version"]).toBe("2023-06-01");
		expect(call.bodyJson.system).toBe("Be terse.");
		// System turn is lifted out of messages; only the user turn remains.
		expect(call.bodyJson.messages).toEqual([{ role: "user", content: "Hi" }]);
		expect(call.bodyJson.max_tokens).toBeGreaterThan(0);
	});

	it("concatenates text blocks and returns provider/model/usage provenance", async () => {
		const out = (await provider({}).generate({
			messages: [{ role: MessageRole.User, content: "Hi" }],
		})) as AiGenerateResult;
		expect(out).toEqual({
			content: "Hello world",
			provider: ANTHROPIC_PROVIDER_ID,
			model: "claude-opus-4-8",
			finishReason: "end_turn",
			usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
		});
	});

	it("fails closed with Unavailable when no api key is configured", async () => {
		const http = vi.fn(async () => ({ status: 200, text: OK_BODY }));
		await expect(
			provider({ getApiKey: () => null, http }).generate({
				messages: [{ role: MessageRole.User, content: "Hi" }],
			}),
		).rejects.toMatchObject({ name: "Unavailable" });
		expect(http).not.toHaveBeenCalled(); // never hit the network without a key
	});

	it("rejects a transcript with no non-system message (Invalid)", async () => {
		await expect(
			provider({}).generate({ messages: [{ role: MessageRole.System, content: "only system" }] }),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("maps a non-2xx response and a non-JSON body to Unavailable", async () => {
		await expect(
			provider({ http: vi.fn(async () => ({ status: 401, text: "unauthorized" })) }).generate({
				messages: [{ role: MessageRole.User, content: "Hi" }],
			}),
		).rejects.toMatchObject({ name: "Unavailable" });
		await expect(
			provider({ http: vi.fn(async () => ({ status: 200, text: "<html>" })) }).generate({
				messages: [{ role: MessageRole.User, content: "Hi" }],
			}),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("maps a transport throw to Unavailable", async () => {
		await expect(
			provider({
				http: vi.fn(async () => {
					throw new Error("ECONNREFUSED");
				}),
			}).generate({ messages: [{ role: MessageRole.User, content: "Hi" }] }),
		).rejects.toMatchObject({ name: "Unavailable" });
	});
});
