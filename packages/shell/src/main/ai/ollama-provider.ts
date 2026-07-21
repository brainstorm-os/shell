/**
 * Ollama local-model provider — the v1-beta `ModelProvider` (doc 22
 * §On-device). Talks the native Ollama chat API (`POST /api/chat`,
 * `stream:false`) over the injected `OllamaHttp` transport. In production
 * that transport rides the network broker's `executeNetworkFetch` with
 * `allowPrivate` (Ollama listens on `localhost:11434`); in tests it's a
 * canned function, so this module is pure and runtime-agnostic.
 *
 * The endpoint + default model are shell config (env / vault AI settings),
 * never part of the app-facing contract — the app sends a transcript and
 * gets a completion.
 */

import {
	type AiChatMessage,
	AiContentPartKind,
	type AiGenerateRequest,
	type AiGenerateResult,
	OLLAMA_PROVIDER_ID,
	messageText,
} from "@brainstorm-os/sdk-types";
import { AiServiceError, type ModelProvider } from "./provider";

/** Map our wire content to an Ollama chat message: text rides `content`, images
 *  ride the `images` array as raw base64 (Ollama's native vision shape). */
function toOllamaMessage(m: AiChatMessage): { role: string; content: string; images?: string[] } {
	if (typeof m.content === "string") return { role: m.role, content: m.content };
	const images = m.content
		.filter((p) => p.kind === AiContentPartKind.Image)
		.map((p) => (p.kind === AiContentPartKind.Image ? p.data : ""));
	const base = { role: m.role, content: messageText(m.content) };
	return images.length > 0 ? { ...base, images } : base;
}

/** Minimal HTTP transport: POST a JSON body, get status + raw text back.
 *  Production wraps `executeNetworkFetch({ allowPrivate: true })`. */
export type OllamaHttp = (input: {
	url: string;
	bodyJson: unknown;
	signal?: AbortSignal;
}) => Promise<{ status: number; text: string }>;

export type OllamaProviderConfig = {
	/** Base URL, e.g. `http://localhost:11434`. Trailing slash tolerated. */
	endpoint: string;
	/** Model used when a request pins none, e.g. `llama3.2`. */
	defaultModel: string;
	http: OllamaHttp;
};

/** Ollama `/api/chat` non-streaming response (the fields we read). */
type OllamaChatResponse = {
	message?: { role?: string; content?: string };
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
};

function chatUrl(endpoint: string): string {
	return `${endpoint.replace(/\/+$/, "")}/api/chat`;
}

export function createOllamaProvider(config: OllamaProviderConfig): ModelProvider {
	return {
		id: OLLAMA_PROVIDER_ID,
		async generate(req: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateResult> {
			const model = req.model ?? config.defaultModel;
			const body = {
				model,
				messages: req.messages.map(toOllamaMessage),
				stream: false,
				...(req.temperature !== undefined || req.maxTokens !== undefined
					? {
							options: {
								...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
								...(req.maxTokens !== undefined ? { num_predict: req.maxTokens } : {}),
							},
						}
					: {}),
			};

			let res: { status: number; text: string };
			try {
				res = await config.http({
					url: chatUrl(config.endpoint),
					bodyJson: body,
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				throw new AiServiceError(
					"Unavailable",
					`Ollama unreachable at ${config.endpoint}: ${(error as Error).message}`,
				);
			}

			if (res.status < 200 || res.status >= 300) {
				throw new AiServiceError(
					"Unavailable",
					`Ollama returned HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`,
				);
			}

			let parsed: OllamaChatResponse;
			try {
				parsed = JSON.parse(res.text) as OllamaChatResponse;
			} catch {
				throw new AiServiceError("Unavailable", "Ollama returned a non-JSON response.");
			}

			const content = parsed.message?.content;
			if (typeof content !== "string") {
				throw new AiServiceError("Unavailable", "Ollama response had no message content.");
			}

			const promptTokens = parsed.prompt_eval_count;
			const completionTokens = parsed.eval_count;
			const usage =
				promptTokens !== undefined || completionTokens !== undefined
					? {
							...(promptTokens !== undefined ? { promptTokens } : {}),
							...(completionTokens !== undefined ? { completionTokens } : {}),
							...(promptTokens !== undefined && completionTokens !== undefined
								? { totalTokens: promptTokens + completionTokens }
								: {}),
						}
					: undefined;

			return {
				content,
				provider: OLLAMA_PROVIDER_ID,
				model,
				...(parsed.done_reason ? { finishReason: parsed.done_reason } : {}),
				...(usage ? { usage } : {}),
			};
		},
	};
}
