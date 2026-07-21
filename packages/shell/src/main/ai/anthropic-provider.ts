/**
 * Anthropic Claude cloud provider — the first BYO cloud `ModelProvider` (11.6),
 * sibling to the local Ollama provider. Talks the Claude Messages API
 * (`POST /v1/messages`) over the injected `AnthropicHttp` transport; in
 * production that transport rides the network broker's `executeNetworkFetch`
 * (public host, SSRF + size/time caps + host/path-only audit — the `x-api-key`
 * header is forwarded but never logged), so this module is pure and
 * runtime-agnostic and unit-tests against a canned transport.
 *
 * The API key is fetched lazily per request via `getApiKey` (the shell's
 * Tier-2 credential store / dev env) — it is read only here, in the main
 * process, and never crosses IPC to an app. A request with no key fails closed
 * (`Unavailable`), never silently succeeds.
 *
 * Maps the app-facing transcript to the Claude wire shape: `system`-role turns
 * become the top-level `system` field (Claude does not accept a system role in
 * `messages`); the rest pass through as user/assistant turns.
 */

import {
	ANTHROPIC_PROVIDER_ID,
	type AiChatMessage,
	AiContentPartKind,
	type AiGenerateRequest,
	type AiGenerateResult,
	MessageRole,
	messageText,
} from "@brainstorm-os/sdk-types";
import { AiServiceError, type ModelProvider, buildUsage } from "./provider";

/** A Claude Messages content block (the subset we emit). */
type AnthropicBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** Map our wire content to a Claude turn `content`: a plain string stays a
 *  string; a multimodal part list becomes text + image blocks. */
function toAnthropicContent(content: AiChatMessage["content"]): string | AnthropicBlock[] {
	if (typeof content === "string") return content;
	return content.map((part) =>
		part.kind === AiContentPartKind.Image
			? {
					type: "image",
					source: { type: "base64", media_type: part.mimeType, data: part.data },
				}
			: { type: "text", text: part.text },
	);
}

/** HTTP transport: POST a JSON body with caller-supplied headers, get status +
 *  raw text. Production wraps `executeNetworkFetch` (no `allowPrivate` — the
 *  Claude API is a public host). */
export type AnthropicHttp = (input: {
	url: string;
	headers: Record<string, string>;
	bodyJson: unknown;
	signal?: AbortSignal;
}) => Promise<{ status: number; text: string }>;

export type AnthropicProviderConfig = {
	/** Messages endpoint; defaults to the public Claude API. */
	endpoint?: string;
	/** Model used when a request pins none (e.g. `claude-opus-4-8`). */
	defaultModel: string;
	/** `max_tokens` when a request pins none. Claude requires the field. */
	defaultMaxTokens?: number;
	/** Resolve the BYO API key (credential store / env). `null` = not configured. */
	getApiKey: () => Promise<string | null> | string | null;
	http: AnthropicHttp;
};

/** The Messages API version header value. */
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MAX_TOKENS = 4096;

/** Claude Messages API response (the fields we read). */
type AnthropicMessagesResponse = {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
	model?: string;
	stop_reason?: string;
	usage?: { input_tokens?: number; output_tokens?: number };
};

function splitSystem(messages: readonly AiChatMessage[]): {
	system: string;
	turns: { role: string; content: string | AnthropicBlock[] }[];
} {
	const system = messages
		.filter((m) => m.role === MessageRole.System)
		.map((m) => messageText(m.content))
		.join("\n\n");
	const turns = messages
		.filter((m) => m.role !== MessageRole.System)
		.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
	return { system, turns };
}

export function createAnthropicProvider(config: AnthropicProviderConfig): ModelProvider {
	const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
	return {
		id: ANTHROPIC_PROVIDER_ID,
		async generate(req: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateResult> {
			const apiKey = await config.getApiKey();
			if (!apiKey) {
				throw new AiServiceError(
					"Unavailable",
					"ai.generate: no Anthropic API key is configured (add one in Settings → AI)",
				);
			}
			const model = req.model ?? config.defaultModel;
			const { system, turns } = splitSystem(req.messages);
			if (turns.length === 0) {
				throw new AiServiceError(
					"Invalid",
					"ai.generate: a request needs at least one non-system message",
				);
			}
			const body = {
				model,
				max_tokens: req.maxTokens ?? config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
				...(system ? { system } : {}),
				messages: turns,
			};

			let res: { status: number; text: string };
			try {
				res = await config.http({
					url: endpoint,
					headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
					bodyJson: body,
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				throw new AiServiceError(
					"Unavailable",
					`Anthropic API unreachable: ${(error as Error).message}`,
				);
			}

			if (res.status < 200 || res.status >= 300) {
				// The body never contains the key; cap the echo so a large error
				// page can't flood the log / error surface.
				throw new AiServiceError(
					"Unavailable",
					`Anthropic API returned HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`,
				);
			}

			let parsed: AnthropicMessagesResponse;
			try {
				parsed = JSON.parse(res.text) as AnthropicMessagesResponse;
			} catch {
				throw new AiServiceError("Unavailable", "Anthropic API returned a non-JSON response.");
			}

			const content = (parsed.content ?? [])
				.filter((b) => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("");
			if (!content) {
				throw new AiServiceError("Unavailable", "Anthropic response had no text content.");
			}

			const usage = buildUsage(parsed.usage?.input_tokens, parsed.usage?.output_tokens);

			return {
				content,
				provider: ANTHROPIC_PROVIDER_ID,
				model: parsed.model ?? model,
				...(parsed.stop_reason ? { finishReason: parsed.stop_reason } : {}),
				...(usage ? { usage } : {}),
			};
		},
	};
}
