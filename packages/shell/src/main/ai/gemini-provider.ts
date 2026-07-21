/**
 * Google Gemini cloud provider (11.6+) — the `generateContent` wire shape.
 * Same seam as the other cloud providers (injected transport over the network
 * broker, lazy BYO key, fail closed, pure + unit-testable), but a distinct
 * request shape: `system` turns become a top-level `systemInstruction`, the
 * remaining turns map to `contents` with Gemini's `user`/`model` roles (it has
 * no `assistant`), and auth rides the `x-goog-api-key` header.
 */

import {
	type AiChatMessage,
	AiContentPartKind,
	type AiGenerateRequest,
	type AiGenerateResult,
	GEMINI_PROVIDER_ID,
	MessageRole,
	messageText,
} from "@brainstorm-os/sdk-types";
import { AiServiceError, type ModelProvider, buildUsage } from "./provider";

/** A Gemini `parts` entry (the subset we emit). */
type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** Map our wire content to Gemini `parts`: text → `{text}`, image → `{inlineData}`. */
function toGeminiParts(content: AiChatMessage["content"]): GeminiPart[] {
	if (typeof content === "string") return [{ text: content }];
	return content.map((part) =>
		part.kind === AiContentPartKind.Image
			? { inlineData: { mimeType: part.mimeType, data: part.data } }
			: { text: part.text },
	);
}

export type GeminiHttp = (input: {
	url: string;
	headers: Record<string, string>;
	bodyJson: unknown;
	signal?: AbortSignal;
}) => Promise<{ status: number; text: string }>;

export type GeminiProviderConfig = {
	/** API base; defaults to the public Generative Language API. */
	baseUrl?: string;
	/** Model used when a request pins none (e.g. `gemini-2.0-flash`). */
	defaultModel: string;
	getApiKey: () => Promise<string | null> | string | null;
	http: GeminiHttp;
};

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

type GeminiResponse = {
	candidates?: ReadonlyArray<{
		content?: { parts?: ReadonlyArray<{ text?: string }> };
		finishReason?: string;
	}>;
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

/** Gemini uses `model` for the assistant role and has no system role in
 *  `contents` — system text rides `systemInstruction` instead. */
function geminiRole(role: string): "user" | "model" {
	return role === MessageRole.Assistant ? "model" : "user";
}

export function createGeminiProvider(config: GeminiProviderConfig): ModelProvider {
	const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	return {
		id: GEMINI_PROVIDER_ID,
		async generate(req: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateResult> {
			const apiKey = await config.getApiKey();
			if (!apiKey) {
				throw new AiServiceError(
					"Unavailable",
					"ai.generate: no Gemini API key is configured (add one in Settings → AI)",
				);
			}
			const model = req.model ?? config.defaultModel;
			const systemText = req.messages
				.filter((m: AiChatMessage) => m.role === MessageRole.System)
				.map((m) => messageText(m.content))
				.join("\n\n");
			const contents = req.messages
				.filter((m: AiChatMessage) => m.role !== MessageRole.System)
				.map((m) => ({ role: geminiRole(m.role), parts: toGeminiParts(m.content) }));
			if (contents.length === 0) {
				throw new AiServiceError(
					"Invalid",
					"ai.generate: a request needs at least one non-system message",
				);
			}
			const body = {
				...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
				contents,
			};

			let res: { status: number; text: string };
			try {
				res = await config.http({
					url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
					headers: { "x-goog-api-key": apiKey },
					bodyJson: body,
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				throw new AiServiceError("Unavailable", `Gemini API unreachable: ${(error as Error).message}`);
			}

			if (res.status < 200 || res.status >= 300) {
				throw new AiServiceError(
					"Unavailable",
					`Gemini API returned HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`,
				);
			}

			let parsed: GeminiResponse;
			try {
				parsed = JSON.parse(res.text) as GeminiResponse;
			} catch {
				throw new AiServiceError("Unavailable", "Gemini API returned a non-JSON response.");
			}

			const candidate = parsed.candidates?.[0];
			const content = (candidate?.content?.parts ?? [])
				.map((p) => p.text)
				.filter((t): t is string => typeof t === "string")
				.join("");
			if (!content) {
				throw new AiServiceError("Unavailable", "Gemini response had no text content.");
			}

			const usage = buildUsage(
				parsed.usageMetadata?.promptTokenCount,
				parsed.usageMetadata?.candidatesTokenCount,
			);
			return {
				content,
				provider: GEMINI_PROVIDER_ID,
				model,
				...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
				...(usage ? { usage } : {}),
			};
		},
	};
}
