/**
 * Conversation / messaging contracts (`brainstorm/Conversation/v1` and
 * `brainstorm/Message/v1`) per, plus the
 * app-facing AI-broker request/result surface (`ai.generate`) the
 * Conversation surface drives.
 *
 * **Messaging-compatible foundation.** Doc 55 frames these around the AI
 * Agent app, but the same transcript substrate is the foundation a future
 * human↔human Chats app (v2) builds on. So the sender of a `Message` is a
 * discriminated `MessageSender` union — `user` / `assistant` / `tool`
 * today, with a forward-compat `participant` arm (a `Person/v1` ref) for
 * human messaging — rather than the bare `role: user|assistant|tool` doc
 * 55 sketches. `role` is retained (mapped from the sender) so the AI wire
 * format stays simple. This divergence is a documented position
 * (implementation-plan §Agent app); the AI surface is a strict subset of
 * the messaging surface.
 *
 * **AI capability vocabulary** is shared with the automations contract
 * leaf (`ai.use`, `ai.provider:<id>`) — see `automations.ts`
 * `stepCapabilities`. `aiCapabilitiesForRequest` here mirrors it so the
 * Agent app and a workflow `AICall` step compute identical capability
 * requirements.
 *
 * Dependency-free contract leaf: only the `enum-guard` leaf is imported,
 * so this re-exports through the barrel with no cycle. `EntityId` is a
 * local `string` alias (not the `index.ts` alias) for the same reason.
 */

import { enumGuard } from "./enum-guard";

export const CONVERSATION_TYPE_URL = "brainstorm/Conversation/v1";
export const MESSAGE_TYPE_URL = "brainstorm/Message/v1";

/** `brainstorm/Memory/v1` — Agent-7's opt-in, agent-private long-term memory.
 *  A salient, durable fact the user explicitly stored / confirmed for the
 *  agent to recall across conversations. PRIVATE to the Agent app (not part of
 *  other apps' default reads/retrieval); per-vault. See {@link MemoryDef}. */
export const MEMORY_TYPE_URL = "brainstorm/Memory/v1";

/** The built-in local-model provider id. The capability scope is
 *  `ai.provider:ollama`; the endpoint (default `http://localhost:11434`)
 *  is shell config, never part of the app-facing contract. */
export const OLLAMA_PROVIDER_ID = "ollama";

/** The built-in cloud provider id (Anthropic Claude API). The capability scope
 *  is `ai.provider:anthropic`; the API key is BYO, stored as a Tier-2 shell
 *  credential (11.6) and never part of the app-facing contract. */
export const ANTHROPIC_PROVIDER_ID = "anthropic";

/** OpenAI-compatible cloud provider id (Chat Completions wire shape). The base
 *  URL is configurable, so this one id covers OpenAI, OpenRouter, Together,
 *  Groq, local LM Studio/vLLM, etc. Cap scope `ai.provider:openai`. */
export const OPENAI_PROVIDER_ID = "openai";

/** Google Gemini cloud provider id (`generateContent` wire shape). Cap scope
 *  `ai.provider:gemini`. */
export const GEMINI_PROVIDER_ID = "gemini";

/** z.ai GLM cloud provider id. GLM speaks the OpenAI-compatible Chat Completions
 *  wire shape, so it rides the same provider as OpenAI under its own base URL.
 *  Cap scope `ai.provider:glm`. */
export const GLM_PROVIDER_ID = "glm";

/** Mistral AI cloud provider id — the European model. Mistral's `la Plateforme`
 *  speaks the OpenAI-compatible Chat Completions wire shape, so it rides the same
 *  provider as OpenAI under its own base URL. Cap scope `ai.provider:mistral`. */
export const MISTRAL_PROVIDER_ID = "mistral";

/** Local alias for an entity id — a plain `string` so this contract leaf
 *  stays dependency-free and introduces no barrel cycle. */
type ConversationEntityId = string;

// ───────────────────────────── enums ─────────────────────────────

/** A message's role in the transcript. Doubles as the AI wire-format
 *  role: `ai.generate` sends `{ role, content }[]`. `System` never
 *  originates from a sender — it is the broker-assembled instruction
 *  region (doc 22 §Prompt injection — region tagging). */
export enum MessageRole {
	System = "system",
	User = "user",
	Assistant = "assistant",
	Tool = "tool",
}

export const MESSAGE_ROLES = Object.freeze([
	MessageRole.System,
	MessageRole.User,
	MessageRole.Assistant,
	MessageRole.Tool,
]) as readonly MessageRole[];

/** Who produced a message. The discriminant of `MessageSender`.
 *  `Participant` is the forward-compat arm for human↔human Chats (v2) —
 *  unused by the v1 Agent app but frozen here so the messaging
 *  foundation is shared, not forked. */
export enum SenderKind {
	/** The local user (this device's vault owner). */
	User = "user",
	/** The AI assistant, produced via the broker. */
	Assistant = "assistant",
	/** A tool result fed back into the loop (an intent's output). */
	Tool = "tool",
	/** A remote human participant — a `Person/v1` ref (Chats, v2). */
	Participant = "participant",
}

export const SENDER_KINDS = Object.freeze([
	SenderKind.User,
	SenderKind.Assistant,
	SenderKind.Tool,
	SenderKind.Participant,
]) as readonly SenderKind[];

/** Per-conversation memory scope (doc 55 — mirrors automations'
 *  `MemoryMode`, with conversation-shaped values). */
export enum ConversationMemoryMode {
	/** Context is the transcript only; nothing persists beyond it (default). */
	PerConversation = "per-conversation",
	/** Opt-in: salient facts persist to a private `AgentMemory` entity. */
	LongTerm = "long-term",
}

export const CONVERSATION_MEMORY_MODES = Object.freeze([
	ConversationMemoryMode.PerConversation,
	ConversationMemoryMode.LongTerm,
]) as readonly ConversationMemoryMode[];

/** A streamed-generation event kind. Frozen now so the token-streaming
 *  rung (next slice) drops onto the existing contract; the v1 slice uses
 *  the single-shot `ai.generate` → `AiGenerateResult` path. */
export enum AiStreamEventKind {
	Token = "token",
	Done = "done",
	Error = "error",
}

export const AI_STREAM_EVENT_KINDS = Object.freeze([
	AiStreamEventKind.Token,
	AiStreamEventKind.Done,
	AiStreamEventKind.Error,
]) as readonly AiStreamEventKind[];

export const isMessageRole = enumGuard(MESSAGE_ROLES);
export const isSenderKind = enumGuard(SENDER_KINDS);
export const isConversationMemoryMode = enumGuard(CONVERSATION_MEMORY_MODES);
export const isAiStreamEventKind = enumGuard(AI_STREAM_EVENT_KINDS);

// ──────────────────────────── sender ────────────────────────────

type SenderBase<K extends SenderKind> = { kind: K };

export type UserSender = SenderBase<SenderKind.User>;

export type AssistantSender = SenderBase<SenderKind.Assistant> & {
	provider?: string;
	model?: string;
};

export type ToolSender = SenderBase<SenderKind.Tool> & {
	/** The tool (intent verb) whose output this message carries. */
	name: string;
};

/** Forward-compat: a remote human in a shared conversation (Chats, v2). */
export type ParticipantSender = SenderBase<SenderKind.Participant> & {
	personRef: ConversationEntityId;
	displayName?: string;
};

export type MessageSender = UserSender | AssistantSender | ToolSender | ParticipantSender;

/** The transcript role implied by a sender — the mapping the AI wire
 *  format uses. A remote human participant reads as `User` to the model
 *  (they are an interlocutor, not the assistant). */
export function senderRole(sender: MessageSender): MessageRole {
	switch (sender.kind) {
		case SenderKind.Assistant:
			return MessageRole.Assistant;
		case SenderKind.Tool:
			return MessageRole.Tool;
		default:
			return MessageRole.User;
	}
}

// ──────────────────────── entity payloads ────────────────────────

/** Provenance stamp on an assistant message (doc 22 §Provenance). */
export type AiProvenance = {
	provider: string;
	model: string;
	generatedAt: string;
	costCents?: number;
};

// ───────────────────────── attachments ─────────────────────────
//
// What a sender explicitly attaches to a turn to GROUND it — the input
// counterpart to `citations` (which are the OUTPUT refs an assistant
// produced). A human composing a turn can pin a document, @-mention a
// person, or attach media; the agent reads each and folds it into the
// turn's context (doc 63 — the agent context layer). Shared shape so the
// Agent app, a future human↔human Chats app, and the SDK composer-context
// primitive all speak the same wire format.

/** The kind of context a sender attached to a turn. Discriminant of
 *  {@link MessageAttachment}. */
export enum AttachmentKind {
	/** A vault entity the sender pinned as context (a "document link" — a
	 *  note, page, file, any object). The agent reads its body into context. */
	Entity = "entity",
	/** A `Person/v1` (or participant) the sender @-mentioned. For the agent it
	 *  contributes the person's profile; for human↔human chat it is also the
	 *  addressing/notification target. */
	Person = "person",
	/** An uploaded media asset (image / file). `image` media becomes a vision
	 *  content part (Phase 3); other media is text-extracted into context. */
	Media = "media",
}

export const ATTACHMENT_KINDS = Object.freeze([
	AttachmentKind.Entity,
	AttachmentKind.Person,
	AttachmentKind.Media,
]) as readonly AttachmentKind[];

export const isAttachmentKind = enumGuard(ATTACHMENT_KINDS);

type AttachmentBase<K extends AttachmentKind> = {
	kind: K;
	/** Human-readable label for the chip + transcript render (entity title /
	 *  person name / file name). Denormalised at attach time so the chip survives
	 *  even if the source is later renamed/removed. */
	label?: string;
};

/** A pinned vault entity. `ref` is the entity id (rendered as a real
 *  `brainstorm://` link); `entityType` carries the type for the chip icon. */
export type EntityAttachment = AttachmentBase<AttachmentKind.Entity> & {
	ref: ConversationEntityId;
	entityType?: string;
};

/** An @-mentioned person. `ref` is the `Person/v1` (or participant) id. */
export type PersonAttachment = AttachmentBase<AttachmentKind.Person> & {
	ref: ConversationEntityId;
};

/** An uploaded media asset. `ref` is a `brainstorm://` asset url the app
 *  resolves to bytes; `mediaType` is the MIME; `image` flags vision-eligible
 *  media; `bytes` is the size for the chip + budget. */
export type MediaAttachment = AttachmentBase<AttachmentKind.Media> & {
	ref: string;
	mediaType: string;
	image?: boolean;
	bytes?: number;
};

export type MessageAttachment = EntityAttachment | PersonAttachment | MediaAttachment;

/** `brainstorm/Message/v1` — one turn in a conversation.
 *
 *  `body` is plain text in the v1 slice; the richText (Yjs universal
 *  body) upgrade is a follow-on and does not change this shape (the
 *  text mirror stays as the searchable/denormalized property, same
 *  pattern as Note title/snippet). */
export type MessageDef = {
	conversation: ConversationEntityId;
	sender: MessageSender;
	role: MessageRole;
	/** Plain-text body — the canonical, searchable, agent-readable text. */
	body: string;
	/** Serialized Lexical `EditorState` (JSON) when the message was authored in a
	 *  rich composer. Optional: plain / AI messages carry only `body`. Renderers
	 *  prefer `richBody`; `body` stays the authority for search + agent grounding. */
	richBody?: string;
	/** Vault entities this message draws from — real `brainstorm://`
	 *  links (doc 31). Every assistant factual claim carries citations. */
	citations?: ConversationEntityId[];
	/** Context the SENDER explicitly attached to this turn (pinned documents,
	 *  @-mentioned people, uploaded media) — the input counterpart to
	 *  {@link citations}. The agent reads each into the turn's context. */
	attachments?: MessageAttachment[];
	/** Tool invocations this turn issued (doc 55 — the agent loop). */
	toolCalls?: unknown[];
	aiProvenance?: AiProvenance;
	createdAt: string;
	/** Monotonic order key within the conversation (ties broken by id). */
	seq?: number;
};

/** `brainstorm/Conversation/v1` — a chat thread, an entity (doc 55). */
export type ConversationDef = {
	title: string;
	/** Intents this conversation may use as tools — a subset of the app's
	 *  caps, frozen per conversation (doc 55 §Capabilities). */
	toolGrants?: string[];
	provider?: string;
	model?: string;
	memoryMode: ConversationMemoryMode;
	/** A per-conversation prompt-token budget (Agent-5). When set, the agent
	 *  refuses a turn whose estimated cumulative prompt tokens would exceed it
	 *  (fail-closed — a turn is never run "a bit over"). Absent = unbounded. */
	tokenBudget?: number;
	/** Cumulative prompt tokens estimated/spent so far across this
	 *  conversation's turns (Agent-5) — the running total the budget is checked
	 *  against. Token-based because the built-in local model is free; the cents
	 *  path layers on when a priced provider is configured (11.6). */
	tokensSpent?: number;
	costCents?: number;
	tags?: ConversationEntityId[];
	/** Forward-compat: the participant set for a shared conversation
	 *  (Chats, v2). Absent / `[user, assistant]` for a v1 Agent chat. */
	participants?: MessageSender[];
};

/** `brainstorm/Memory/v1` — Agent-7's long-term memory entity (opt-in,
 *  agent-private). A short, durable, salient fact the agent recalls across
 *  conversations.
 *
 *  PRIVACY MODEL (the resolution this rung takes; doc 55 §Memory / OQ-AG-4):
 *  - Memory is OFF by default — nothing of this type exists until the user
 *    enables it AND explicitly stores/confirms a fact.
 *  - It is created ONLY by an explicit user action: a "remember this"
 *    affordance, or an agent-proposed fact the user confirms — never silent
 *    automatic storage of raw transcripts. The stored `text` is a salient fact,
 *    not a conversation excerpt.
 *  - It is the user's data under their control: every memory is listable,
 *    editable/redactable, and deletable individually + a clear-all.
 *  - It is agent-scoped: the Agent app owns the type and is the only reader;
 *    it is not in other apps' default reads/retrieval. */
export type MemoryDef = {
	/** The salient, durable fact — short plain text. */
	text: string;
	/** ISO timestamp the memory was stored. */
	createdAt: string;
	/** ISO timestamp of the last edit/redaction, when edited. */
	updatedAt?: string;
	/** The conversation this fact was captured from, when it was captured in
	 *  one — provenance only (the memory is recalled regardless of source). */
	source?: ConversationEntityId;
};

// ─────────────────────── AI broker surface ───────────────────────
//
// The app-facing `ai.generate` request/result the Conversation surface
// drives. The app never picks a provider key or reads the vault to build
// context — it sends the turn + transcript, the broker routes to a
// provider (doc 55 §Retrieval; doc 22 §Architecture).

/** The kind of a multimodal content part. Discriminant of {@link AiContentPart}. */
export enum AiContentPartKind {
	Text = "text",
	Image = "image",
}

export const AI_CONTENT_PART_KINDS = Object.freeze([
	AiContentPartKind.Text,
	AiContentPartKind.Image,
]) as readonly AiContentPartKind[];

export const isAiContentPartKind = enumGuard(AI_CONTENT_PART_KINDS);

export type AiTextPart = { kind: AiContentPartKind.Text; text: string };

/** A vision image part: raw base64 `data` (NO `data:` prefix) + its `mimeType`
 *  (`image/png`, `image/jpeg`, …). Providers map it to their own image block. */
export type AiImagePart = { kind: AiContentPartKind.Image; mimeType: string; data: string };

export type AiContentPart = AiTextPart | AiImagePart;

/** One message in an `ai.generate` request — the AI wire format. `content` is
 *  plain text, or a multimodal part list (text + images) for a vision turn; a
 *  provider without vision degrades by using the text parts only. */
export type AiChatMessage = {
	role: MessageRole;
	content: string | AiContentPart[];
};

/** The plain-text projection of a message's content — the text parts joined,
 *  ignoring images. The shared way every text-only consumer (token estimate,
 *  a non-vision provider, the transcript mirror) reads multimodal content. */
export function messageText(content: string | AiContentPart[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p): p is AiTextPart => p.kind === AiContentPartKind.Text)
		.map((p) => p.text)
		.join("\n");
}

export type AiGenerateRequest = {
	messages: readonly AiChatMessage[];
	/** Provider id; the broker picks the configured default when absent. */
	provider?: string;
	/** Model id within the provider; provider default when absent. */
	model?: string;
	temperature?: number;
	maxTokens?: number;
	/** The conversation this turn belongs to (for cost attribution). */
	conversationId?: ConversationEntityId;
};

export type AiUsage = {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
};

export type AiGenerateResult = {
	content: string;
	provider: string;
	model: string;
	finishReason?: string;
	usage?: AiUsage;
};

/**
 * The text-transformation verb (doc 22 §Transformation — `ai.transform`).
 * A closed `kind` vocabulary keeps the broker prompt-construction auditable
 * (mirrors the curated intent-verb namespace); new kinds are shell releases.
 */
export enum AiTransformKind {
	/** Render `source` in another language. `params.to` = target language. */
	Translate = "translate",
	/** Rewrite `source` in a different tone / style / length.
	 *  `params.style` (e.g. "formal", "concise") guides it. */
	Rewrite = "rewrite",
	/** Re-shape `source` into another structure. `params.as`
	 *  (e.g. "bullet points", "table") names the target shape. */
	Format = "format",
}

export const AI_TRANSFORM_KINDS = Object.freeze([
	AiTransformKind.Translate,
	AiTransformKind.Rewrite,
	AiTransformKind.Format,
]) as readonly AiTransformKind[];

export const isAiTransformKind = enumGuard(AI_TRANSFORM_KINDS);

export type AiTransformRequest = {
	/** The text to transform. */
	source: string;
	kind: AiTransformKind;
	/** Kind-specific guidance (`to` / `style` / `as`); all optional — the
	 *  broker falls back to a sensible default instruction per kind. */
	params?: Readonly<Record<string, string>>;
	provider?: string;
	model?: string;
};

/** A transform result — the transformed text plus the same provenance fields
 *  `AiGenerateResult` carries (transform is single-shot generation under the
 *  hood, so the cost/model attribution path is identical). */
export type AiTransformResult = {
	content: string;
	provider: string;
	model: string;
	usage?: AiUsage;
};

/** Build the model transcript for a transform request — a `system`
 *  instruction derived from `kind` + `params`, then the `source` as the
 *  `user` turn. Pure + exhaustive over {@link AiTransformKind} so the broker
 *  handler stays a thin "build → provider.generate → map" shell and the
 *  prompt wording is unit-tested without a model. */
export function buildTransformMessages(req: AiTransformRequest): AiChatMessage[] {
	const p = req.params ?? {};
	let instruction: string;
	switch (req.kind) {
		case AiTransformKind.Translate:
			instruction = p.to
				? `Translate the user's text into ${p.to}. Output only the translation, with no preamble.`
				: "Translate the user's text into English. Output only the translation, with no preamble.";
			break;
		case AiTransformKind.Rewrite:
			instruction = p.style
				? `Rewrite the user's text to be ${p.style}. Preserve its meaning. Output only the rewritten text, with no preamble.`
				: "Rewrite the user's text to improve clarity and flow. Preserve its meaning. Output only the rewritten text, with no preamble.";
			break;
		case AiTransformKind.Format:
			instruction = p.as
				? `Reformat the user's text as ${p.as}. Preserve its content. Output only the reformatted text, with no preamble.`
				: "Reformat the user's text as clean Markdown. Preserve its content. Output only the reformatted text, with no preamble.";
			break;
	}
	return [
		{ role: MessageRole.System, content: instruction },
		{ role: MessageRole.User, content: req.source },
	];
}

/** Static capabilities an `ai.transform` request requires — identical shape
 *  to {@link aiCapabilitiesForRequest} (transform is generation under the
 *  hood), so the proxy + any contract leaf compute the same set. */
export function aiTransformCapabilitiesForRequest(
	req: Pick<AiTransformRequest, "provider">,
): string[] {
	const caps = ["ai.use"];
	if (req.provider) caps.push(`ai.provider:${req.provider}`);
	return caps;
}

/**
 * A rough prompt-size estimate for pre-send budgeting (doc 22 §Cost model).
 * NOT an exact tokenizer — those are model-specific and live provider-side; the
 * true usage comes back in `AiGenerateResult.usage` after the call. This uses
 * the ~4-characters-per-token rule of thumb plus a small per-message overhead
 * for role framing, which is accurate enough for a "this will cost about N
 * tokens" preview in the Agent app / an Automations AI step.
 */
/** Flat per-image token estimate (a vision tile is on the order of hundreds of
 *  tokens; this is the same rough "about N tokens" preview accuracy as the
 *  4-chars/token text rule). */
const IMAGE_TOKEN_ESTIMATE = 512;

export function estimateTokens(messages: readonly AiChatMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += 4;
		if (typeof message.content === "string") {
			total += Math.ceil(message.content.length / 4);
			continue;
		}
		for (const part of message.content) {
			total +=
				part.kind === AiContentPartKind.Image ? IMAGE_TOKEN_ESTIMATE : Math.ceil(part.text.length / 4);
		}
	}
	return total;
}

/** The `ai.cost` result — a pre-send estimate. `costCents` is intentionally
 *  absent until a provider with real pricing is configured (11.6); the token
 *  estimate is the useful signal today (local Ollama is free). */
export type AiCostEstimate = {
	/** Estimated prompt tokens (approximate — see {@link estimateTokens}). */
	promptTokens: number;
	/** The provider that would handle the request (resolved routing). */
	provider: string;
	/** The model that would be used, when the caller pinned one. */
	model?: string;
};

/**
 * Structured extraction (doc 22 §Extraction — `ai.extract`). The caller names
 * the fields to pull out of free text; the broker instructs a JSON response,
 * parses it, and coerces each field to its declared type. The output is a
 * **suggestion** the caller accepts / edits / rejects — never a direct write
 * (doc 22 decision). The `intoType` variant (extract into a known entity type's
 * PropertyDefs) layers on top of this explicit-field form once it resolves the
 * type's schema from the registry.
 */
export enum AiExtractFieldType {
	String = "string",
	Number = "number",
	Boolean = "boolean",
	StringArray = "string[]",
}

export const AI_EXTRACT_FIELD_TYPES = Object.freeze([
	AiExtractFieldType.String,
	AiExtractFieldType.Number,
	AiExtractFieldType.Boolean,
	AiExtractFieldType.StringArray,
]) as readonly AiExtractFieldType[];

export const isAiExtractFieldType = enumGuard(AI_EXTRACT_FIELD_TYPES);

export type AiExtractField = {
	/** The JSON key to extract; also the suggestion's property name. */
	name: string;
	/** Coercion target; defaults to a passthrough (raw JSON value) when absent. */
	type?: AiExtractFieldType;
	/** Optional natural-language hint guiding the model for this field. */
	description?: string;
};

export type AiExtractRequest = {
	source: string;
	fields: readonly AiExtractField[];
	/** The `intoType` variant (doc 22): extract into a known entity type's
	 *  PropertyDefs. The broker resolves the type's schema from the registry
	 *  to {@link AiExtractField}s, so the suggestion's keys are the type's
	 *  property names — ready to map straight onto a new entity of that type.
	 *  Explicit `fields` (when both are given) take precedence by name. */
	intoType?: string;
	provider?: string;
	model?: string;
};

/** The fields a type's inline JSON-Schema (`entity_types.schema`) exposes —
 *  the subset {@link extractFieldsFromTypeSchema} reads. JSON-Schema `type`
 *  is a single name or a `["string","null"]`-style union; `enum` narrows a
 *  string field's allowed values. */
export type TypeSchemaForExtract = {
	properties?: Record<
		string,
		{ type?: string | readonly string[]; description?: string; enum?: readonly unknown[] }
	>;
};

/** Structural / system property names that are never extracted from free text
 *  (assigned by the store or carrying non-textual structure). */
const NON_EXTRACTABLE_PROPS: ReadonlySet<string> = new Set([
	"id",
	"createdAt",
	"updatedAt",
	"values",
	"icon",
	"cover",
]);

/** Pick the first non-`null` JSON-Schema scalar from a `type` declaration
 *  (`"string"` or `["string","null"]`). */
function scalarSchemaType(type: string | readonly string[] | undefined): string | undefined {
	if (typeof type === "string") return type;
	if (Array.isArray(type)) return type.find((t) => t !== "null");
	return undefined;
}

/** Map an entity type's inline JSON-Schema to {@link AiExtractField}s — the
 *  registry coupling behind `ai.extract({ intoType })`. Pure: the broker
 *  injects a port that reads `entity_types.schema` and calls this, so the
 *  wording + skip rules are unit-tested without a model or a vault.
 *
 *  Skips system/structural props (id/timestamps/icon/…) and any property
 *  whose value isn't free-text-extractable (object/array-of-non-string).
 *  An `enum` is surfaced in the field hint so the model picks an allowed value.
 *  Returns `[]` when nothing maps — the handler treats that as fail-closed. */
export function extractFieldsFromTypeSchema(schema: TypeSchemaForExtract): AiExtractField[] {
	const props = schema.properties ?? {};
	const fields: AiExtractField[] = [];
	for (const [name, def] of Object.entries(props)) {
		if (NON_EXTRACTABLE_PROPS.has(name)) continue;
		const scalar = scalarSchemaType(def.type);
		let type: AiExtractFieldType;
		switch (scalar) {
			case "string":
				type = AiExtractFieldType.String;
				break;
			case "number":
			case "integer":
				type = AiExtractFieldType.Number;
				break;
			case "boolean":
				type = AiExtractFieldType.Boolean;
				break;
			case "array":
				type = AiExtractFieldType.StringArray;
				break;
			default:
				// object / null-only / unknown → not extractable from free text.
				continue;
		}
		const hint = Array.isArray(def.enum)
			? `${def.description ? `${def.description}. ` : ""}One of: ${def.enum.join(", ")}`
			: def.description;
		fields.push({ name, type, ...(hint ? { description: hint } : {}) });
	}
	return fields;
}

/** Merge type-derived fields with explicit caller fields — explicit wins by
 *  name, appended fields keep type-schema order then caller order. */
export function mergeExtractFields(
	base: readonly AiExtractField[],
	override: readonly AiExtractField[],
): AiExtractField[] {
	const byName = new Map<string, AiExtractField>();
	for (const f of base) byName.set(f.name, f);
	for (const f of override) byName.set(f.name, f);
	return [...byName.values()];
}

export type AiExtractResult = {
	/** The extracted suggestion — exactly the declared field names, each coerced
	 *  to its type (a field the model omitted / couldn't fill is `null`). */
	fields: Record<string, unknown>;
	provider: string;
	model: string;
	usage?: AiUsage;
};

/** Build the model transcript for an extraction: a `system` instruction naming
 *  the fields + a strict JSON-only directive, then `source` as the `user` turn.
 *  Pure — the wording is unit-tested without a model. */
export function buildExtractMessages(req: AiExtractRequest): AiChatMessage[] {
	const fieldLines = req.fields
		.map((f) => {
			const type = f.type ? ` (${f.type})` : "";
			const hint = f.description ? ` — ${f.description}` : "";
			return `- ${f.name}${type}${hint}`;
		})
		.join("\n");
	const instruction = `Extract the following fields from the user's text. Output ONLY a single JSON object with exactly these keys and no other text, no markdown fences. Use null for any field not present in the text.\n${fieldLines}`;
	return [
		{ role: MessageRole.System, content: instruction },
		{ role: MessageRole.User, content: req.source },
	];
}

/** Coerce one raw JSON value to a declared field type. An uncoercible value
 *  (wrong shape, non-finite number) becomes `null` — extraction is best-effort
 *  and a malformed field should be an empty suggestion, never a thrown error. */
function coerceExtractField(value: unknown, type: AiExtractFieldType | undefined): unknown {
	if (value === undefined) return null;
	switch (type) {
		case AiExtractFieldType.String:
			return value === null ? null : typeof value === "string" ? value : String(value);
		case AiExtractFieldType.Number: {
			const n = typeof value === "number" ? value : Number(value);
			return Number.isFinite(n) ? n : null;
		}
		case AiExtractFieldType.Boolean:
			return typeof value === "boolean" ? value : null;
		case AiExtractFieldType.StringArray:
			return Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : String(v))) : null;
		default:
			return value;
	}
}

/** Parse a model response into the declared fields. Tolerant of the common
 *  ways a model wraps JSON (markdown fences, a leading sentence): slices from
 *  the first `{` to the last `}` before parsing. Returns `null` when no JSON
 *  object can be recovered — the handler maps that to a fail-closed
 *  `Unavailable` rather than a half-empty suggestion. */
export function parseExtractResult(
	text: string,
	fields: readonly AiExtractField[],
): Record<string, unknown> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const raw = parsed as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		out[field.name] = coerceExtractField(raw[field.name], field.type);
	}
	return out;
}

export function aiExtractCapabilitiesForRequest(req: Pick<AiExtractRequest, "provider">): string[] {
	const caps = ["ai.use"];
	if (req.provider) caps.push(`ai.provider:${req.provider}`);
	return caps;
}

/** A streamed-generation event (token-streaming rung). */
export type AiStreamEvent =
	| { kind: AiStreamEventKind.Token; text: string }
	| { kind: AiStreamEventKind.Done; result: AiGenerateResult }
	| { kind: AiStreamEventKind.Error; message: string };

/**
 * The capabilities an `ai.generate` request statically requires — `ai.use`
 * always, plus `ai.provider:<id>` when a specific provider is pinned.
 * Mirrors `automations.ts` `stepCapabilities` for `AICall`/`AIAgent` so
 * the Agent app and a workflow AI step compute identical requirements.
 */
export function aiCapabilitiesForRequest(req: Pick<AiGenerateRequest, "provider">): string[] {
	const caps = ["ai.use"];
	if (req.provider) caps.push(`ai.provider:${req.provider}`);
	return caps;
}

// ──────────────────────────── validators ────────────────────────────
//
// Structural validation only — non-blank required fields, known enum
// members. Each returns a list of stable issue codes so callers localise.

export enum ConversationIssueCode {
	EmptyTitle = "empty-title",
	InvalidMemoryMode = "invalid-memory-mode",
	MissingConversationRef = "missing-conversation-ref",
	InvalidRole = "invalid-role",
	InvalidSenderKind = "invalid-sender-kind",
	MissingCreatedAt = "missing-created-at",
}

export type ConversationIssue = { code: ConversationIssueCode; message: string };

function isBlank(v: unknown): boolean {
	return typeof v !== "string" || v.trim().length === 0;
}

export function validateConversation(def: ConversationDef): ConversationIssue[] {
	const issues: ConversationIssue[] = [];
	if (isBlank(def.title)) {
		issues.push({ code: ConversationIssueCode.EmptyTitle, message: "Conversation title is empty." });
	}
	if (!isConversationMemoryMode(def.memoryMode)) {
		issues.push({
			code: ConversationIssueCode.InvalidMemoryMode,
			message: `Unknown memory mode "${String(def.memoryMode)}".`,
		});
	}
	return issues;
}

export function validateMessage(def: MessageDef): ConversationIssue[] {
	const issues: ConversationIssue[] = [];
	if (isBlank(def.conversation)) {
		issues.push({
			code: ConversationIssueCode.MissingConversationRef,
			message: "Message has no conversation reference.",
		});
	}
	if (!isMessageRole(def.role)) {
		issues.push({
			code: ConversationIssueCode.InvalidRole,
			message: `Unknown message role "${String(def.role)}".`,
		});
	}
	if (!def.sender || !isSenderKind(def.sender.kind)) {
		issues.push({
			code: ConversationIssueCode.InvalidSenderKind,
			message: `Unknown sender kind "${String(def.sender?.kind)}".`,
		});
	}
	if (isBlank(def.createdAt)) {
		issues.push({
			code: ConversationIssueCode.MissingCreatedAt,
			message: "Message has no createdAt timestamp.",
		});
	}
	return issues;
}

export const isValidConversation = (def: ConversationDef): boolean =>
	validateConversation(def).length === 0;
export const isValidMessage = (def: MessageDef): boolean => validateMessage(def).length === 0;

export enum MemoryIssueCode {
	EmptyText = "empty-text",
	MissingCreatedAt = "missing-created-at",
}

export type MemoryIssue = { code: MemoryIssueCode; message: string };

export function validateMemory(def: MemoryDef): MemoryIssue[] {
	const issues: MemoryIssue[] = [];
	if (isBlank(def.text)) {
		issues.push({ code: MemoryIssueCode.EmptyText, message: "Memory text is empty." });
	}
	if (isBlank(def.createdAt)) {
		issues.push({
			code: MemoryIssueCode.MissingCreatedAt,
			message: "Memory has no createdAt timestamp.",
		});
	}
	return issues;
}

export const isValidMemory = (def: MemoryDef): boolean => validateMemory(def).length === 0;
