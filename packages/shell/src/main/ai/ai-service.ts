/**
 * The `ai` broker service — the app-facing surface of the AI foundations
 * (doc 22) and the conversation surface (doc 55). Apps call
 * `services.ai.generate(req)`; the broker has already enforced `ai.use`
 * (the SDK proxy declares it, `broker.checkCapability` verifies it against
 * the ledger). This handler resolves the request to a registered
 * `ModelProvider` and returns the completion. It never holds a provider
 * key or touches the network directly — the provider does, behind the
 * network broker.
 *
 * v1 method: `generate` (single-shot). Streaming is the next rung.
 */

import {
	type AiChatMessage,
	type AiExtractField,
	type AiExtractRequest,
	type AiGenerateRequest,
	type AiTransformRequest,
	buildExtractMessages,
	buildTransformMessages,
	estimateTokens,
	isAiExtractFieldType,
	isAiTransformKind,
	isMessageRole,
	mergeExtractFields,
	parseExtractResult,
} from "@brainstorm/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { AiUsageOutcome, type AiUsageRecord } from "./ai-usage-log";
import { AiServiceError, type ModelProvider } from "./provider";

export type AiServiceOptions = {
	/** Resolve a provider by id; `undefined` asks for the configured
	 *  default. Returns `null` when no usable provider is configured. */
	getProvider: (id: string | undefined) => ModelProvider | null;
	/** 11.8 — sink for per-call provenance. Each model-calling verb
	 *  (generate/transform/extract) records one record on success and on
	 *  failure; `cost` (a pre-send estimate, no model call) records nothing.
	 *  Omitted in tests that don't assert provenance. */
	onUsage?: (record: AiUsageRecord) => void;
	/** Injected clock for the usage record's `ts`/`durationMs`. Default `Date.now`. */
	now?: () => number;
	/** 11.5 `extract({ intoType })` — resolve a registered entity type's
	 *  PropertyDefs to extract fields (registry-coupled; the index wiring reads
	 *  `entity_types.schema`). Returns `null`/`[]` for an unknown / field-less
	 *  type → the handler fails closed. Omitted when no registry is available. */
	resolveTypeFields?: (typeId: string) => Promise<readonly AiExtractField[] | null>;
	/** 14.8 — the per-app budget gate, called BEFORE dispatching each
	 *  model-calling verb (never `cost`, which is a free estimate). Over
	 *  budget → it throws the distinct `AiBudgetExhausted` error; accounting
	 *  store unreadable with a budget set → `Unavailable` (fail-closed).
	 *  Omitted in tests that don't exercise quota. */
	quota?: { checkBudget: (appId: string) => Promise<void> };
};

/** Token usage as the provider reports it (subset of `AiGenerateResult["usage"]`). */
type ProviderUsage = { promptTokens?: number; completionTokens?: number; totalTokens?: number };

function requireRequest(envelope: Envelope): AiGenerateRequest {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object") {
		throw new AiServiceError("Invalid", "ai.generate: argument must be an object");
	}
	const req = arg as { messages?: unknown; provider?: unknown; model?: unknown };
	if (!Array.isArray(req.messages) || req.messages.length === 0) {
		throw new AiServiceError("Invalid", "ai.generate: { messages } must be a non-empty array");
	}
	const messages: AiChatMessage[] = req.messages.map((m, i) => {
		if (!m || typeof m !== "object") {
			throw new AiServiceError("Invalid", `ai.generate: messages[${i}] must be an object`);
		}
		const { role, content } = m as { role?: unknown; content?: unknown };
		if (!isMessageRole(role)) {
			throw new AiServiceError("Invalid", `ai.generate: messages[${i}].role is invalid`);
		}
		if (typeof content !== "string") {
			throw new AiServiceError("Invalid", `ai.generate: messages[${i}].content must be a string`);
		}
		return { role, content };
	});
	if (req.provider !== undefined && typeof req.provider !== "string") {
		throw new AiServiceError("Invalid", "ai.generate: { provider } must be a string");
	}
	if (req.model !== undefined && typeof req.model !== "string") {
		throw new AiServiceError("Invalid", "ai.generate: { model } must be a string");
	}
	return {
		messages,
		...(typeof req.provider === "string" ? { provider: req.provider } : {}),
		...(typeof req.model === "string" ? { model: req.model } : {}),
	};
}

function requireTransformRequest(envelope: Envelope): AiTransformRequest {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object") {
		throw new AiServiceError("Invalid", "ai.transform: argument must be an object");
	}
	const req = arg as {
		source?: unknown;
		kind?: unknown;
		params?: unknown;
		provider?: unknown;
		model?: unknown;
	};
	if (typeof req.source !== "string" || req.source.length === 0) {
		throw new AiServiceError("Invalid", "ai.transform: { source } must be a non-empty string");
	}
	if (!isAiTransformKind(req.kind)) {
		throw new AiServiceError("Invalid", "ai.transform: { kind } is invalid");
	}
	let params: Record<string, string> | undefined;
	if (req.params !== undefined) {
		if (!req.params || typeof req.params !== "object" || Array.isArray(req.params)) {
			throw new AiServiceError("Invalid", "ai.transform: { params } must be an object");
		}
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(req.params as Record<string, unknown>)) {
			if (typeof value !== "string") {
				throw new AiServiceError("Invalid", `ai.transform: params.${key} must be a string`);
			}
			out[key] = value;
		}
		params = out;
	}
	if (req.provider !== undefined && typeof req.provider !== "string") {
		throw new AiServiceError("Invalid", "ai.transform: { provider } must be a string");
	}
	if (req.model !== undefined && typeof req.model !== "string") {
		throw new AiServiceError("Invalid", "ai.transform: { model } must be a string");
	}
	return {
		source: req.source,
		kind: req.kind,
		...(params ? { params } : {}),
		...(typeof req.provider === "string" ? { provider: req.provider } : {}),
		...(typeof req.model === "string" ? { model: req.model } : {}),
	};
}

function requireExtractRequest(envelope: Envelope): AiExtractRequest {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object") {
		throw new AiServiceError("Invalid", "ai.extract: argument must be an object");
	}
	const req = arg as {
		source?: unknown;
		fields?: unknown;
		intoType?: unknown;
		provider?: unknown;
		model?: unknown;
	};
	if (typeof req.source !== "string" || req.source.length === 0) {
		throw new AiServiceError("Invalid", "ai.extract: { source } must be a non-empty string");
	}
	if (
		req.intoType !== undefined &&
		(typeof req.intoType !== "string" || req.intoType.length === 0)
	) {
		throw new AiServiceError("Invalid", "ai.extract: { intoType } must be a non-empty string");
	}
	const hasIntoType = typeof req.intoType === "string";
	// `fields` is the explicit form; with `intoType` the broker derives them
	// from the type schema, so an absent/empty `fields` is allowed then.
	if (req.fields !== undefined && !Array.isArray(req.fields)) {
		throw new AiServiceError("Invalid", "ai.extract: { fields } must be an array");
	}
	const rawFields = Array.isArray(req.fields) ? req.fields : [];
	if (rawFields.length === 0 && !hasIntoType) {
		throw new AiServiceError("Invalid", "ai.extract: provide { fields } (non-empty) or { intoType }");
	}
	const fields: AiExtractField[] = rawFields.map((f, i) => {
		if (!f || typeof f !== "object") {
			throw new AiServiceError("Invalid", `ai.extract: fields[${i}] must be an object`);
		}
		const { name, type, description } = f as {
			name?: unknown;
			type?: unknown;
			description?: unknown;
		};
		if (typeof name !== "string" || name.length === 0) {
			throw new AiServiceError("Invalid", `ai.extract: fields[${i}].name must be a non-empty string`);
		}
		if (type !== undefined && !isAiExtractFieldType(type)) {
			throw new AiServiceError("Invalid", `ai.extract: fields[${i}].type is invalid`);
		}
		if (description !== undefined && typeof description !== "string") {
			throw new AiServiceError("Invalid", `ai.extract: fields[${i}].description must be a string`);
		}
		return {
			name,
			...(type !== undefined ? { type } : {}),
			...(typeof description === "string" ? { description } : {}),
		};
	});
	if (req.provider !== undefined && typeof req.provider !== "string") {
		throw new AiServiceError("Invalid", "ai.extract: { provider } must be a string");
	}
	if (req.model !== undefined && typeof req.model !== "string") {
		throw new AiServiceError("Invalid", "ai.extract: { model } must be a string");
	}
	return {
		source: req.source,
		fields,
		...(typeof req.intoType === "string" ? { intoType: req.intoType } : {}),
		...(typeof req.provider === "string" ? { provider: req.provider } : {}),
		...(typeof req.model === "string" ? { model: req.model } : {}),
	};
}

/** Resolve the provider for a verb, failing closed (`Unavailable`) when none
 *  is configured — shared by every method so the error wording stays uniform. */
function resolveProvider(
	options: AiServiceOptions,
	id: string | undefined,
	verb: string,
): ModelProvider {
	const provider = options.getProvider(id);
	if (!provider) {
		throw new AiServiceError(
			"Unavailable",
			id
				? `ai.${verb}: no provider "${id}" is configured`
				: `ai.${verb}: no AI provider is configured`,
		);
	}
	return provider;
}

/** The model-calling verbs that record provenance (11.8). `cost` is excluded —
 *  it estimates without calling a provider. */
const RECORDED_VERBS: ReadonlySet<string> = new Set(["generate", "transform", "extract"]);

export function makeAiServiceHandler(options: AiServiceOptions): ServiceHandler {
	const clock = options.now ?? Date.now;
	return async (envelope: Envelope): Promise<unknown> => {
		const startedMs = clock();
		let recorded = false;
		const record = (
			provider: string,
			model: string,
			usage: ProviderUsage | undefined,
			outcome: AiUsageOutcome,
		): void => {
			recorded = true;
			if (!options.onUsage) return;
			const promptTokens = usage?.promptTokens ?? 0;
			const completionTokens = usage?.completionTokens ?? 0;
			options.onUsage({
				ts: clock(),
				appId: envelope.app,
				verb: envelope.method,
				provider,
				model,
				promptTokens,
				completionTokens,
				totalTokens: usage?.totalTokens ?? promptTokens + completionTokens,
				outcome,
				durationMs: clock() - startedMs,
			});
		};
		try {
			// 14.8 — budget gate ahead of every model-calling verb. `cost` is
			// excluded (pre-send estimate, no tokens consumed). A rejection here
			// still lands an error provenance row via the catch below.
			if (options.quota && RECORDED_VERBS.has(envelope.method)) {
				await options.quota.checkBudget(envelope.app);
			}
			switch (envelope.method) {
				case "generate": {
					const req = requireRequest(envelope);
					const result = await resolveProvider(options, req.provider, "generate").generate(req);
					record(result.provider, result.model, result.usage, AiUsageOutcome.Ok);
					return result;
				}
				case "cost": {
					// Same request shape as generate; estimate without calling the model.
					const req = requireRequest(envelope);
					const provider = resolveProvider(options, req.provider, "cost");
					return {
						promptTokens: estimateTokens(req.messages),
						provider: provider.id,
						...(req.model ? { model: req.model } : {}),
					};
				}
				case "transform": {
					const req = requireTransformRequest(envelope);
					const provider = resolveProvider(options, req.provider, "transform");
					const result = await provider.generate({
						messages: buildTransformMessages(req),
						...(req.provider ? { provider: req.provider } : {}),
						...(req.model ? { model: req.model } : {}),
					});
					record(result.provider, result.model, result.usage, AiUsageOutcome.Ok);
					return {
						content: result.content,
						provider: result.provider,
						model: result.model,
						...(result.usage ? { usage: result.usage } : {}),
					};
				}
				case "extract": {
					const req = requireExtractRequest(envelope);
					// `intoType` (11.5): derive fields from the type's registered
					// schema, then let any explicit fields override by name. Fail
					// closed when the type is unknown / exposes nothing extractable.
					let fieldSet = req.fields;
					if (req.intoType) {
						const typeFields = (await options.resolveTypeFields?.(req.intoType)) ?? null;
						if (!typeFields || typeFields.length === 0) {
							throw new AiServiceError(
								"Unavailable",
								`ai.extract: type "${req.intoType}" has no extractable fields`,
							);
						}
						fieldSet = mergeExtractFields(typeFields, req.fields);
					}
					const provider = resolveProvider(options, req.provider, "extract");
					const result = await provider.generate({
						messages: buildExtractMessages({ ...req, fields: fieldSet }),
						...(req.provider ? { provider: req.provider } : {}),
						...(req.model ? { model: req.model } : {}),
					});
					const fields = parseExtractResult(result.content, fieldSet);
					if (!fields) {
						record(result.provider, result.model, result.usage, AiUsageOutcome.Error);
						throw new AiServiceError("Unavailable", "ai.extract: model did not return valid JSON");
					}
					record(result.provider, result.model, result.usage, AiUsageOutcome.Ok);
					return {
						fields,
						provider: result.provider,
						model: result.model,
						...(result.usage ? { usage: result.usage } : {}),
					};
				}
				default:
					throw new AiServiceError("Invalid", `unknown ai method: ${envelope.method}`);
			}
		} catch (error) {
			// Error provenance for the model-calling verbs (provider/model unknown
			// on a pre-call failure). The re-throw is unchanged — recording is a
			// side effect, never alters the caller's result/error.
			if (!recorded && RECORDED_VERBS.has(envelope.method)) {
				record("", "", undefined, AiUsageOutcome.Error);
			}
			throw error;
		}
	};
}
