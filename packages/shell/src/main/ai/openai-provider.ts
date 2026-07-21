/**
 * OpenAI-compatible cloud provider (11.6+) — the Chat Completions wire shape,
 * which a large ecosystem speaks: OpenAI itself, OpenRouter, Together, Groq,
 * Fireworks, and local LM Studio / vLLM. The base URL is configurable (one
 * provider id, many backends); the rest mirrors the Anthropic provider —
 * injected `OpenAiHttp` transport over the network broker, lazy BYO key, fail
 * closed when unconfigured, pure + unit-testable.
 *
 * Unlike Anthropic, the Chat Completions API takes `system` as an ordinary
 * message role, so the transcript passes through unchanged.
 */

import {
	type AiChatMessage,
	AiContentPartKind,
	type AiGenerateRequest,
	type AiGenerateResult,
	OPENAI_PROVIDER_ID,
} from "@brainstorm-os/sdk-types";
import { AiServiceError, type ModelProvider, buildUsage } from "./provider";

/** Map our wire content to the Chat Completions `content` field: a plain string
 *  stays a string; a multimodal part list becomes the `[{type:"text"}|
 *  {type:"image_url"}]` array (images as `data:` URLs). */
function toOpenAiContent(
	content: AiChatMessage["content"],
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
	if (typeof content === "string") return content;
	return content.map((part) =>
		part.kind === AiContentPartKind.Image
			? { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
			: { type: "text", text: part.text },
	);
}

/** HTTP transport: POST a JSON body with caller-supplied headers; production
 *  wraps `executeNetworkFetch` (public host, no `allowPrivate`). */
export type OpenAiHttp = (input: {
	url: string;
	headers: Record<string, string>;
	bodyJson: unknown;
	signal?: AbortSignal;
}) => Promise<{ status: number; text: string }>;

export type OpenAiProviderConfig = {
	/** Provider id this instance registers under, and reports as `provider` in
	 *  results. Defaults to `OPENAI_PROVIDER_ID`; an OpenAI-compatible backend
	 *  (e.g. z.ai GLM) registers under its own id with its own base URL. */
	id?: string;
	/** Human-facing name for error messages (`"OpenAI"`, `"GLM"`). */
	label?: string;
	/** Chat Completions base URL (no trailing `/chat/completions`). Defaults to
	 *  the OpenAI public API; point it at any OpenAI-compatible endpoint. */
	baseUrl?: string;
	/** Model used when a request pins none (e.g. `gpt-4o-mini`). */
	defaultModel: string;
	defaultMaxTokens?: number;
	getApiKey: () => Promise<string | null> | string | null;
	http: OpenAiHttp;
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_TOKENS = 4096;

type OpenAiResponse = {
	choices?: ReadonlyArray<{ message?: { content?: string }; finish_reason?: string }>;
	model?: string;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function completionsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function createOpenAiProvider(config: OpenAiProviderConfig): ModelProvider {
	const url = completionsUrl(config.baseUrl ?? DEFAULT_BASE_URL);
	const id = config.id ?? OPENAI_PROVIDER_ID;
	const label = config.label ?? "OpenAI";
	return {
		id,
		async generate(req: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateResult> {
			const apiKey = await config.getApiKey();
			if (!apiKey) {
				throw new AiServiceError(
					"Unavailable",
					`ai.generate: no ${label} API key is configured (add one in Settings → AI)`,
				);
			}
			const model = req.model ?? config.defaultModel;
			const body = {
				model,
				messages: req.messages.map((m: AiChatMessage) => ({
					role: m.role,
					content: toOpenAiContent(m.content),
				})),
				max_tokens: req.maxTokens ?? config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
			};

			let res: { status: number; text: string };
			try {
				res = await config.http({
					url,
					headers: { Authorization: `Bearer ${apiKey}` },
					bodyJson: body,
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				throw new AiServiceError(
					"Unavailable",
					`${label} API unreachable: ${(error as Error).message}`,
				);
			}

			if (res.status < 200 || res.status >= 300) {
				throw new AiServiceError(
					"Unavailable",
					`${label} API returned HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`,
				);
			}

			let parsed: OpenAiResponse;
			try {
				parsed = JSON.parse(res.text) as OpenAiResponse;
			} catch {
				throw new AiServiceError("Unavailable", `${label} API returned a non-JSON response.`);
			}

			const choice = parsed.choices?.[0];
			const content = choice?.message?.content;
			if (typeof content !== "string" || content.length === 0) {
				throw new AiServiceError("Unavailable", `${label} response had no message content.`);
			}

			const usage = buildUsage(parsed.usage?.prompt_tokens, parsed.usage?.completion_tokens);
			return {
				content,
				provider: id,
				model: parsed.model ?? model,
				...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
				...(usage ? { usage } : {}),
			};
		},
	};
}
