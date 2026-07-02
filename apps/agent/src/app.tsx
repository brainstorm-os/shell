import { useVaultEntities } from "@brainstorm/react-yjs";
import { type OpenCapableRuntime, openEntity } from "@brainstorm/sdk";
import {
	type AgentLoopResult,
	type AgentLoopStep,
	AgentStopReason,
	type AiChatMessage,
	AiContentPartKind,
	type AiImagePart,
	type AiProvenance,
	AttachmentKind,
	CONVERSATION_TYPE_URL,
	ConversationMemoryMode,
	MEMORY_TYPE_URL,
	MESSAGE_TYPE_URL,
	type MessageAttachment,
	MessageRole,
	OLLAMA_PROVIDER_ID,
	type PlatformCatalog,
	SenderKind,
	ToolRefusalReason,
	capabilityImplies,
	intersectAgentTools,
} from "@brainstorm/sdk-types";
import {
	AttachContextButton,
	type ComposerContextHost,
	ComposerContextRail,
	type ContextCandidate,
	MEDIA_BYTES_MAX,
	attachmentLabel,
	parseAttachments,
	pickFile,
	useComposerContext,
	useMentionTypeahead,
} from "@brainstorm/sdk/composer-context";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { Markdown } from "@brainstorm/sdk/markdown";
import {
	type ObjectMenuContext,
	ObjectMenuMoreButton,
	type ObjectMenuRuntime,
	ObjectMenuTrigger,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { friendlyTypeName } from "@brainstorm/sdk/system-entities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { ConversationSettingsPopover } from "./conversation-settings-popover";
import { EscalationPrompt } from "./escalation-prompt";
import { AGENT_I18N, type AgentI18nKey, t } from "./i18n";
import { curatedAgentTools, effectiveAgentCapabilities } from "./logic/agent-tools";
import {
	buildAttachmentsContextBlock,
	buildMediaContextBlock,
	isImageMime,
	isTextExtractableMime,
	toReference,
} from "./logic/attachments-context";
import {
	BudgetVerdict,
	accrueSpend,
	budgetCheck,
	defaultGrants,
	estimateTurnTokens,
	grantCapability,
	grantsCover,
	providerForRequest,
	resolveProvider,
} from "./logic/conversation-settings";
import {
	MEMORY_ENABLED_KEY,
	type MemoryItem,
	buildMemoryContextBlock,
	buildMemoryDraft,
	buildMemoryEdit,
	isMemoryEnabled,
	memoriesFromEntities,
} from "./logic/memory";
import { seedFromProcessIntent } from "./logic/process-intent";
import {
	type CitationLink,
	RETRIEVAL_TOP_K,
	buildRetrievalContextBlock,
	citationsToLinks,
	retrieveContext,
	titleMapFromItems,
} from "./logic/retrieval";
import {
	type GeneralizeInput,
	type WorkflowDraft,
	generalizeConversationToWorkflow,
} from "./logic/save-as-automation";
import { persistWorkflowDraft } from "./logic/save-as-automation-persist";
import {
	buildAiMessages,
	deriveConversationTitle,
	linkifyEntityRefs,
	sortMessages,
} from "./logic/transcript";
import { runAgentTurn, usedToolNames } from "./logic/turn";
import { buildVaultDataContextBlock } from "./logic/vault-data-context";
import { buildWorkspaceContextBlock, joinContextBlocks } from "./logic/workspace-context";
import { MemoryPopover } from "./memory-popover";
import { getBrainstorm } from "./runtime";
import { SaveAsAutomationPopover } from "./save-as-automation-popover";

type VaultEntity = { id: string; type: string; properties: Record<string, unknown> };

type UiMessage = {
	id: string;
	role: string;
	body: string;
	createdAt: string;
	seq?: number;
	model?: string;
	/** Tool verbs this assistant turn ran (Agent-3) — surfaced as a compact
	 *  "used tool X" affordance. */
	tools?: string[];
	/** Cited vault-object links (Agent-4) — clickable, labelled by title,
	 *  opened via the cap-checked `open` intent. Resolved from the turn's
	 *  retrieval hits at send time; rehydrated (id-as-label) on reload. */
	citations?: CitationLink[];
	/** Context the user explicitly attached to this turn (pinned documents /
	 *  people / media) — rendered as chips on the user bubble. */
	attachments?: MessageAttachment[];
	/** Assistant body with `[<id>] <title>` citations rewritten to markdown
	 *  entity links (`linkifyEntityRefs`) — precomputed once per message-list
	 *  change so the transcript map doesn't re-linkify on every keystroke. */
	bodyMarkdown?: string;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Base64-encode bytes in chunks (a single `String.fromCharCode(...bytes)` on a
 *  multi-MB image overflows the call stack). */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** Replace the last user turn's content with a multimodal part list (its text +
 *  the attached images) so the model sees the images. No images → unchanged. */
function withImageParts(
	transcript: readonly AiChatMessage[],
	images: readonly AiImagePart[],
): AiChatMessage[] {
	if (images.length === 0) return [...transcript];
	const out = [...transcript];
	for (let i = out.length - 1; i >= 0; i--) {
		const m = out[i];
		if (m && m.role === MessageRole.User) {
			const text = typeof m.content === "string" ? m.content : "";
			out[i] = {
				role: MessageRole.User,
				content: [{ kind: AiContentPartKind.Text, text }, ...images],
			};
			break;
		}
	}
	return out;
}

/** Provider-aware "model unavailable" guidance (F-259): the local model points
 *  at `ollama serve`; a cloud provider points at its API key in Settings; AUTO
 *  (shell-routed, provider unknown) gets a general "pick / set up a provider".
 *  The old single message hard-coded the Ollama hint for every provider — a
 *  cloud-key failure wrongly told users to start a local model. */
export function unavailableMessage(provider: string | undefined): string {
	if (!provider) return t("error.unavailable.auto");
	if (provider === OLLAMA_PROVIDER_ID) return t("error.unavailable");
	const labelKey = `provider.${provider}` as AgentI18nKey;
	const name = labelKey in AGENT_I18N ? t(labelKey) : provider;
	return t("error.unavailable.cloud", { provider: name });
}

/** A positive finite number from an untyped persisted property, else undefined. */
function posNum(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** A non-negative finite number from an untyped persisted property, else 0. */
function nonNeg(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** The conversation's stored tool grants, when present and well-formed. A
 *  missing / malformed value means "not narrowed yet" — the caller defaults to
 *  the full app caps so behaviour is unchanged until the user narrows. */
function storedGrants(properties: Record<string, unknown>): string[] | null {
	const raw = properties.toolGrants;
	if (!Array.isArray(raw)) return null;
	const grants = raw.filter((g): g is string => typeof g === "string");
	return grants.length === raw.length && grants.length > 0 ? grants : null;
}

/** Pull the dispatched tool verbs out of a persisted `toolCalls` (the loop's
 *  `AgentLoopStep[]`) for the "used tool X" affordance. Tolerant of the
 *  untyped persisted shape. */
function toolNamesFromSteps(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const names: string[] = [];
	for (const step of raw) {
		if (
			step &&
			typeof step === "object" &&
			(step as { kind?: unknown }).kind === "tool-result" &&
			typeof (step as { tool?: unknown }).tool === "string"
		) {
			names.push((step as { tool: string }).tool);
		}
	}
	return names;
}

/** Coerce a persisted `toolCalls` (the loop's `AgentLoopStep[]`) back to typed
 *  steps for the save-as-automation generalizer. Keeps only well-formed members
 *  (a string `kind`); tolerant of the untyped persisted shape. */
function loopStepsFromProperty(raw: unknown): AgentLoopStep[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(step): step is AgentLoopStep =>
			!!step && typeof step === "object" && typeof (step as { kind?: unknown }).kind === "string",
	);
}

/** The capabilities the curated `open` tool would need to dispatch a given
 *  verb — `intents.dispatch:<verb>`. Mirrors `agentToolCapabilities` for the
 *  refusal→grant mapping without importing the tool object. */
function capForVerb(verb: string): string {
	return `intents.dispatch:${verb}`;
}

/** Pull the verbs the loop REFUSED for a capability reason out of a persisted
 *  `toolCalls` (the loop's `AgentLoopStep[]`). These are the candidates for an
 *  inline escalation prompt — the model wanted a tool the conversation's grants
 *  don't cover. Tolerant of the untyped persisted shape. */
function refusedVerbsFromSteps(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const verbs: string[] = [];
	for (const step of raw) {
		if (
			step &&
			typeof step === "object" &&
			(step as { kind?: unknown }).kind === "tool-refused" &&
			(step as { reason?: unknown }).reason === ToolRefusalReason.CapabilityDenied &&
			typeof (step as { tool?: unknown }).tool === "string"
		) {
			verbs.push((step as { tool: string }).tool);
		}
	}
	return verbs;
}

/** Persisted `citations` is a plain `string[]` of entity ids (the Message/v1
 *  schema). On reload we have no retrieval titles, so the id is its own label
 *  via {@link citationsToLinks} with an empty title map. */
function citationsFromProperty(raw: unknown): CitationLink[] {
	if (!Array.isArray(raw)) return [];
	return citationsToLinks(
		raw.filter((c): c is string => typeof c === "string"),
		new Map(),
	);
}

/** Stable per-occurrence keys for the tool chips — a verb may appear more than
 *  once in a turn, so key by `verb#<occurrence>` rather than the array index. */
function toolChips(tools: readonly string[]): { key: string; tool: string }[] {
	const counts = new Map<string, number>();
	return tools.map((tool) => {
		const n = counts.get(tool) ?? 0;
		counts.set(tool, n + 1);
		return { key: `${tool}#${n}`, tool };
	});
}

/** The Agent's own bookkeeping types — excluded from the vault-data tally so
 *  the agent reports the user's content, not its own transcript (doc 63). */
const AGENT_OWN_TYPES: ReadonlySet<string> = new Set([
	CONVERSATION_TYPE_URL,
	MESSAGE_TYPE_URL,
	MEMORY_TYPE_URL,
]);

const SIDEBAR_OPEN_KEY = "agent:sidebar-open";

function readSidebarOpen(): boolean {
	try {
		const raw = localStorage.getItem(SIDEBAR_OPEN_KEY);
		return raw === null ? true : raw === "true";
	} catch {
		return true;
	}
}

// Identity of a turn within a conversation: role + seq (NOT body), so two
// identical messages stay distinct and an echo collapses only against its own
// persisted twin. Falls back to id when seq is absent.
const turnKey = (m: { role: string; seq?: number; id: string }): string =>
	`${m.role}#${m.seq ?? m.id}`;

export function AgentApp(): ReactElement {
	const rt = getBrainstorm();
	const vaultEntities = rt?.services?.vaultEntities ?? null;
	const entitiesSvc = rt?.services?.entities ?? null;
	const aiSvc = rt?.services?.ai ?? null;
	const intentsSvc = rt?.services?.intents ?? null;
	const searchSvc = rt?.services?.search ?? null;
	const storageSvc = rt?.services?.storage ?? null;
	const platformSvc = rt?.services?.platform ?? null;
	const appCaps = rt?.capabilities ?? null;

	const { entities } = useVaultEntities(vaultEntities);
	const all = entities as unknown as VaultEntity[];

	const conversations = useMemo(
		// ids are time-sortable ULIDs (`ent_<ULID>`) — newest first.
		() => all.filter((e) => e.type === CONVERSATION_TYPE_URL).sort((a, b) => (a.id < b.id ? 1 : -1)),
		[all],
	);

	// Agent-7 — the vault's stored memories (agent-private), newest first. Read
	// from the SAME live snapshot the app already subscribes to; no new cross-app
	// read surface. Surfaced in the manager UI and (when enabled) injected into
	// the turn's context for recall.
	const memories = useMemo<MemoryItem[]>(
		() => memoriesFromEntities(all.filter((e) => e.type === MEMORY_TYPE_URL)),
		[all],
	);

	const [activeId, setActiveId] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Agent-6 — the save-as-automation review dialog. `draft` is the generalized
	// Workflow/v1 the user reviews before it is written; null = closed.
	const [saveDraft, setSaveDraft] = useState<WorkflowDraft | null>(null);
	const [savingAutomation, setSavingAutomation] = useState(false);
	// Agent-7 — long-term memory (opt-in, OFF by default). `memoryEnabled` is the
	// per-vault flag from `storage.kv` (null = not yet loaded); the manager dialog
	// is `memoryOpen`. Memory recall + writes are no-ops while disabled.
	const [memoryEnabled, setMemoryEnabled] = useState<boolean>(false);
	const [memoryOpen, setMemoryOpen] = useState(false);
	// A user-dismissed escalation prompt for a capability, so it doesn't re-appear
	// for the rest of the session after "Not now" (per active conversation).
	const [dismissedEscalations, setDismissedEscalations] = useState<Set<string>>(new Set());

	// doc 63 — the platform catalog (apps + their object types + action
	// vocabulary). Fetched once: it changes only on install/uninstall, so a
	// per-turn refetch would be wasteful. Fail-soft — no service / a throw leaves
	// `catalog` null and the turn runs without the workspace preamble.
	const [catalog, setCatalog] = useState<PlatformCatalog | null>(null);
	useEffect(() => {
		if (!platformSvc) return;
		let cancelled = false;
		platformSvc
			.catalog()
			.then((c) => {
				if (!cancelled) setCatalog(c);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [platformSvc]);
	const workspaceBlock = useMemo(
		() => (catalog ? buildWorkspaceContextBlock(catalog) : ""),
		[catalog],
	);
	// doc 63 (slice 3) — what's actually in the vault right now, from the same
	// live snapshot. Recomputes as entities change so the agent's next turn sees
	// fresh counts.
	const vaultBlock = useMemo(() => buildVaultDataContextBlock(all, AGENT_OWN_TYPES), [all]);

	const activeConv = conversations.find((c) => c.id === activeId) ?? null;

	// The conversation's stored tool grants (Agent-5) — the THIRD tier's input.
	// Defaults to the FULL app caps when the conversation hasn't narrowed yet, so
	// behaviour is unchanged until the user toggles a tool off. SECURITY: this is
	// the only thing feeding `conversationGrants`; the three-tier intersection
	// (`effectiveAgentCapabilities`) is still the single chokepoint.
	const conversationGrants = useMemo<string[]>(() => {
		const caps = appCaps ?? [];
		const stored = activeConv ? storedGrants(activeConv.properties) : null;
		return stored ?? defaultGrants(caps);
	}, [appCaps, activeConv]);

	// The conversation's pinned provider/model (Agent-5). The provider falls back
	// to AUTO (shell routing) when the app no longer holds its cap.
	const conversationProvider = useMemo(
		() => providerForRequest(resolveProvider(appCaps ?? [], str(activeConv?.properties.provider))),
		[appCaps, activeConv],
	);
	const conversationModel = str(activeConv?.properties.model) || undefined;

	// The conversation's token budget + spend so far (Agent-5).
	const tokenBudget = activeConv ? posNum(activeConv.properties.tokenBudget) : undefined;
	const tokensSpent = activeConv ? nonNeg(activeConv.properties.tokensSpent) : 0;

	// The tool-enabled turn (Agent-3): the curated tools fail-closed-intersected
	// against the THREE-tier ceiling. `frozenCapabilities` = the conversation's
	// effective set = intersect(conversationGrants, appCaps); `offeredTools` is
	// the loop's intersection of the curated tools against that frozen set. When
	// no tools survive (or the intents service is absent), the turn falls back to
	// Agent-2 plain chat.
	const frozenCapabilities = useMemo(
		() => effectiveAgentCapabilities(appCaps ?? [], conversationGrants),
		[appCaps, conversationGrants],
	);
	const offeredTools = useMemo(
		// `t` is typed to the app's catalog keys; the curated-tool labels ARE
		// catalog keys, so widen the callable to the helper's `(string) => string`.
		() =>
			intersectAgentTools(
				curatedAgentTools((k) => t(k as AgentI18nKey)),
				frozenCapabilities,
			),
		[frozenCapabilities],
	);
	const toolsEnabled = intentsSvc !== null && offeredTools.length > 0;
	const [sidebarOpen, setSidebarOpen] = useState<boolean>(readSidebarOpen);
	const toggleSidebar = useCallback(() => {
		setSidebarOpen((open) => {
			const next = !open;
			try {
				localStorage.setItem(SIDEBAR_OPEN_KEY, String(next));
			} catch {}
			return next;
		});
	}, []);
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Composer context rail (the @mention / doc-link attach affordance). The
	// user pins documents / people the turn should ground on; the host search
	// runs over the live vault snapshot (the app holds `entities.read:*`),
	// excluding the agent's own bookkeeping types. Media attach lands in a later
	// phase — the host omits `attachMedia` for now, so the attach menu shows only
	// the mention path.
	const attachments = useComposerContext();
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const contextHost = useMemo<ComposerContextHost>(
		() => ({
			searchCandidates: async (query: string) => {
				const q = query.trim().toLowerCase();
				const matches: ContextCandidate[] = [];
				for (const e of all) {
					if (AGENT_OWN_TYPES.has(e.type)) continue;
					const title = str(e.properties.title) || str(e.properties.name) || "";
					if (!title) continue;
					if (q && !title.toLowerCase().includes(q)) continue;
					const isPerson = e.type === "brainstorm/Person/v1" || e.type.endsWith("/Person/v1");
					matches.push({
						id: e.id,
						kind: isPerson ? AttachmentKind.Person : AttachmentKind.Entity,
						label: title,
						entityType: e.type,
						description: friendlyTypeName(e.type),
					});
					if (matches.length >= 8) break;
				}
				return matches;
			},
		}),
		[all],
	);
	const mention = useMentionTypeahead({
		host: contextHost,
		value: input,
		setValue: setInput,
		textareaRef: composerRef,
		onAttach: attachments.add,
		ariaLabel: t("composer.attach.search"),
		emptyLabel: t("composer.attach.empty"),
	});
	// Side stores for attached media, keyed by the uploaded asset url. Decoded
	// text grounds the agent (Phase 2); image bytes become a vision content part
	// at send (Phase 3). Both are per-draft — cleared when the turn sends. The
	// persisted attachment only carries the url + mime, so this never bloats the
	// vault; the content is delivered at send time, which is when it matters.
	const mediaTextRef = useRef<Map<string, string>>(new Map());
	const mediaBytesRef = useRef<Map<string, { bytes: Uint8Array; mime: string }>>(new Map());
	const handleUploadMedia = useCallback(async () => {
		if (!storageSvc?.uploadFile) return;
		const file = await pickFile();
		if (!file) return;
		if (file.size > MEDIA_BYTES_MAX) {
			setError(t("composer.attach.tooLarge"));
			return;
		}
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const mime = file.type || "application/octet-stream";
			const uploaded = await storageSvc.uploadFile(file.name, bytes, mime);
			const image = isImageMime(mime);
			if (image) {
				mediaBytesRef.current.set(uploaded.url, { bytes, mime });
			} else if (isTextExtractableMime(mime)) {
				mediaTextRef.current.set(uploaded.url, new TextDecoder().decode(bytes));
			}
			attachments.add({
				kind: AttachmentKind.Media,
				ref: uploaded.url,
				mediaType: mime,
				label: file.name,
				...(image ? { image: true } : {}),
				bytes: uploaded.size,
			});
		} catch (err) {
			console.warn("[agent] media upload failed:", err);
			setError(t("composer.attach.uploadFailed"));
		}
	}, [storageSvc, attachments]);
	// Removing a chip must also drop its per-draft media payload, or the decoded
	// bytes/text would be retained for the app's lifetime (the send-time cleanup
	// only frees what was actually sent).
	const removeAttachment = useCallback(
		(ref: string) => {
			mediaTextRef.current.delete(ref);
			mediaBytesRef.current.delete(ref);
			attachments.remove(ref);
		},
		[attachments],
	);
	const clearDraftContext = useCallback(() => {
		mediaTextRef.current.clear();
		mediaBytesRef.current.clear();
		attachments.clear();
	}, [attachments]);
	// Optimistic echoes of the turn being sent, keyed by conversation. The
	// transcript renders these immediately so the user's message and the model's
	// reply appear the instant generation returns — NOT gated on the persisted
	// entity round-tripping back through the live vault snapshot (a slow/dropped
	// broadcast otherwise leaves a successful reply invisible). Each echo is
	// pruned once its persisted twin shows up in the snapshot.
	const [pending, setPending] = useState<{ convId: string; msg: UiMessage }[]>([]);

	// Default the selection to the most recent conversation once one exists.
	useEffect(() => {
		if (activeId === null && conversations.length > 0) {
			setActiveId(conversations[0]?.id ?? null);
		}
	}, [activeId, conversations]);

	// Agent-7 — load the per-vault opt-in flag once. Fail-safe: any read error
	// (or a missing/malformed value) leaves memory OFF.
	useEffect(() => {
		if (!storageSvc) return;
		let cancelled = false;
		void storageSvc
			.get(MEMORY_ENABLED_KEY)
			.then((raw) => {
				if (!cancelled) setMemoryEnabled(isMemoryEnabled(raw));
			})
			.catch(() => {
				if (!cancelled) setMemoryEnabled(false);
			});
		return () => {
			cancelled = true;
		};
	}, [storageSvc]);

	const messages = useMemo<UiMessage[]>(() => {
		if (!activeId) return [];
		const rows: UiMessage[] = all
			.filter((e) => e.type === MESSAGE_TYPE_URL && str(e.properties.conversation) === activeId)
			.map((e) => {
				const seq = e.properties.seq;
				const model = (e.properties.aiProvenance as AiProvenance | undefined)?.model;
				const tools = toolNamesFromSteps(e.properties.toolCalls);
				const citations = citationsFromProperty(e.properties.citations);
				const attachments = parseAttachments(e.properties.attachments);
				return {
					id: e.id,
					role: str(e.properties.role),
					body: str(e.properties.body),
					createdAt: str(e.properties.createdAt),
					...(typeof seq === "number" ? { seq } : {}),
					...(model ? { model } : {}),
					...(tools.length > 0 ? { tools } : {}),
					...(citations.length > 0 ? { citations } : {}),
					...(attachments.length > 0 ? { attachments } : {}),
				};
			});
		return sortMessages(rows);
	}, [all, activeId]);

	// Merge persisted messages with any optimistic echoes for this conversation
	// that the snapshot hasn't surfaced yet. Matched by role + seq (NOT body) so
	// two identical turns ("ok", "ok") stay distinct bubbles and only collapse
	// against their own persisted twin once it arrives.
	const displayMessages = useMemo<UiMessage[]>(() => {
		let merged = messages;
		if (activeId) {
			const seen = new Set(messages.map(turnKey));
			const echoes = pending
				.filter((p) => p.convId === activeId)
				.filter((p) => !seen.has(turnKey(p.msg)))
				.map((p) => p.msg);
			if (echoes.length > 0) merged = sortMessages([...messages, ...echoes]);
		}
		return merged.map((m) =>
			m.role === MessageRole.Assistant ? { ...m, bodyMarkdown: linkifyEntityRefs(m.body) } : m,
		);
	}, [messages, pending, activeId]);

	// Drop echoes the snapshot has caught up on, so `pending` can't grow without
	// bound across a session.
	useEffect(() => {
		const seen = new Set(messages.map(turnKey));
		setPending((prev) => {
			const next = prev.filter((p) => !seen.has(turnKey(p.msg)));
			return next.length === prev.length ? prev : next;
		});
	}, [messages]);

	// Inline mid-conversation escalation (Agent-5): the capability the agent loop
	// most recently REFUSED for being outside the conversation's grants — the one
	// candidate for an explicit-consent grant prompt. A refusal is actionable only
	// when the cap is one the APP holds (so granting it stays ⊆ app-caps), the
	// conversation does NOT already cover it, and the user hasn't dismissed it.
	const pendingEscalationCap = useMemo<string | null>(() => {
		if (!activeId) return null;
		// Scan newest message first for a capability-refused verb.
		const convMessages = all
			.filter((e) => e.type === MESSAGE_TYPE_URL && str(e.properties.conversation) === activeId)
			.sort((a, b) => (a.id < b.id ? 1 : -1));
		const held = (cap: string): boolean => (appCaps ?? []).some((a) => capabilityImplies(a, cap));
		for (const m of convMessages) {
			for (const verb of refusedVerbsFromSteps(m.properties.toolCalls)) {
				const cap = capForVerb(verb);
				if (!held(cap) || dismissedEscalations.has(cap) || grantsCover(conversationGrants, cap)) {
					continue;
				}
				return cap;
			}
		}
		return null;
	}, [all, activeId, appCaps, conversationGrants, dismissedEscalations]);

	// Persist a narrowed grant set / pinned provider / token budget on the active
	// conversation (Agent-5). Each is a fail-soft `update` — a write hiccup
	// surfaces in the console, never throws into the UI. No-op without an active
	// conversation (a fresh chat has no entity to patch yet).
	const persistConversation = useCallback(
		(patch: Record<string, unknown>) => {
			if (!entitiesSvc || !activeId) return;
			void entitiesSvc.update(activeId, patch).catch((err) => {
				console.warn("[agent] failed to update conversation settings:", err);
			});
		},
		[entitiesSvc, activeId],
	);

	// Explicit-consent escalation: extend the conversation's grants with the
	// refused capability. SECURITY: routed through `grantCapability`, which adds
	// the cap ONLY when the app holds it (a no-op otherwise) — so consent can
	// never broaden past the app's manifest. User action only; never automatic.
	const allowEscalation = useCallback(
		(cap: string) => {
			const next = grantCapability(appCaps ?? [], conversationGrants, cap);
			persistConversation({ toolGrants: next });
		},
		[appCaps, conversationGrants, persistConversation],
	);
	// Agent-7 — persist the opt-in flag. Toggling OFF leaves stored memories in
	// place (the user can still see + delete them) but stops recall + new writes.
	const toggleMemoryEnabled = useCallback(
		(next: boolean) => {
			setMemoryEnabled(next);
			if (!storageSvc) return;
			void storageSvc.put(MEMORY_ENABLED_KEY, next).catch((err) => {
				console.warn("[agent] failed to persist memory opt-in:", err);
			});
		},
		[storageSvc],
	);

	// Agent-7 — store a salient fact as a `Memory/v1` entity (explicit consent
	// path; never automatic). No-op while memory is disabled or the text distils
	// to nothing. Writes ride the cap-checked entities service under
	// `entities.write:brainstorm/Memory/v1` (no wildcard).
	const rememberFact = useCallback(
		(text: string) => {
			if (!entitiesSvc || !memoryEnabled) return;
			const draft = buildMemoryDraft(text, activeId ? { source: activeId } : undefined);
			if (!draft) return;
			void entitiesSvc.create(MEMORY_TYPE_URL, draft).catch((err) => {
				console.warn("[agent] failed to store memory:", err);
			});
		},
		[entitiesSvc, memoryEnabled, activeId],
	);

	const editMemory = useCallback(
		(entityId: string, text: string) => {
			if (!entitiesSvc) return;
			const patch = buildMemoryEdit(text);
			if (!patch) return;
			void entitiesSvc.update(entityId, patch).catch((err) => {
				console.warn("[agent] failed to edit memory:", err);
			});
		},
		[entitiesSvc],
	);

	const deleteMemory = useCallback(
		(entityId: string) => {
			if (!entitiesSvc) return;
			void entitiesSvc.delete(entityId).catch((err) => {
				console.warn("[agent] failed to delete memory:", err);
			});
		},
		[entitiesSvc],
	);

	const clearAllMemories = useCallback(() => {
		if (!entitiesSvc) return;
		for (const m of memories) {
			void entitiesSvc.delete(m.entityId).catch((err) => {
				console.warn("[agent] failed to clear memory:", err);
			});
		}
	}, [entitiesSvc, memories]);

	// Agent-6 — the active conversation's executed loop steps + seed instruction,
	// the raw material the save-as-automation generalizer distils. Steps are
	// aggregated across the conversation's assistant messages (each persists its
	// turn's `toolCalls`); the instruction is the FIRST user turn (the seed task).
	// `ranTools` gates the affordance — only a conversation that actually
	// dispatched a tool can become an automation.
	const conversationRun = useMemo<{ steps: AgentLoopStep[]; instruction: string }>(() => {
		if (!activeId) return { steps: [], instruction: "" };
		const convMessages = all
			.filter((e) => e.type === MESSAGE_TYPE_URL && str(e.properties.conversation) === activeId)
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		const steps: AgentLoopStep[] = [];
		let instruction = "";
		for (const m of convMessages) {
			if (str(m.properties.role) === MessageRole.User && instruction === "") {
				instruction = str(m.properties.body);
			}
			steps.push(...loopStepsFromProperty(m.properties.toolCalls));
		}
		return { steps, instruction };
	}, [all, activeId]);
	const ranTools = useMemo(
		() => conversationRun.steps.some((s) => s.kind === "tool-result"),
		[conversationRun],
	);

	// Open the review dialog: generalize the conversation into a Workflow/v1 draft.
	// SECURITY: the generalizer asserts the draft's caps ⊆ the conversation's
	// frozen set; a refusal (no tools / cap-exceeded) surfaces an inline error
	// rather than writing anything.
	const openSaveAutomation = useCallback(() => {
		setError(null);
		const generalizeInput: GeneralizeInput = {
			steps: conversationRun.steps,
			instruction: conversationRun.instruction,
			offeredTools,
			frozenCapabilities,
			conversationTitle: str(activeConv?.properties.title) || t("chat.untitled"),
			...(conversationProvider ? { provider: conversationProvider } : {}),
			...(conversationModel ? { model: conversationModel } : {}),
		};
		const res = generalizeConversationToWorkflow(generalizeInput);
		if (!res.ok) {
			setError(t("saveAuto.noTools"));
			return;
		}
		setSaveDraft(res.draft);
	}, [
		conversationRun,
		offeredTools,
		frozenCapabilities,
		activeConv,
		conversationProvider,
		conversationModel,
	]);

	// Commit the reviewed draft: create the Trigger + Workflow entities through the
	// cap-checked entities service. The draft's caps are already proven ⊆ frozen.
	const confirmSaveAutomation = useCallback(async () => {
		if (!entitiesSvc || !saveDraft) return;
		setSavingAutomation(true);
		try {
			await persistWorkflowDraft(entitiesSvc, saveDraft);
			setSaveDraft(null);
		} catch (err) {
			console.error("[agent] save-as-automation failed:", err);
			setError(t("saveAuto.error"));
		} finally {
			setSavingAutomation(false);
		}
	}, [entitiesSvc, saveDraft]);

	const dismissEscalation = useCallback((cap: string) => {
		setDismissedEscalations((prev) => {
			if (prev.has(cap)) return prev;
			const next = new Set(prev);
			next.add(cap);
			return next;
		});
	}, []);

	const endRef = useRef<HTMLDivElement | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are scroll triggers (new message / thinking state), not values read in the body.
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "end" });
	}, [displayMessages.length, sending]);

	const newChat = useCallback(() => {
		setActiveId(null);
		setError(null);
		setInput("");
		clearDraftContext();
		setSettingsOpen(false);
		setSaveDraft(null);
		setDismissedEscalations(new Set());
	}, [clearDraftContext]);

	const selectConversation = useCallback((id: string) => {
		setActiveId(id);
		setError(null);
		setSettingsOpen(false);
		setSaveDraft(null);
		setDismissedEscalations(new Set());
	}, []);

	const send = useCallback(async () => {
		const text = input.trim();
		// Snapshot the attached context before we clear the rail; a turn can be
		// just attachments + an implicit "look at this" with no typed text.
		const attached = attachments.attachments;
		if ((!text && attached.length === 0) || sending || !entitiesSvc || !aiSvc) return;
		setError(null);

		// Budget gate (Agent-5) — FAIL CLOSED. Estimate this turn's prompt size
		// from the full transcript + the user's new turn; refuse the turn rather
		// than overspend when it would push cumulative spend past the budget. The
		// estimate uses the same rough tokenizer the broker's `ai.cost` does, so
		// the gate matches the pre-send preview. Computed before any persistence.
		const projectedTranscript = buildAiMessages([
			...messages,
			{ id: "pending", role: MessageRole.User, body: text, createdAt: new Date().toISOString() },
		]);
		const turnTokens = estimateTurnTokens(projectedTranscript);
		const budget = budgetCheck(tokenBudget, tokensSpent, turnTokens);
		if (budget.verdict === BudgetVerdict.Exceeds) {
			setError(t("error.budget"));
			return;
		}

		setSending(true);
		setInput("");
		attachments.clear();

		try {
			let convId = activeId;
			if (!convId) {
				const conv = await entitiesSvc.create(CONVERSATION_TYPE_URL, {
					title: deriveConversationTitle(
						text || (attached[0]?.label ?? t("chat.untitled")),
						t("chat.untitled"),
					),
					memoryMode: ConversationMemoryMode.PerConversation,
				});
				convId = conv.id;
				setActiveId(convId);
			}

			const now = new Date().toISOString();
			// Base the turn index on what's visible (persisted + pending echoes), so
			// consecutive turns get increasing seq even while a broadcast lags.
			const userSeq = displayMessages.length;
			// Optimistically echo the user's turn so it shows instantly.
			setPending((prev) => [
				...prev,
				{
					convId,
					msg: {
						id: `pending-user-${now}`,
						role: MessageRole.User,
						body: text,
						createdAt: now,
						seq: userSeq,
						...(attached.length > 0 ? { attachments: attached } : {}),
					},
				},
			]);
			await entitiesSvc.create(MESSAGE_TYPE_URL, {
				conversation: convId,
				sender: { kind: SenderKind.User },
				role: MessageRole.User,
				body: text,
				createdAt: now,
				seq: userSeq,
				...(attached.length > 0 ? { attachments: attached } : {}),
			});

			// The full prior transcript (system region included for plain chat;
			// the agent loop prepends its OWN tool manifest, so the tool path
			// strips the system region back off below).
			const transcript = buildAiMessages([
				...messages,
				{ id: "pending", role: MessageRole.User, body: text, createdAt: now },
			]);

			// Broker-assembled hybrid retrieval (Agent-4): fetch the top-K relevant
			// vault objects over the capability-gated search service (the app holds
			// NO entities.read for retrieval). Fail-soft — no service / empty / a
			// throw all degrade to ungrounded chat. The bounded context block grounds
			// the model so it can cite real ids; the title map resolves those ids to
			// link labels. The agent's OWN Conversation/Message/Memory objects are
			// excluded so retrieval grounds on the user's content, never the
			// just-asked question (persisted + indexed as a Message would otherwise
			// outrank every real note).
			const retrievalItems = await retrieveContext(searchSvc, text, RETRIEVAL_TOP_K, [
				...AGENT_OWN_TYPES,
			]);
			const retrievalBlock = buildRetrievalContextBlock(retrievalItems);
			const titleById = titleMapFromItems(retrievalItems);

			// Explicit composer attachments (the documents / people the user pinned
			// to this turn) — higher signal than auto-retrieval, so resolved from the
			// live snapshot the app already holds and injected ahead of it. Fail-soft:
			// a since-deleted reference resolves to null and is dropped.
			const byId = new Map(all.map((e) => [e.id, e] as const));
			const attachmentsBlock = buildAttachmentsContextBlock(attached, (ref) => {
				const e = byId.get(ref);
				return e ? toReference(e) : null;
			});
			// Attached files (Phase 2): decoded text grounds the agent; images are
			// skipped here (they ride as vision content parts below).
			const mediaBlock = buildMediaContextBlock(
				attached,
				(ref) => mediaTextRef.current.get(ref) ?? null,
			);

			// Long-term memory recall (Agent-7): when ENABLED, inject a bounded set
			// of stored facts so the agent recalls across conversations. Disabled →
			// empty block (no recall). Appended to the same instruction region as
			// retrieval; bounded + fail-soft, so it can't blow up the prompt.
			const memoryBlock = memoryEnabled ? buildMemoryContextBlock(memories) : "";
			// doc 63 — the instruction region, in priority order: the workspace
			// preamble (what apps/object-types/actions exist), the vault-data summary
			// (what's actually here), retrieval grounding, then long-term memory.
			const retrievalContext = joinContextBlocks([
				workspaceBlock,
				vaultBlock,
				attachmentsBlock,
				mediaBlock,
				retrievalBlock,
				memoryBlock,
			]);

			// Image attachments (Phase 3): base64 the bytes into vision content parts
			// on this turn's user message so the model actually sees them (a non-vision
			// provider degrades to the text parts). Bytes come from the per-draft side
			// store keyed by the uploaded asset url.
			const imageParts: AiImagePart[] = [];
			for (const a of attached) {
				if (a.kind === AttachmentKind.Media && a.image) {
					const stored = mediaBytesRef.current.get(a.ref);
					if (stored) {
						imageParts.push({
							kind: AiContentPartKind.Image,
							mimeType: stored.mime,
							data: bytesToBase64(stored.bytes),
						});
					}
				}
			}
			const visionTranscript = withImageParts(transcript, imageParts);

			// Tool-enabled turn (Agent-3): drive the shared loop. The loop owns the
			// system region, so feed it the user/assistant turns only.
			let body: string;
			let provider: string;
			let model: string;
			let loopSteps: AgentLoopResult["steps"] | null = null;
			let usedTools: string[] = [];
			let citationIds: string[] = [];

			if (toolsEnabled && intentsSvc) {
				const loop = await runAgentTurn(
					{ ai: aiSvc, intents: intentsSvc },
					{
						tools: offeredTools,
						frozenCapabilities,
						transcript: visionTranscript.filter((m) => m.role !== MessageRole.System),
						...(retrievalContext ? { retrievalContext } : {}),
						...(conversationProvider ? { provider: conversationProvider } : {}),
						...(conversationModel ? { model: conversationModel } : {}),
					},
				);
				if (loop.stopReason === AgentStopReason.GenerateFailed) {
					throw Object.assign(new Error(loop.error ?? "generate-failed"), { kind: "Unavailable" });
				}
				body = loop.finalAnswer;
				provider = loop.provenance?.provider ?? "";
				model = loop.provenance?.model ?? "";
				loopSteps = loop.steps;
				usedTools = usedToolNames(loop);
				citationIds = loop.citations;
			} else {
				// Plain-chat fallback: still ground on retrieval (the system region
				// gains the context block) so the model answers from the vault. The
				// non-tool path has no citation protocol, so no links render.
				const messagesWithContext = retrievalContext
					? visionTranscript.map((m) =>
							m.role === MessageRole.System && typeof m.content === "string"
								? { ...m, content: `${m.content}\n\n${retrievalContext}` }
								: m,
						)
					: visionTranscript;
				const result = await aiSvc.generate({
					messages: messagesWithContext,
					...(conversationProvider ? { provider: conversationProvider } : {}),
					...(conversationModel ? { model: conversationModel } : {}),
				});
				body = result.content;
				provider = result.provider;
				model = result.model;
			}

			// Resolve the cited ids to clickable link descriptors via this turn's
			// retrieval titles (id-as-label when the model cited something outside
			// the hits). Persisted as a plain `string[]` of ids on the Message.
			const citationLinks = citationsToLinks(citationIds, titleById);

			const repliedAt = new Date().toISOString();
			// Optimistically echo the assistant reply the instant generation
			// returns — visible even if the persisted entity's broadcast lags.
			setPending((prev) => [
				...prev,
				{
					convId,
					msg: {
						id: `pending-assistant-${repliedAt}`,
						role: MessageRole.Assistant,
						body,
						createdAt: repliedAt,
						seq: userSeq + 1,
						...(model ? { model } : {}),
						...(usedTools.length > 0 ? { tools: usedTools } : {}),
						...(citationLinks.length > 0 ? { citations: citationLinks } : {}),
					},
				},
			]);

			const provenance: AiProvenance = {
				provider,
				model,
				generatedAt: repliedAt,
			};
			await entitiesSvc.create(MESSAGE_TYPE_URL, {
				conversation: convId,
				sender: { kind: SenderKind.Assistant, provider, model },
				role: MessageRole.Assistant,
				body,
				aiProvenance: provenance,
				...(loopSteps ? { toolCalls: loopSteps } : {}),
				...(citationIds.length > 0 ? { citations: citationIds } : {}),
				createdAt: repliedAt,
				seq: userSeq + 1,
			});

			// Accrue this turn's estimated prompt tokens to the conversation's
			// running spend (Agent-5) so the budget gate sees a cumulative total.
			// Best-effort — a persistence hiccup here never fails a completed turn.
			try {
				await entitiesSvc.update(convId, { tokensSpent: accrueSpend(tokensSpent, turnTokens) });
			} catch (accrualErr) {
				console.warn("[agent] failed to record token spend:", accrualErr);
			}
		} catch (err) {
			console.error("[agent] generate failed:", err);
			const e = err as { kind?: string; name?: string; message?: string };
			const kind = e.kind ?? e.name ?? "";
			if (kind === "Unavailable") setError(unavailableMessage(conversationProvider));
			else if (kind === "CapabilityDenied") setError(t("error.capability"));
			else setError(`${t("error.generic")}${e.message ? ` (${e.message})` : ""}`);
		} finally {
			setSending(false);
			// Drop this turn's per-draft media payloads now they've been consumed.
			for (const a of attached) {
				if (a.kind === AttachmentKind.Media) {
					mediaTextRef.current.delete(a.ref);
					mediaBytesRef.current.delete(a.ref);
				}
			}
		}
	}, [
		input,
		sending,
		entitiesSvc,
		aiSvc,
		intentsSvc,
		searchSvc,
		toolsEnabled,
		offeredTools,
		frozenCapabilities,
		conversationProvider,
		conversationModel,
		tokenBudget,
		tokensSpent,
		activeId,
		messages,
		displayMessages,
		memoryEnabled,
		memories,
		workspaceBlock,
		vaultBlock,
		all,
		attachments,
	]);

	const onComposerKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			// Enter sends; Shift+Enter inserts a newline. Single-key handling on
			// an editable field — keyboard-exempt from the shortcut-registry rule.
			// Never send mid-IME-composition (the Enter that confirms a candidate).
			if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
				e.preventDefault();
				void send();
			}
		},
		[send],
	);

	// The action surface (doc 63 / AS-3): an inbound `process` contribution
	// dispatched from another app's menu ("Summarize with the agent" / "Ask the
	// agent about this"). A fresh window carries it on the launch context; a
	// running window receives the `app:intent` push. We seed the composer with a
	// kind-specific instruction referencing the target (the Agent's retrieval
	// pass grounds + cites it) and start a fresh chat — but DO NOT auto-send
	// (explicit user action gates AI spend; the user reviews + presses Send).
	const handleProcessIntent = useCallback((verb: string, payload: Record<string, unknown>) => {
		const seed = seedFromProcessIntent(verb, payload);
		if (!seed) return;
		setActiveId(null);
		setError(null);
		setSettingsOpen(false);
		setSaveDraft(null);
		setInput(seed.instruction);
	}, []);
	const launchIntentFiredRef = useRef(false);
	useEffect(() => {
		if (!rt) return;
		// Fire a launch-context `process` intent exactly once (not on every re-run).
		if (!launchIntentFiredRef.current) {
			launchIntentFiredRef.current = true;
			if (rt.launch?.reason === "intent" && rt.launch.intent.verb === "process") {
				handleProcessIntent(rt.launch.intent.verb, rt.launch.intent.payload);
			}
		}
		// Subscribe to live intents WITH cleanup (mirrors notes/calendar/journal) —
		// don't leak the listener / its closure on unmount or rt change.
		const sub = rt.on?.("intent", (event) => {
			if (event.type !== "intent") return;
			handleProcessIntent(event.intent.verb, event.intent.payload);
		});
		return () => sub?.unsubscribe();
	}, [rt, handleProcessIntent]);

	// Open a cited vault object via the SAME cap-checked `open` intent Agent-3
	// wired (the shell resolves the id's type + routes to the owner app). Never a
	// raw entity fetch — the app holds no read path for arbitrary objects.
	const openCitation = useCallback(
		(entityId: string) => {
			// `openEntity` accepts the loose `{ services: { intents } }` shape; the
			// app's typed runtime narrows `dispatch`'s verb to `IntentVerb`, so widen
			// to the navigation surface (the verb dispatched is the fixed `open`).
			void openEntity(rt as unknown as OpenCapableRuntime, { entityId });
		},
		[rt],
	);

	// The active conversation IS the header object — the title right-click
	// and the trailing ⋯ open the shared object menu on it. A fresh chat has
	// no object yet, so the ⋯ renders disabled (never absent).
	const conversationContext = useCallback((): ObjectMenuContext => {
		const conv = conversations.find((c) => c.id === activeId) ?? null;
		if (!conv || !rt) return null;
		return {
			target: {
				entityId: conv.id,
				entityType: CONVERSATION_TYPE_URL,
				label: str(conv.properties.title) || t("chat.untitled"),
			},
			runtime: rt as unknown as ObjectMenuRuntime,
		};
	}, [conversations, activeId, rt]);

	return (
		<div className="agent">
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<ObjectMenuTrigger
						context={conversationContext}
						moreActionsLabel={t("header.moreActions")}
						noMoreButton
					>
						<h1 className="app-header__title">
							{activeConv ? str(activeConv.properties.title) : t("app.title")}
						</h1>
					</ObjectMenuTrigger>
				</div>
				<div className="app-header__right">
					<button
						type="button"
						className="header-icon-btn"
						onClick={newChat}
						aria-label={t("header.newChat")}
						data-bs-tooltip={t("header.newChat")}
					>
						<Icon name={IconName.Plus} size={18} />
					</button>
					<button
						type="button"
						className="header-icon-btn"
						onClick={() => setSettingsOpen(true)}
						aria-label={t("header.settings")}
						data-bs-tooltip={t("header.settings")}
						title={activeConv === null ? t("header.settings") : undefined}
						disabled={activeConv === null}
						data-testid="agent-settings-open"
					>
						<Icon name={IconName.Settings} size={18} />
					</button>
					<button
						type="button"
						className="header-icon-btn"
						onClick={() => setMemoryOpen(true)}
						aria-label={t("header.memory")}
						data-bs-tooltip={t("header.memory")}
						data-testid="agent-memory-open"
					>
						<Icon name={IconName.Star} size={18} />
					</button>
					{ranTools ? (
						<button
							type="button"
							className="header-icon-btn"
							onClick={openSaveAutomation}
							aria-label={t("header.saveAutomation")}
							data-bs-tooltip={t("header.saveAutomation")}
							data-testid="agent-save-automation-open"
						>
							<Icon name={IconName.Update} size={18} />
						</button>
					) : null}
					<PanelToggleButton
						side={PanelSide.Left}
						open={sidebarOpen}
						onClick={toggleSidebar}
						controls="agent-sidebar"
						labels={{ show: t("header.sidebar.show"), hide: t("header.sidebar.hide") }}
					/>
					<ObjectMenuMoreButton
						context={conversationContext}
						moreActionsLabel={t("header.moreActions")}
						disabled={activeConv === null}
					/>
				</div>
			</header>

			<div className="agent__body" data-sidebar-open={String(sidebarOpen)}>
				<aside className="agent__sidebar" id="agent-sidebar">
					<nav className="agent__convs">
						{conversations.length === 0 ? (
							<p className="agent__sidebar-empty">{t("sidebar.empty")}</p>
						) : (
							conversations.map((c) => (
								<button
									type="button"
									key={c.id}
									className={`agent__conv${c.id === activeId ? " agent__conv--active" : ""}`}
									onClick={() => selectConversation(c.id)}
								>
									{str(c.properties.title) || t("chat.untitled")}
								</button>
							))
						)}
					</nav>
				</aside>

				<section className="agent__main">
					<div className="agent__transcript" data-testid="agent-transcript">
						{displayMessages.length === 0 ? (
							<EmptyState
								icon={IconName.Sparkle}
								title={t("chat.empty.title")}
								hint={t("chat.empty.blurb")}
							/>
						) : (
							displayMessages.map((m) => (
								<div
									key={m.id}
									className={`agent__msg agent__msg--${m.role === MessageRole.Assistant ? "assistant" : "user"}`}
								>
									<div className="agent__msg-role">
										{m.role === MessageRole.Assistant ? t("role.assistant") : t("role.you")}
										{m.role === MessageRole.Assistant && m.model ? (
											<span className="agent__msg-model"> · {t("provenance.via", { model: m.model })}</span>
										) : null}
									</div>
									{m.tools && m.tools.length > 0 ? (
										<div className="agent__msg-tools" data-testid="agent-msg-tools">
											{toolChips(m.tools).map(({ key, tool }) => (
												<span key={key} className="agent__tool-chip">
													<Icon name={IconName.Sparkle} size={12} />
													{t("tool.used", { tool })}
												</span>
											))}
										</div>
									) : null}
									<div className="agent__msg-body">
										{m.role === MessageRole.Assistant ? (
											<Markdown
												source={m.bodyMarkdown ?? m.body}
												onEntityLink={(target) =>
													target && !/\s/.test(target) ? () => openCitation(target) : null
												}
											/>
										) : (
											m.body
										)}
									</div>
									{m.attachments && m.attachments.length > 0 ? (
										<div className="agent__attachments" data-testid="agent-attachments">
											{m.attachments.map((a) =>
												a.kind === AttachmentKind.Media ? (
													<span key={a.ref} className="agent__attachment">
														<Icon name={IconName.KindFile} size={12} />
														{attachmentLabel(a)}
													</span>
												) : (
													<button
														type="button"
														key={a.ref}
														className="agent__attachment agent__attachment--link"
														onClick={() => openCitation(a.ref)}
														data-bs-tooltip={t("composer.attach.open", { label: attachmentLabel(a) })}
														aria-label={t("composer.attach.open", { label: attachmentLabel(a) })}
													>
														<Icon
															name={a.kind === AttachmentKind.Person ? IconName.Entity : IconName.KindLink}
															size={12}
														/>
														{attachmentLabel(a)}
													</button>
												),
											)}
										</div>
									) : null}
									{memoryEnabled && m.body.trim().length > 0 ? (
										<div className="agent__msg-actions">
											<button
												type="button"
												className="agent__remember"
												onClick={() => rememberFact(m.body)}
												title={t("memory.remember.hint")}
												data-testid="agent-remember"
											>
												<Icon name={IconName.Star} size={12} />
												{t("memory.remember")}
											</button>
										</div>
									) : null}
									{m.citations && m.citations.length > 0 ? (
										<div className="agent__citations" data-testid="agent-citations">
											<span className="agent__citations-label">{t("citations.label")}</span>
											<div className="agent__citation-links">
												{m.citations.map((c) => (
													<button
														type="button"
														key={c.entityId}
														className="agent__citation"
														onClick={() => openCitation(c.entityId)}
														title={t("citations.open", { title: c.label })}
													>
														<Icon name={IconName.KindLink} size={12} />
														{c.label}
													</button>
												))}
											</div>
										</div>
									) : null}
								</div>
							))
						)}
						{sending && displayMessages[displayMessages.length - 1]?.role !== MessageRole.Assistant ? (
							<div className="agent__msg agent__msg--assistant" data-testid="agent-thinking">
								<div className="agent__msg-role">{t("role.assistant")}</div>
								<div className="agent__msg-body agent__msg-body--thinking">{t("chat.thinking")}</div>
							</div>
						) : null}
						{pendingEscalationCap ? (
							<EscalationPrompt
								cap={pendingEscalationCap}
								onAllow={() => allowEscalation(pendingEscalationCap)}
								onDismiss={() => dismissEscalation(pendingEscalationCap)}
							/>
						) : null}
						<div ref={endRef} />
					</div>

					{error ? (
						<div className="agent__error-row">
							<div className="agent__error" role="alert" data-testid="agent-error">
								{error}
							</div>
						</div>
					) : null}

					<ComposerContextRail
						attachments={attachments.attachments}
						onRemove={removeAttachment}
						removeLabel={(label) => t("composer.attach.remove", { label })}
					/>
					<form
						className="agent__composer"
						onSubmit={(e) => {
							e.preventDefault();
							void send();
						}}
					>
						<AttachContextButton
							onMention={mention.trigger}
							{...(storageSvc?.uploadFile ? { onUploadMedia: () => void handleUploadMedia() } : {})}
							labels={{
								button: t("composer.attach.button"),
								mention: t("composer.attach.mention"),
								upload: t("composer.attach.upload"),
							}}
							disabled={sending}
						/>
						<textarea
							ref={composerRef}
							className="agent__input"
							value={input}
							onChange={(e) => {
								setInput(e.target.value);
								mention.sync();
							}}
							onKeyDown={(e) => {
								if (mention.onKeyDown(e)) return;
								onComposerKeyDown(e);
							}}
							onClick={() => mention.sync()}
							onKeyUp={() => mention.sync()}
							onBlur={mention.blur}
							placeholder={t("chat.placeholder")}
							rows={1}
							aria-label={t("chat.placeholder")}
							data-testid="agent-input"
						/>
						<button
							type="submit"
							className="agent__send"
							data-bs-primary=""
							disabled={sending || (input.trim().length === 0 && attachments.attachments.length === 0)}
							data-testid="agent-send"
						>
							{t("chat.send")}
						</button>
					</form>
				</section>
			</div>

			{settingsOpen && activeConv ? (
				<ConversationSettingsPopover
					appCaps={appCaps ?? []}
					settings={{
						grants: conversationGrants,
						provider: str(activeConv.properties.provider) || undefined,
						model: conversationModel,
						tokenBudget,
						tokensSpent,
					}}
					onClose={() => setSettingsOpen(false)}
					onGrantsChange={(grants) => persistConversation({ toolGrants: grants })}
					onProviderChange={(provider) => persistConversation({ provider: provider ?? "" })}
					onBudgetChange={(budget) => persistConversation({ tokenBudget: budget ?? 0 })}
				/>
			) : null}

			{memoryOpen ? (
				<MemoryPopover
					enabled={memoryEnabled}
					memories={memories}
					onClose={() => setMemoryOpen(false)}
					onToggleEnabled={toggleMemoryEnabled}
					onEdit={editMemory}
					onDelete={deleteMemory}
					onClearAll={clearAllMemories}
				/>
			) : null}

			{saveDraft ? (
				<SaveAsAutomationPopover
					draft={saveDraft}
					saving={savingAutomation}
					onConfirm={() => void confirmSaveAutomation()}
					onClose={() => setSaveDraft(null)}
				/>
			) : null}
		</div>
	);
}
