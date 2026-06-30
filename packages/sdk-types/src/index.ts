/**
 * @brainstorm/sdk-types — type-only declarations for the Brainstorm app SDK.
 *
 * Per the SDK *runtime* is injected by the shell into
 * the renderer at preload time via a `brainstorm` global. App authors install
 * THIS package for typed access against that global; they do NOT install the
 * runtime — it doesn't exist as a separate package by design (per
 * §Boot handshake).
 *
 * This file declares the surface. The implementation lands in
 * `packages/sdk` (Stage 5b for the full set; Stage 5 ships a starter
 * subset).
 */

/* eslint-disable @typescript-eslint/no-unused-vars */ // declarations only

import type { ExportTextFormat } from "./automations";
import type { CalDavService } from "./caldav";
import type {
	ContributedAction,
	ContributedActionTarget,
	ContributedVerb,
} from "./contributed-actions";
import type {
	AiCostEstimate,
	AiExtractRequest,
	AiExtractResult,
	AiGenerateRequest,
	AiGenerateResult,
	AiTransformRequest,
	AiTransformResult,
} from "./conversation";
import type { Icon } from "./icon";
import type { ListSource } from "./list";
import type { McpAgentTool } from "./mcp";
import type { PropertyPredicate } from "./predicate";
import type { Dictionary, PropertyDef } from "./properties";
import type { ThemePreviewSpec } from "./theme-preview";
import type { WebViewClient } from "./web-view";

// ─── Identity / boot handshake ──────────────────────────────────────────────

/** Shape passed to `brainstorm.on("ready", …)`. Static for the lifetime of the renderer. */
export type AppHandshake = {
	app: {
		id: string;
		version: string;
		sdkVersion: string;
	};
	capabilities: readonly string[];
	launch: LaunchContext;
	/** Active UI locale (BCP-47 tag) at launch, so a freshly-opened window
	 *  renders its first frame in the right language with no IPC round-trip
	 *  — ambient like the theme. Runtime changes arrive on the
	 *  `app:locale-changed` channel. Absent on non-shell hosts (12.15 — the
	 *  SDK falls back to `DEFAULT_LOCALE`). */
	locale?: string;
	/** Active regional-format context at launch (12.15 slice 15f), so an app's
	 *  first frame renders dates / times / numbers per the user's Settings →
	 *  Regional choice. Ambient like `locale`; runtime changes arrive on the
	 *  `app:format-changed` channel. Absent on non-shell hosts (host defaults). */
	format?: FormatContext;
};

/** Fallback UI locale when no shell-supplied locale is present (the tail of
 *  the doc-21 fallback chain `<requested>`→`<base>`→`en-US`→`en`). */
export const DEFAULT_LOCALE = "en";

/**
 * Locale + regional formatting context threaded from the shell's Settings →
 * Regional choice to apps (12.15 slice 15f). Provider-neutral (plain
 * strings/booleans) so the leaf types package carries it without depending on
 * the shell's preference enums; `@brainstorm/sdk/date-formatters` re-exports
 * this type and its formatters consume it. Every field optional — an omitted
 * field keeps the host/locale default, so `{}` reproduces host behaviour. */
export type FormatContext = {
	/** BCP-47 tag for dates + numbers, or undefined for the host default. */
	locale?: string;
	/** Force 12-hour (true) / 24-hour (false); undefined = locale default. */
	hour12?: boolean;
	/** IANA time zone (e.g. `"Europe/Berlin"`), or undefined for the host zone. */
	timeZone?: string;
};

/** Host-default format context (no overrides). */
export const DEFAULT_FORMAT_CONTEXT: FormatContext = {};

export type LaunchContext =
	| { reason: "fresh" }
	| { reason: "session-restore" }
	| { reason: "open-entity"; entityId: string }
	| { reason: "open-file"; file: FileHandle }
	| { reason: "deep-link"; deepLink: string }
	/** A non-navigation verb (e.g. `compose` / `reply`) launched this app —
	 *  the full intent rides the handshake so a freshly-launched window
	 *  receives the payload (a running window gets the `app:intent` push
	 *  instead). Mailbox-4. */
	| { reason: "intent"; intent: Intent }
	/** The app is mounted as a dashboard WIDGET (7.3 / OQ-6 v1: the app's own
	 *  bundle renders in widget-mode in its own broker-scoped surface). The SDK
	 *  `@brainstorm/sdk/widget` bootstrap reads `widgetId` to pick which
	 *  registered widget to render; `bind` is an optional entity / saved-view id
	 *  for parameterised widgets (e.g. a Database view summary). */
	| { reason: "widget"; widgetId: string; bind?: string };

// ─── Errors ─────────────────────────────────────────────────────────────────

export type StructuredErrorKind =
	| "CapabilityDenied"
	| "NotFound"
	| "Conflict"
	| "Unavailable"
	| "Invalid";

export interface StructuredError extends Error {
	readonly name: StructuredErrorKind;
	readonly capability?: string;
	readonly kind?: string;
	readonly id?: string;
	readonly reason?: string;
	readonly service?: string;
}

// ─── Lifecycle events ───────────────────────────────────────────────────────

export type LifecycleEvent =
	| { type: "ready"; handshake: AppHandshake }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "intent"; intent: Intent }
	| { type: "capability-changed"; capabilities: readonly string[] }
	| { type: "close" };

export type LifecycleHandler<T extends LifecycleEvent["type"]> = (
	event: Extract<LifecycleEvent, { type: T }>,
) => void | Promise<void>;

// ─── Spellcheck (B11.16c) ─────────────────────────────────────────────────────

/** Pushed from the shell when the user right-clicks a misspelled word in an
 *  editable element. The misspelled `word`, Chromium's `suggestions`, and the
 *  viewport-relative cursor point at which to open the suggestion menu. */
export type SpellcheckContext = {
	word: string;
	suggestions: readonly string[];
	x: number;
	y: number;
};

/** The renderer-facing spellcheck seam (overlaid by the shell preload, absent
 *  on standalone/preview shells). The shell enables Chromium's spellchecker per
 *  app session (B11.16a); this carries the right-click suggestion context out
 *  and the chosen replacement back. */
export type SpellcheckBridge = {
	/** Subscribe to right-click-on-misspelling events. Returns an unsubscribe. */
	onContext(listener: (ctx: SpellcheckContext) => void): () => void;
	/** Replace the right-clicked misspelling with `replacement` in the calling
	 *  renderer (Electron-native `webContents.replaceMisspelling`). */
	replace(replacement: string): void;
	/** B11.17a — add `word` to the vault's custom dictionary (persisted + applied
	 *  to the live session). Capability-gated (`editor.spellcheck.write`).
	 *  Resolves to the updated word list. */
	addWord(word: string): Promise<string[]>;
	/** Remove `word` from the vault's custom dictionary (`editor.spellcheck.write`). */
	removeWord(word: string): Promise<string[]>;
	/** Suppress `word` for this session only — applied to the live dictionary but
	 *  NOT persisted, so it returns on next vault-open (`editor.spellcheck.write`). */
	ignoreWord(word: string): Promise<void>;
	/** The vault's persisted custom words (`editor.spellcheck.read`). */
	listWords(): Promise<string[]>;
};

// ─── Intents ────────────────────────────────────────────────────────────────

export type IntentVerb =
	| "open"
	| "share"
	| "insert"
	| "export"
	| "process"
	| "import"
	| "compose"
	| "send"
	| "reply"
	| "forward";

/** The send-family verbs (doc 53 §Sending — sending is an intent, not a
 *  Mailbox API). `compose` / `reply` / `forward` route to the mail app's
 *  composer; `send` is handled shell-side by the MailTransport (idempotent
 *  on the client-stamped `submissionId` → `Message-ID`). Referenced by
 *  name per the no-raw-string-discriminators convention. */
export const SendIntentVerb = {
	Compose: "compose",
	Send: "send",
	Reply: "reply",
	Forward: "forward",
} as const;
export type SendIntentVerb = (typeof SendIntentVerb)[keyof typeof SendIntentVerb];

export type Intent = {
	verb: IntentVerb;
	payload: Record<string, unknown>;
	source: string; // app id of the dispatcher; "shell" for shell-originated
};

export type IntentResult = {
	handled: boolean;
	value?: unknown;
};

// ─── Contributed actions (the action surface — doc 63) ──────────────────────
// The verb / group / trust enums + the wire types live in
// `./contributed-actions` alongside the pure grouping logic (so that module has
// no circular dependency on this barrel at evaluation time); re-exported below.

// ─── Entities ───────────────────────────────────────────────────────────────

export type EntityId = string; // `ent_<ULID>`

export type Entity<P extends Record<string, unknown> = Record<string, unknown>> = {
	id: EntityId;
	type: string; // entity-type URL
	properties: P;
	links?: ReadonlyArray<{
		linkType: string;
		destinationEntityId: EntityId;
	}>;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
};

export type EntityQuery = {
	type?: string | string[];
	where?: PropertyPredicate;
	link?: LinkPredicate;
	text?: string;
	spaceId?: string | string[];
	orderBy?: ReadonlyArray<{ property: string; direction: "asc" | "desc" }>;
	limit?: number;
	cursor?: string;
};

export type LinkPredicate = {
	type?: string;
	source?: EntityId;
	dest?: EntityId;
};

export type Subscription = {
	unsubscribe(): void;
};

export type EntitiesService = {
	get(id: EntityId): Promise<Entity | null>;
	subscribe(query: EntityQuery, onUpdate: (entities: Entity[]) => void): Subscription;
	/** `id` (optional) preserves a caller's stable id when migrating off a
	 *  per-app store onto the shared space — entity ids are local opaque
	 *  strings. A collision with a live entity rejects (`Invalid`). */
	create(type: string, properties: Record<string, unknown>, id?: EntityId): Promise<Entity>;
	update(id: EntityId, patch: Record<string, unknown>): Promise<Entity>;
	delete(id: EntityId): Promise<void>;
	query(query: EntityQuery): Promise<Entity[]>;
	/** 9.3.2b — rich-text Y.Doc transport (base64 Yjs updates; no yjs
	 *  types cross this boundary so sdk-types stays yjs-free). The preload
	 *  builds the renderer-side replica + `<YDocProvider>` resolver +
	 *  `getYFragment`/`getYText` on top of these. Capability-gated by the
	 *  entity's type (read to load, write to apply). */
	loadDoc(id: EntityId): Promise<{ snapshotB64: string; truncatedTail: boolean }>;
	applyDoc(id: EntityId, updateB64: string): Promise<unknown>;
	closeDoc(id: EntityId): Promise<void>;
};

// ─── Vault entities (Stage 9.3 preview surface) ─────────────────────────────

/** Minimal entity shape used by the Stage 9.3 preview service. Mirrors the
 *  fields the Graph app's in-memory matcher consumes. Replaced by `Entity`
 *  + `EntitiesService.query` when the full entities service ships. */
export type VaultEntity = {
	id: EntityId;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	/** App id that owns the entity — useful for routing an `open` intent
	 *  back to the source app. Goes away when entities become vault-level. */
	ownerAppId: string;
};

export type VaultEntityLink = {
	id: string;
	sourceEntityId: EntityId;
	destEntityId: EntityId;
	linkType: string;
	createdAt: number;
	deletedAt: null;
};

export type VaultEntitiesSnapshot = {
	entities: VaultEntity[];
	links: VaultEntityLink[];
};

/** Wire shape of a Graph pattern as sent to `vaultEntities.queryPattern`.
 *  Structural-only (no enums) so this surface stays free of the shell
 *  compiler's runtime module — the canonical typed definition lives in
 *  `packages/shell/src/main/entities/pattern.ts` (mirrored, like the
 *  Graph app's `types/pattern.ts`). The shell validates / compiles it. */
export type GraphPatternWire = {
	subjects: Record<
		string,
		{
			kind: string;
			types: string[];
			where: unknown;
			displayName: string;
		}
	>;
	edges: Array<{
		from: string;
		to: string;
		linkTypes: string[];
		direction: string;
		match: string;
		hops: readonly [number, number];
	}>;
	primarySubject: string;
};

/** Preview of the entities service, scoped to "give me everything in the
 *  vault right now". Used by the Graph + Database apps to render real
 *  notes before the full service lands. Capability: `entities.read:*`.
 *
 *  Live updates: `onChange(listener)` fires whenever a note write reaches
 *  the storage worker (the only source of vault-entities right now —
 *  every other surface still uses demo data). The listener is a bare
 *  staleness signal; the app calls `list()` to fetch the authoritative
 *  snapshot (re-running the broker's capability check). The SDK's
 *  default in-package impl returns a no-op subscription — the preload
 *  overrides it with the real IPC-backed channel before exposing the
 *  runtime to app code. Mirrors the VP-6 PropertiesService.onChange
 *  pattern. */
/** A `queryPattern` rejection the shell surfaces verbatim — the Graph
 *  renderer shows a "Narrow the source" banner when `kind` is
 *  `pattern-too-expensive`, and a validation hint otherwise. */
export type PatternQueryError = {
	kind: "pattern-too-expensive" | "pattern-invalid";
	message: string;
};

export type PatternQueryResult =
	| { ok: true; snapshot: VaultEntitiesSnapshot }
	| { ok: false; error: PatternQueryError };

/** A `querySource` rejection the shell surfaces verbatim — a malformed
 *  source (`source-invalid`) or one whose structural cost caps tripped
 *  (`source-too-expensive`; the Database renderer shows a "Narrow the
 *  criteria" hint). */
export type SourceQueryError = {
	kind: "source-invalid" | "source-too-expensive";
	message: string;
};

export type SourceQueryResult =
	| { ok: true; ids: string[] }
	| { ok: false; error: SourceQueryError };

export type VaultEntitiesService = {
	list(): Promise<VaultEntitiesSnapshot>;
	/** Resolve a Graph pattern against the real `entities.db` store
	 *  shell-side (single compiled SQL JOIN + cost-cap guard) and return
	 *  the matched subgraph in the same `{entities, links}` shape `list()`
	 *  returns — so the Graph renderer's scene path is unchanged. Stage
	 *  9.13.3. */
	queryPattern(pattern: GraphPatternWire): Promise<PatternQueryResult>;
	/** Resolve a saved List's `ListSource` to its live member id set
	 *  shell-side (9.12.3): SQL fast paths for `byType`/`byLink`, the shared
	 *  `predicate-eval` evaluator for the filter-shaped kinds — the same
	 *  semantics as the in-memory `evaluateSource`, without shipping the
	 *  whole vault over IPC. Member overrides stay client-side
	 *  (`effectiveMembers`). */
	querySource(source: ListSource | null): Promise<SourceQueryResult>;
	onChange(listener: () => void): Subscription;
};

// ─── Search (vault-wide full-text) ──────────────────────────────────────────

/**
 * Vault-wide full-text search service.
 *
 * Backed by SQLite FTS5 inside the shell main process — a single writer, no
 * separate native FTS engine, no per-segment file locking. One DB file under
 * WAL gives well-defined crash semantics on every platform, sidestepping the
 * file-handle / AV-interference / partial-segment failure modes that bite
 * multi-segment FTS engines on Windows.
 *
 * The index is **rebuildable from sources**: corruption is recoverable with
 * no data loss because the canonical content lives in the entity / note KV
 * stores, not the index.
 *
 * Capability: `search.read` (default-minimum grant — every app can query the
 * vault-wide index without a prompt, same shape as `properties.read`).
 *
 * The full Stage 11 surface adds `search.hybrid` + `search.semantic`; this
 * Stage 9 preview ships lexical only.
 */
export type SearchQuery = {
	/** Free-form user input. Tokenised + escaped before reaching FTS5 — the
	 *  caller passes natural-language text, not FTS5 syntax. Empty / whitespace
	 *  query returns no hits. */
	text: string;
	/** Optional type-URL filter — `["io.brainstorm.notes/Note/v1", "brainstorm/Task/v1"]`. */
	types?: readonly string[];
	/** Optional type URLs to EXCLUDE from results (applied after `types`). Lets a
	 *  caller ground on the vault while omitting its own bookkeeping objects —
	 *  the Agent passes its Conversation/Message/Memory types so retrieval never
	 *  surfaces the conversation transcript instead of real content. */
	excludeTypes?: readonly string[];
	/** Optional cap on returned hits. Default 50; hard ceiling 200. */
	limit?: number;
};

export type SearchHit = {
	entityId: EntityId;
	type: string;
	/** App that owns the entity — useful for routing an `open` intent
	 *  to the source app. Mirrors `VaultEntity.ownerAppId`. */
	ownerAppId: string;
	title: string;
	/** FTS5-generated excerpt with `<mark>...</mark>` around matched tokens. */
	snippet: string;
	/** BM25 score — lower is better (FTS5's bm25() returns negative ranks).
	 *  Stable ordering is by ascending score, then by `updatedAt` desc. */
	score: number;
	updatedAt: number;
};

export type SearchService = {
	query(query: SearchQuery): Promise<SearchHit[]>;
	/** Hybrid lexical (BM25) + semantic (vector) search, fused by rank (11.4).
	 *  Degrades to lexical-only until on-device embeddings land (11.3). */
	hybrid(query: SearchQuery): Promise<SearchHit[]>;
};

// ─── Network (Net-1, shell-mediated HTTP egress) ─────────────────────────────

/** Caller side of the broker's `network.fetch` IPC. The shell owns DNS
 *  resolution + connection; the renderer never learns the resolved IP or
 *  the user's source IP. Caps: `network.fetch` (broad permit, v1) or
 *  `network.fetch:<origin>` (scoped, post-v1 hardening). The broker also
 *  filters response headers to a small allowlist (Content-Type/Length/
 *  Language/Disposition, Cache-Control, ETag, Last-Modified, Expires,
 *  Link) — Set-Cookie / Server / X-* are dropped server-side. */
export type NetworkFetchInput = {
	/** Request URL. Validated by the broker against the SSRF guard
	 *  before any DNS / connect happens. */
	url: string;
	/** HTTP method. Defaults to GET. The broker UPPER-cases. */
	method?: string;
	/** Request headers. Reserved keys (Host, Content-Length, Connection,
	 *  Transfer-Encoding, Proxy-Authorization/Connection, Upgrade) are
	 *  stripped by the broker. */
	headers?: Readonly<Record<string, string>>;
	/** Request body bytes. */
	body?: Uint8Array;
	/** Override the default 1 MiB response size cap. */
	sizeCapBytes?: number;
	/** Override the default 5 s total time budget. */
	timeoutMs?: number;
	/** Net-1b — declare the request needs to reach private / loopback /
	 *  link-local addresses. When set, the SDK adds the
	 *  `network.fetch.private` capability to the envelope so the broker
	 *  relaxes the SSRF private-IP + local-hostname rejections. The
	 *  caller must hold the `.private` capability in its manifest +
	 *  user-grant; otherwise the broker denies. Public fetches stay
	 *  byte-identical with `allowPrivate` omitted / false. */
	allowPrivate?: boolean;
};

export type NetworkFetchResult = {
	status: number;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array;
	/** Final URL after any followed redirects (or the request URL when
	 *  the response was non-3xx). */
	finalUrl: string;
};

/** Returned by `network.preview` — a structured snapshot of the page's
 *  shareable metadata. The shell extracts OG + Twitter + JSON-LD + plain-
 *  HTML fallbacks from the first ≤64 KiB of the response. The renderer
 *  never sees the byte stream — the broker fetches, parses, and returns
 *  this record. Cap `network.preview` (separate from `network.fetch`)
 *  costs no host disclosure: the app learns the resolved record but
 *  never learns the resolved IP / redirect chain / response headers. */
export type LinkPreview = {
	url: string;
	canonicalUrl: string;
	title: string;
	description: string;
	image: string;
	/** Absolute http(s) favicon URL, resolved against the page (origin
	 *  `/favicon.ico` fallback). Offline-first consumers paint
	 *  `faviconAssetUrl` instead; this remote URL is metadata only. */
	favicon: string;
	/** Offline-first local URL (`brainstorm://asset/<id>`) for the favicon
	 *  bytes the broker downloaded + encrypted into the vault asset store.
	 *  Absent when no asset store is wired or the sub-fetch failed. Paint
	 *  this — never the remote `favicon` (no IP leak, works offline). */
	faviconAssetUrl?: string;
	/** Offline-first local URL for the OpenGraph cover image — same contract
	 *  as `faviconAssetUrl`. */
	coverAssetUrl?: string;
	siteName: string;
	mediaType: string;
	/** Article author display name (9.18.6): JSON-LD `author.name`, then
	 *  `<meta name="author">`, then a non-URL `article:author`. Absent when
	 *  the page declared none. */
	author?: string;
	/** Epoch ms of the page's publish date (`article:published_time` /
	 *  JSON-LD `datePublished`). Absent when none / unparseable. */
	publishedAt?: number;
	fetchedAt: number;
};

/** A serialized Lexical block-node tree (the editor's `exportJSON` shape). The
 *  readable-content service (Net-2) returns these so a captured page's body can
 *  drop straight into a Bookmark's universal rich-text body with zero transform
 *  (9.18.5). Structural — kept here as the contract type so callers don't depend
 *  on `@brainstorm/editor`. */
export type SerializedBlock = {
	type: string;
	version: number;
	children?: SerializedBlock[];
	[key: string]: unknown;
};

/** Superset of `preview`: the OpenGraph/metadata record PLUS the cleaned page
 *  body as Lexical blocks. `blocks` is `null` when the page had no extractable
 *  article (a JS-only shell, a login wall) — the caller keeps the preview. */
export type NetworkReadableResult = {
	preview: LinkPreview;
	blocks: SerializedBlock[] | null;
};

export type NetworkService = {
	fetch(input: NetworkFetchInput): Promise<NetworkFetchResult>;
	/** Fetch a structured snapshot of a page's shareable metadata. Net-1c
	 *  caches results per-(canonicalUrl, locale) for 24 hours — the same
	 *  URL pasted twice in the same locale returns the cached record
	 *  without re-fetching. `locale` is the user's `Accept-Language`
	 *  prefix (e.g. `"en"`, `"fr-CA"`); defaults to `"en"` when omitted. */
	preview(input: { url: string; locale?: string }): Promise<LinkPreview>;
	/** Net-2 — `preview` PLUS the cleaned readable page body as Lexical blocks.
	 *  A superset egress of `preview`, gated by its own `network.readable`
	 *  capability (a caller wanting only a card asks for `preview`).
	 *  `allowPrivate` adds the `network.readable.private` scope-widener. */
	readable(input: {
		url: string;
		locale?: string;
		allowPrivate?: boolean;
	}): Promise<NetworkReadableResult>;
};

// ─── Connectors (OAuth / request broker, doc 56) ────────────────────────────

/** The auth-injected provider response a connector gets back from
 *  `connectors.request`. The injected `Authorization` header is stripped —
 *  a connector never sees its own token. */
export type ConnectorRequestResult = {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
	finalUrl: string;
};

/** App-facing connector broker (doc 56). The shell owns OAuth, token
 *  custody, and egress; the app holds only entity refs. */
export type ConnectorsService = {
	/** Run the OAuth flow for a connector; returns the token-free account id. */
	authorize(input: {
		connectorRef: string;
		externalAccountLabel: string;
	}): Promise<{ accountId: string }>;
	/** Connect with a user-supplied long-lived token (e.g. a Personal Access
	 *  Token) — the token is sealed in Tier 2, never returned. */
	connectToken(input: {
		connectorRef: string;
		externalAccountLabel: string;
		token: string;
	}): Promise<{ accountId: string }>;
	/** Disconnect an account (delete its token, flip authState). */
	revoke(input: { accountId: string }): Promise<{ ok: true }>;
	/** Run a mapping's pull now (manual "Sync now"). */
	sync(input: { mappingRef: string }): Promise<unknown>;
	/** Auth-injected, egress-scoped, audited provider call. */
	request(input: {
		accountRef: string;
		method?: string;
		path: string;
		body?: unknown;
		headers?: Record<string, string>;
	}): Promise<ConnectorRequestResult>;
};

// ─── Mail service (shell-side transport + sync — doc 53, Mailbox-5) ─────────

/** Summary of one account sync, returned by `mail.syncNow`. */
export type MailSyncSummary = {
	accountRef: string;
	folders: number;
	created: number;
	updated: number;
	startedAt: string;
	finishedAt: string;
};

/** App-facing mail account management (doc 53). The shell owns OAuth (via
 *  the connector broker, doc 56), token custody, the transport worker and
 *  the sync engine; the app holds only entity refs. Gated on `mail.manage`,
 *  re-checked server-side. */
export type MailService = {
	/** Run the Google OAuth flow (browser consent → loopback redirect) and
	 *  create a `MailAccount/v1`. `clientSecret` is the installed-app secret
	 *  Google requires at token exchange — sealed in Tier 2 with the tokens,
	 *  never on an entity, never returned. `syncWindow` accepts a
	 *  `SyncWindow` value (default `30d`). */
	connectGmail(input: {
		clientId: string;
		clientSecret?: string;
		label?: string;
		syncWindow?: string;
	}): Promise<{ accountId: string; address: string }>;
	/** Create an IMAP+SMTP account (app-password / Basic auth). The secret
	 *  is sealed in Tier 2 keyed by the new account's entity id — never on
	 *  the entity, never returned. `tls: true` = implicit TLS (993/465);
	 *  `tls: false` = mandatory STARTTLS upgrade — plain cleartext is never
	 *  an option (doc 53). */
	connectImap(input: {
		address: string;
		displayName?: string;
		username?: string;
		secret: string;
		incoming: { host: string; port: number; tls: boolean };
		outgoing: { host: string; port: number; tls: boolean };
		syncWindow?: string;
	}): Promise<{ accountId: string; address: string }>;
	/** Run a full folder + message sync for one account now. */
	syncNow(input: { accountRef: string }): Promise<MailSyncSummary>;
	/** Revoke the account's token (Tier 2 delete) and disable the account. */
	disconnect(input: { accountRef: string }): Promise<{ ok: true }>;
};

// ─── Covers (vault-shared cover-image content store, B7.2) ──────────────────

/** Returned by `covers.uploadBytes` — content-addressed URLs into the
 *  vault `covers/` store, served via the `brainstorm://cover/` protocol. */
export type CoverUploadResult = {
	url: string;
	thumbUrl: string;
};

export type CoverImageEntry = {
	url: string;
	thumbUrl: string;
	hash: string;
	uploadedAt: number;
};

/**
 * The vault's cover-image library. Covers are vault-shared (a cover
 * uploaded from any app is visible to all — like wallpaper), so `list`
 * and `delete` are not app-scoped. `uploadBytes`/`delete` need
 * `covers.write`; `list` needs `covers.read`. The host downscales,
 * dedups by SHA-256, and enforces an ext allow-list + size ceiling
 * (`Invalid` on reject).
 */
export type CoversService = {
	uploadBytes(filename: string, bytes: Uint8Array): Promise<CoverUploadResult>;
	list(): Promise<CoverImageEntry[]>;
	delete(url: string): Promise<boolean>;
};

/** Returned by `icons.uploadBytes` — content-addressed URLs into the vault
 *  `icons/` store, served via the `brainstorm://icon/` protocol. */
export type IconUploadResult = {
	url: string;
	thumbUrl: string;
};

export type IconEntry = {
	url: string;
	thumbUrl: string;
	hash: string;
	uploadedAt: number;
};

/**
 * The vault's user-uploaded image-icon library ("custom emoji", B11.14).
 * Vault-shared like covers (an icon uploaded from any app is visible to all),
 * so `list` / `delete` aren't app-scoped. `uploadBytes` / `delete` need
 * `icons.write`; `list` needs `icons.read`. The host downscales, dedups by
 * SHA-256, and enforces an ext allow-list + size ceiling (`Invalid` on reject).
 */
export type IconsService = {
	uploadBytes(filename: string, bytes: Uint8Array): Promise<IconUploadResult>;
	list(): Promise<IconEntry[]>;
	delete(url: string): Promise<boolean>;
};

// ─── Blocks (block-id → providing-app registry, 9.11) ───────────────────────

/** A registered Block Protocol block: `id` is `<app-id>/<block-name>`,
 *  `appId` is the providing app the host resolves it to. */
export type BlockInfo = {
	id: string;
	appId: string;
	name: string;
	registeredAt: number;
};

/**
 * Read-only view of the vault's block registry. The host (shell) owns
 * registration — blocks are declared in a manifest's
 * `registrations.blocks` and written on install — so apps only ever
 * read: `list()` enumerates every registered block; `resolve(blockId)`
 * answers "which app renders this block?" (the `BlockEmbedNode`
 * lookup); `source(blockId)` returns the providing app's block bundle
 * (the IIFE string the embedding app inlines into the sandboxed block
 * frame), or `null` when the block ships none. All need `blocks.read`.
 * An unknown / uninstalled block id resolves to `null`, never throws.
 */
export type BlocksService = {
	list(): Promise<BlockInfo[]>;
	resolve(blockId: string): Promise<BlockInfo | null>;
	source(blockId: string): Promise<string | null>;
	/** The block id that renders `entityType` (the live block to embed for an
	 *  entity of that type), or `null` when none claims it — the host then
	 *  embeds the generic shell entity-card. */
	forType(entityType: string): Promise<string | null>;
};

// ─── Block Protocol dispatch (block ↔ host round-trip, 9.4.5) ────────────────

/**
 * The Block Protocol postMessage envelope exchanged across the
 * block↔host frame. Mirrored here as a plain structural shape — the SDK
 * and apps deliberately do NOT pull `@blockprotocol/core`; only the
 * shell (`packages/shell/src/main/bp/`) depends on it and owns the
 * authoritative parser (`BpEnvelope`). This is the app-facing type for
 * `services.bp.dispatch`: the request message a block posts to its
 * embedder, and the response the host returns.
 *
 * The wire form is exactly these fields (BP 0.3 `Message`). `module` /
 * `source` carry string discriminators (`"graph"` / `"hook"`,
 * `"block"` / `"embedder"`) — the shell centralises them as enums
 * (`BpModule` / `BpSource`); apps forward the raw payload they received
 * off the frame, so the SDK keeps them as opaque strings and lets the
 * shell validate.
 */
export type BpMessage = {
	readonly requestId: string;
	readonly messageName: string;
	readonly module: string;
	readonly source: string;
	readonly timestamp: string;
	readonly data?: unknown;
	readonly errors?: ReadonlyArray<{ code: string; message: string; extensions?: unknown }>;
};

/**
 * Forward a Block Protocol request message from an embedded block to the
 * host's BP router, scoped to the embedding `entityId`. The shell
 * structurally re-validates the payload and dispatches by BP module
 * (Graph → entities service, Hook → host overlay); the response message
 * (`messageName` suffixed `Response`, `source: "embedder"`) is returned
 * so the caller can post it back into the block's frame.
 *
 * Returns `null` when the router declines to respond — a structurally
 * malformed or non-dispatchable payload (e.g. a `*Response` echoed back
 * by a misbehaving block). Per the BP spec the embedder may silently
 * drop such input; the caller simply sends nothing back.
 *
 * Declares no capability of its own: `bp.dispatch` is structural routing
 * with no ambient authority. Each Graph operation is enforced per-type
 * against the embedding app's grants on the entities service downstream,
 * so a block inherits exactly the embedding app's data authority (the
 * v1 model — OQ-BP-2).
 */
export type BpService = {
	dispatch(entityId: string, message: BpMessage): Promise<BpMessage | null>;
};

// ─── Storage (app-private KV) ───────────────────────────────────────────────

export type StorageService = {
	put(key: string, value: unknown): Promise<void>;
	get<T = unknown>(key: string): Promise<T | null>;
	list(prefix?: string): Promise<string[]>;
	delete(key: string): Promise<void>;
	/** Write `bytes` to a vault-scoped, app-private content-addressed file
	 *  store and return a stable `brainstorm://app-file/...` URL. Duplicate
	 *  uploads dedup by SHA-256: writing the same bytes twice returns the
	 *  same URL without re-writing the file.
	 *
	 *  `filename` is used only for the extension (the on-disk name is
	 *  `<sha256>.<ext>`); the rest is dropped. `mime` is informational.
	 *  Capability: `storage.kv`. Capped at a per-call byte limit enforced
	 *  by the host (currently 25 MiB; the app receives `Invalid` if it
	 *  exceeds the limit). For files above the single-envelope cap use
	 *  `uploadStreamed` (9.10a) instead. */
	uploadFile(filename: string, bytes: Uint8Array, mime?: string): Promise<UploadedFile>;
	/** 9.10a — open a chunked upload session. Returns an opaque
	 *  `uploadToken` plus the advisory `chunkBytes` size the caller should
	 *  use for each `uploadChunk`. Same content-addressed destination as
	 *  `uploadFile`, so chunked + single-envelope uploads of the same bytes
	 *  dedupe to one on-disk file. Capability: `storage.kv`. */
	uploadBegin(args: UploadBeginArgs): Promise<UploadBeginReply>;
	/** Append one chunk to an open session. `seq` is a monotonically
	 *  increasing counter starting at 0; resending the previous seq with
	 *  identical bytes is a no-op (idempotent retry). Capability: `storage.kv`. */
	uploadChunk(args: UploadChunkArgs): Promise<UploadChunkReply>;
	/** Close + atomic-rename into the content-addressed store. If the caller
	 *  passes `expectedHash`, the worker fails closed unless the streamed
	 *  hash matches. Capability: `storage.kv`. */
	uploadCommit(args: UploadCommitArgs): Promise<UploadedFile>;
	/** Drop an open session + its tmp file. Silent on unknown / already-torn-down
	 *  token — safe to call in a `finally`. Capability: `storage.kv`. */
	uploadAbort(args: UploadAbortArgs): Promise<void>;
	/** **Use this for any payload that might exceed `uploadFile`'s 25 MiB
	 *  single-envelope cap** — large video, big PDFs, raw images. For known-small
	 *  payloads (covers, icons, inline images), prefer `uploadFile` (one IPC
	 *  round trip vs. N).
	 *
	 *  Convenience wrapper around `uploadBegin` → `uploadChunk` (loop) →
	 *  `uploadCommit` / `uploadAbort`: drives the state machine; surfaces
	 *  progress via `onProgress`; propagates cancellation via `signal` (calls
	 *  `uploadAbort` on abort, rethrows the signal's `.reason`). Returns the
	 *  same `UploadedFile` shape as `uploadFile`, and the result deduplicates
	 *  against any single-envelope upload of the same bytes (same
	 *  content-addressed `brainstorm://app-file/<appId>/<sha256>.<ext>` URL).
	 *
	 *  For most apps this is the only thing to call — the four primitive
	 *  methods exist for callers that need to drive the state machine
	 *  themselves (e.g. a UI that wants to pause / resume across multiple
	 *  ticks, or a transfer that supplies bytes from outside an existing
	 *  `Uint8Array`). Capability: `storage.kv`. */
	uploadStreamed(args: UploadStreamedArgs): Promise<UploadedFile>;
};

/**
 * Per-device, app-scoped settings — device-local UI/view state that must
 * NOT sync between devices (Graph/Database view config, dictionary sort,
 * panel layout). Mirrors the `StorageService` key/value surface but is
 * backed by the shell's per-device `settings.db`, never the Yjs sync set
 * (: per-device tier alongside the
 * ledger/registry). Use this — NOT `entities` — for anything that is a
 * device preference rather than a vault object. No capability scope; the
 * service is namespaced by the calling app's verified identity.
 */
export type SettingsService = {
	get<T = unknown>(key: string): Promise<T | null>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	/** All entries whose key starts with `prefix` (""=all). */
	list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
};

/** One object reference in a selection / drag — an identity + a label to
 *  render an affordance, never the object's content. Structurally identical to
 *  `EntityDragPayload` (the intra-app HTML5 drag item); named for the
 *  selection / cross-app-drag context. See
 *  */
export type ObjectDragItem = {
	entityId: string;
	entityType: string;
	label: string;
	iconRef?: string;
};

/** The shell's single selection slot — the focused app's published selection.
 *  `sourceApp` is stamped by the shell from the verified renderer identity, not
 *  app-provided. */
export type SelectionSnapshot = {
	sourceApp: string;
	items: ObjectDragItem[];
};

/** The cross-app drag wire format — the selection in motion (DND-2,
 * ). `sourceApp` is stamped by the shell from the verified
 *  drag session, never app-provided. Canonical home; `@brainstorm/sdk/entity-drag`
 *  re-exports it. */
export type ObjectDragPayload = {
	v: 1;
	sourceApp: string;
	items: ObjectDragItem[];
};

// ─── Cross-app drag session (DND-2, §Part IV.2) ─────────────

/** The kind of thing a drag carries — negotiated by MIME on the same session. */
export enum DragPayloadKind {
	Object = "object",
	File = "file",
	BlockFragment = "block-fragment",
}

/** The cursor affordance a target offers for a hover point (the `dragover`
 *  cross-process equivalent). The least-destructive default is `Link`. */
export enum DropEffect {
	None = "none",
	Copy = "copy",
	Link = "link",
	Move = "move",
}

/** A point in global (screen) coordinates, or — in a notice/delivery — within
 *  the target window's content area. */
export type DragPoint = { x: number; y: number };

/** What the source supplies for the shell-owned ghost overlay (reference-only —
 *  a label + glyph + the N-badge count, never the payload). */
export type DragGhostSpec = {
	label: string;
	iconRef?: string;
	count: number;
};

/** Session metadata the source learns at `begin` — never the items (the source
 *  already has those) and never another app's identity. */
export type DragSessionInfo = {
	sessionId: string;
	payloadKind: DragPayloadKind;
	itemCount: number;
};

/** Hover notice the shell pushes to the window under the cursor (`app:drag-over`).
 *  PRIVACY INVARIANT (OQ-DND-2): kinds + within-window point ONLY — never the
 *  items, never `sourceApp`. The type structurally cannot hold a payload. */
export type DragOverNotice = {
	sessionId: string;
	payloadKind: DragPayloadKind;
	/** Deduped entity-type URLs present in the drag, so the target can decide a
	 *  drop effect without learning *which* objects. */
	itemTypes: string[];
	pointInWindow: DragPoint;
};

/** The full payload delivered to the accepting target ONLY on `drop`
 *  (`app:drop`). The one place items + `sourceApp` cross to a target. */
export type DropDelivery = {
	sessionId: string;
	payloadKind: DragPayloadKind;
	payload: ObjectDragPayload;
	pointInWindow: DragPoint;
	effect: DropEffect;
};

/** The source's view of how a drop ended. */
export type DropResult = {
	delivered: boolean;
	effect: DropEffect;
	/** The app that received the drop, or `null` (dropped on empty space / a
	 *  rejecting target / cancelled). */
	targetApp: string | null;
};

/** The `dnd` host service (DND-2, §Part IV.2). The shell runs
 *  ONE active drag session: stamps `sourceApp`, owns the cursor-following ghost,
 *  hit-tests the target window, negotiates the drop semantic (kinds+point on
 *  hover, payload only on drop), re-checks caps fail-closed. Native HTML5 DnD is
 *  retained only for intra-renderer drags. */
export type DndService = {
	/** Open a drag session for the current selection. Capability: `dnd.drag`. */
	begin(args: {
		payloadKind: DragPayloadKind;
		items: ObjectDragItem[];
		ghost: DragGhostSpec;
		screenPoint: DragPoint;
	}): Promise<DragSessionInfo>;
	/** Report a cursor move (the source renderer forwards its captured pointer,
	 *  throttled to ~60 Hz). The shell repositions the ghost + hit-tests + emits
	 *  `app:drag-over` to a newly-entered target. Capability: `dnd.drag`. */
	move(args: { sessionId: string; screenPoint: DragPoint }): Promise<void>;
	/** Complete the drag at the final cursor point. The shell re-checks the
	 *  target holds `dnd.drop`, delivers `app:drop`, tears down. Capability:
	 *  `dnd.drag`. */
	drop(args: { sessionId: string; screenPoint: DragPoint }): Promise<DropResult>;
	/** Abort the session (Escape / drop on empty space). Capability: `dnd.drag`. */
	cancel(args: { sessionId: string }): Promise<void>;
	/** Called by the hovered TARGET to report the drop effect it would apply at
	 *  the current point (updates the ghost affordance). Capability: `dnd.drop`. */
	setEffect(args: { sessionId: string; effect: DropEffect }): Promise<void>;
	/** Drag a file OUT of Brainstorm to the OS (Finder/another app) — scope D
	 *  (§Part V). The renderer reads the file's bytes (its own
	 *  `files.read`), calls this on a native `dragstart`, and the shell materialises
	 *  them to a temp path and hands the OS drag to `webContents.startDrag`. The
	 *  one native cross-boundary drag Electron supports (files + icon only).
	 *  Capability: `dnd.exportFile`. */
	exportFile(args: DragExportFile): Promise<DragExportResult>;
};

/** A single file to export out of Brainstorm (DND-5). Reference-light: a name
 *  (with extension, for the OS) + the raw decrypted bytes the renderer already
 *  resolved. The shell never reads the encrypted asset store for this. */
export type DragExportFile = {
	name: string;
	bytes: Uint8Array;
};

export type DragExportResult = {
	/** Whether the OS drag was started. `false` = the app's window couldn't be
	 *  resolved, the bytes were empty, or the temp write failed (fail-closed). */
	started: boolean;
};

/** The `selection` host service (DND-1, §Part IV.1). The shell
 *  keeps ONLY the focused app's published selection in a single slot, cleared
 *  on focus change — no cross-app aggregation, no privacy leak between apps.
 *  `selection` is the drag payload at rest; the cross-app drag (DND-2+) carries
 *  it in motion. */
export type SelectionService = {
	/** Publish the calling app's current selection (the set of objects a drag
	 *  would carry if it started now). Replaces this app's slot. Publishing an
	 *  empty array clears the selection. Capability: `selection.publish`. */
	publish(items: ObjectDragItem[]): Promise<void>;
	/** Read the focused app's published selection, or `null` when there is no
	 *  current selection. For selection-driven intents + the action surface +
	 *  the keyboard "move to…" path. Privileged — capability: `selection.read`. */
	current(): Promise<SelectionSnapshot | null>;
};

/** Shell→app push channels for the cross-app drag session (DND-2). The shell
 *  `webContents.send`s these to the window under the cursor; the app-preload
 *  forwards them into the renderer as DOM CustomEvents (`CROSS_APP_DRAG_*`).
 *  Single home so the `dnd` service (emitter) and the preload (forwarder) agree
 *  on the wire names. */
export const APP_DRAG_OVER_CHANNEL = "app:drag-over";
export const APP_DRAG_LEAVE_CHANNEL = "app:drag-leave";
export const APP_DROP_CHANNEL = "app:drop";

/** Renderer-internal DOM CustomEvent names the app-preload re-dispatches the
 *  shell push channels as (so `@brainstorm/sdk/object-dnd`'s drop registry can
 *  subscribe without importing preload internals). Defined here — not in the
 *  React-bearing `object-dnd` barrel — so the lean preload imports just the
 *  names. */
export const CROSS_APP_DRAG_OVER_EVENT = "brainstorm:cross-app-drag-over";
export const CROSS_APP_DRAG_LEAVE_EVENT = "brainstorm:cross-app-drag-leave";
export const CROSS_APP_DROP_EVENT = "brainstorm:cross-app-drop";

export interface UploadBeginArgs {
	/** Used only for the file extension. */
	name: string;
	/** Informational; survives onto `UploadedFile.mime`. */
	mime?: string;
	/** Optional declared total. If provided, the worker fails closed when
	 *  chunks exceed it OR when the streamed total is shorter at commit. */
	totalBytes?: number;
}

export interface UploadBeginReply {
	/** Opaque token — pass to `uploadChunk` / `uploadCommit` / `uploadAbort`. */
	uploadToken: string;
	/** Advisory chunk size the caller SHOULD use. The worker doesn't enforce
	 *  a per-chunk ceiling beyond the per-token total. */
	chunkBytes: number;
}

export interface UploadChunkArgs {
	uploadToken: string;
	/** Monotonic seq starting at 0. Resending `seq - 1` with identical bytes
	 *  is a no-op idempotent retry. Anything else throws `Invalid`. */
	seq: number;
	/** Base64-encoded bytes for this chunk. */
	bytesBase64: string;
}

export interface UploadChunkReply {
	ok: true;
	receivedBytes: number;
}

export interface UploadCommitArgs {
	uploadToken: string;
	/** Optional client-computed SHA-256 (lowercase hex). Worker verifies
	 *  before atomic-rename; mismatch → `Invalid` and the tmp is deleted. */
	expectedHash?: string;
}

export interface UploadAbortArgs {
	uploadToken: string;
}

export interface UploadStreamedArgs {
	/** Used only for the file extension. */
	name: string;
	bytes: Uint8Array;
	mime?: string;
	/** Optional: per-chunk progress callback. `receivedBytes` is the running
	 *  sum of bytes ACK'd by the worker (not just the local send cursor);
	 *  `totalBytes` is always `args.bytes.byteLength`. */
	onProgress?: (receivedBytes: number, totalBytes: number) => void;
	/** Optional: abort the upload mid-stream. The wrapper calls `uploadAbort`
	 *  + rethrows the signal's `.reason` (or `new Error("upload aborted")` if
	 *  unset). Detect with `signal.aborted` after `catch` rather than
	 *  `instanceof AbortError` — the rethrown value is whatever the caller
	 *  passed to `abort(...)`. */
	signal?: AbortSignal;
}

export type UploadedFile = {
	/** `brainstorm://app-file/<appId>/<sha256>.<ext>` — re-readable from any
	 *  renderer in the same vault session. */
	url: string;
	/** Lowercase 64-char SHA-256 of the bytes. */
	hash: string;
	/** Lowercase extension including the dot (e.g. `.webp`). */
	ext: string;
	/** Byte length of the original payload. */
	size: number;
	/** MIME type as passed by the caller, or empty string if omitted. */
	mime: string;
};

// ─── Files (opaque handles, never paths) ────────────────────────────────────

/**
 * Opaque file reference an app holds. Apps never see absolute paths
 * (§Filesystem). The shell mints these via the picker
 * (`requestOpen`/`requestSave`) or the cross-app `handleFromIntent`
 * pass-through; the receiver feeds them straight back into `read`/`write`
 * /`watch` and the shell-side registry swaps token → path inside the
 * trusted main process.
 */
export type FileHandle = {
	readonly handleId: string;
	readonly displayName: string;
};

/** One filter row the picker shows ("Images", "CSV"). Matches Electron's
 *  expected shape. */
export type FileDialogFilter = {
	readonly name: string;
	readonly extensions: readonly string[];
};

/** Why a `files.watch` callback fired. Wire-format strings live here so the
 *  receiving app discriminates structurally, not on raw string literals. */
export enum FileWatchEventKind {
	/** The watched file's content or metadata changed. */
	Changed = "changed",
	/** The watcher reported an error — the file likely went away. The
	 *  subscription stays live until the app calls `unsubscribe`. */
	Errored = "errored",
}

/**
 * The Files host service (Stage 9.10). Capabilities:
 *   - `files.read` — `requestOpen` / `read` / `watch` / `handleFromIntent`
 *   - `files.write` — `requestSave` / `write`
 *
 * `files.read` and `files.write` are **not** default-granted — the app
 * declares them in its manifest and the user approves at install (or via
 * Settings → Security).
 */
export type FilesService = {
	/** Show the OS open-dialog. Cancellation returns `[]` (not an error).
	 *  Multi-select returns up to one handle per chosen file. */
	requestOpen(opts?: {
		readonly title?: string;
		readonly filters?: readonly FileDialogFilter[];
		readonly multi?: boolean;
	}): Promise<readonly FileHandle[]>;
	/** Show the OS save-dialog. Cancellation returns `null`. The app may
	 *  suggest a basename; the shell strips any path component. */
	requestSave(opts?: {
		readonly title?: string;
		readonly filters?: readonly FileDialogFilter[];
		readonly suggestedName?: string;
	}): Promise<FileHandle | null>;
	/** Read the entire file at `handle`. Single-envelope ceiling applies
	 *  (Stage 9.10a will stream large files). */
	read(handle: FileHandle): Promise<Uint8Array>;
	/** Overwrite the file at `handle` with `data`. The handle must be
	 *  writeable (i.e. minted via `requestSave`). */
	write(handle: FileHandle, data: Uint8Array | ArrayBuffer): Promise<void>;
	/** Subscribe to file-modified events. Returns an idempotent
	 *  unsubscribe — the app must call it to free the underlying watcher. */
	watch(
		handle: FileHandle,
		onChange: (event: { kind: FileWatchEventKind }) => void,
	): Promise<Subscription>;
	/** Mint a fresh handle for this app from a `FileHandle` carried by an
	 *  inbound intent (e.g. Files → Database for CSV import). The receiver
	 *  never sees the source app's token; on success the registry mints a
	 *  read-only handle scoped to this app at the same path. Returns
	 *  `null` if the source token is unknown / revoked. */
	handleFromIntent(handle: FileHandle): Promise<FileHandle | null>;
	/** Copy a user-chosen file's bytes INTO the vault's encrypted asset
	 *  store and return what the caller persists on its `File/v1` entity.
	 *  Handle variant (picker flow): the shell reads the path itself —
	 *  bytes never cross IPC. Bytes variant (drag-in flow): the drop
	 *  gesture is the user mediation, mirroring the picker. The stored
	 *  asset serves at `brainstorm://asset/<assetId>`; its `mime` is the
	 *  shell's preview-safe served mime (active content collapses to
	 *  `application/octet-stream`), not necessarily the extension-truthful
	 *  one. `files.read`-gated. */
	import(
		input: { handle: FileHandle } | { name: string; bytes: Uint8Array | ArrayBuffer },
	): Promise<FileImportResult>;
	/** Inventory of every blob taking vault storage — uploads (the encrypted
	 *  asset store) plus covers / wallpapers / icons (content-addressed
	 *  filesystem stores). Read-only; powers the Files "Storage" view so the
	 *  user can see and reclaim what's on disk. `files.read`-gated. */
	listStorageInventory(): Promise<readonly StoredAsset[]>;
};

/** Which storage subsystem a {@link StoredAsset} came from. Wire-format
 *  strings so the Files UI groups/labels structurally, not on literals. */
export enum StoredAssetKind {
	/** A file the user imported into the vault's encrypted asset store. */
	Upload = "upload",
	/** An object cover image. */
	Cover = "cover",
	/** A dashboard wallpaper. */
	Wallpaper = "wallpaper",
	/** A custom app / object icon. */
	Icon = "icon",
	/** A favicon scraped for a bookmark / link. */
	Favicon = "favicon",
}

/** One stored blob, normalized across every storage subsystem for the
 *  Files "Storage" view. */
export type StoredAsset = {
	/** Stable id — the asset id for asset-store blobs, the content hash for
	 *  the filesystem stores. Unique within a `kind`. */
	readonly id: string;
	readonly kind: StoredAssetKind;
	/** Display name: the original filename when known, else `<kind> <hash…>`. */
	readonly name: string;
	readonly mime: string;
	/** Size on disk in bytes; `-1` when it could not be determined. */
	readonly sizeBytes: number;
	/** Resolvable URL (`brainstorm://asset|cover|wallpaper|icon/…`). */
	readonly url: string;
	/** Thumbnail URL when the store generated one, else `null`. */
	readonly thumbUrl: string | null;
	/** Creation / upload time (epoch ms). */
	readonly createdAt: number;
	/** The live entity that owns this blob, when one does — present for
	 *  `Upload` blobs bound to a `File/v1` entity, so the Storage view can
	 *  open the file in Preview. Absent for covers / wallpapers / icons /
	 *  favicons, which aren't openable entities. */
	readonly entityId?: string;
	/** The owning entity's type (e.g. `brainstorm/File/v1`), paired with
	 *  `entityId`. */
	readonly entityType?: string;
};

/** Result of `files.import` — the durable wire-shape for a stored upload. */
export type FileImportResult = {
	readonly assetId: string;
	readonly contentHash: string;
	readonly size: number;
	readonly mime: string;
	readonly name: string;
};

// ─── Credentials (per-app private secrets, encrypted at rest) ───────────────

export type CredentialMetadata = {
	app: string;
	key: string;
	createdAt: number;
	updatedAt: number;
};

export type CredentialsService = {
	get(key: string): Promise<Uint8Array | null>;
	set(key: string, value: Uint8Array): Promise<void>;
	delete(key: string): Promise<boolean>;
	list(): Promise<CredentialMetadata[]>;
};

// ─── Intents ────────────────────────────────────────────────────────────────

/** One app that can handle an intent — surfaced to build an "Open with…"
 *  picker. `label` is the app's display name (resolved shell-side from its
 *  manifest), falling back to `null` when unknown; `appId` is always present.
 *  `priority` mirrors the opener/intent registration (primary = the type's
 *  default handler). */
export type SuggestedIntentHandler = {
	appId: string;
	label: string | null;
	priority: "primary" | "secondary";
};

export type IntentsService = {
	dispatch(intent: Omit<Intent, "source">): Promise<IntentResult | null>;
	/** The apps that can handle this (verb, payload) — default first. Used by
	 *  the shared object menu to offer "Open with ▸" when more than one app
	 *  claims an object. Resolves `[]` when nothing claims it (or the host
	 *  doesn't expose the surface). Read-only — no launch happens. */
	suggest(intent: Omit<Intent, "source">): Promise<SuggestedIntentHandler[]>;
	/** The action surface (doc 63): the contributed actions other installed
	 *  apps offer on `target`, filtered to `verbs`, relevance-gated by the
	 *  target's discriminators, capability-checked, and tagged with their
	 *  trust tier. The host renders + groups + caps them; selecting one
	 *  dispatches `(verb, kind)` to the contributor. Resolves `[]` when nothing
	 *  applies (or the host doesn't expose the surface). Read-only — no launch
	 *  happens until an action is dispatched. */
	suggestActions(input: {
		target: ContributedActionTarget;
		verbs: readonly ContributedVerb[];
	}): Promise<ContributedAction[]>;
};

// ─── Dashboard pinning (Stage 7.13) ─────────────────────────────────────────

/**
 * The app-facing face of "pin any object to the dashboard". An app offers
 * "Pin to dashboard" on one of its objects (via the shared object menu —
 * see §Object menu); the shell
 * places a tile in the same Yjs-backed dashboard grid as app icons.
 *
 * The pin stores only the **entity id** — label, icon and the opener-app
 * badge are resolved live shell-side on every dashboard read (rename /
 * re-icon / delete stay correct without the app re-pinning; a deleted
 * target renders a tombstone, never silently vanishes — OQ-DASH-1).
 *
 * `pin` / `unpin` need the default-minimum `dashboard.pin` capability;
 * `isPinned` is a read over the same grant (the menu needs the toggle
 * state to label itself, so no separate read capability).
 */
export type DashboardService = {
	/** Pin an entity. Idempotent — re-pinning an already-pinned entity is
	 *  a no-op and resolves `true`. `false` only if no vault session. */
	pin(target: { entityId: string }): Promise<boolean>;
	/** Remove the pin for `entityId` (dashboard-state only — never touches
	 *  the object). No-op if not pinned. */
	unpin(target: { entityId: string }): Promise<boolean>;
	/** Whether `entityId` currently has a dashboard pin. */
	isPinned(target: { entityId: string }): Promise<boolean>;
};

/**
 * Render-to-PDF service (B11.12). The app serialises its own content to
 * self-contained HTML (e.g. `@brainstorm/editor`'s `serializedStateToHtml`,
 * which already escapes text + allowlists URL schemes) and hands it here; the
 * shell renders it in a locked-down, script-disabled, network-blocked
 * offscreen window and returns the PDF bytes. The app then saves those bytes
 * through the Files host service like any other export.
 *
 * Capability: `export.print-to-pdf` (default-minimum — exporting your own
 * content is benign and the render context is sandboxed).
 */
export type ExportService = {
	/** Render self-contained HTML to PDF bytes. Throws `Invalid` on a
	 *  non-string or over-large payload, `Unavailable` if rendering fails. */
	printToPdf(input: { html: string }): Promise<Uint8Array>;
	/** Serialize the given entities to Markdown / CSV / JSON text (the inverse of
	 *  {@link ImportService}). Read-only + cap-gated: only entities the app may
	 *  `entities.read` are included; the app saves the text via its `files` cap. */
	serializeEntities(input: { ids: readonly string[]; format: ExportTextFormat }): Promise<string>;
};

/** Source format for an {@link ImportService} request (matches the shell's
 *  `ImportFormat`). */
export type ImportSourceFormat = "json" | "jsonl" | "csv" | "markdown" | "html";

/** One column override an app supplies after a {@link ImportService.preview}:
 *  which vault `property` a source `column` lands in, and whether to import it.
 *  The app picks *where* a column lands — never the target type (that stays the
 *  request's cap-checked `targetType`) nor how values are typed (the engine
 *  infers that). */
export type ImportColumnMapping = {
	column: string;
	property: string;
	include: boolean;
};

/** One import request: the source `text`, its `format`, the vault `targetType`
 *  to create (the app must hold `entities.write:<targetType>`), an optional
 *  `source` id that namespaces the idempotency key (re-import updates, never
 *  duplicates), and an optional column `mapping` (from a `preview`). */
export type ImportRequest = {
	format: ImportSourceFormat;
	text: string;
	targetType: string;
	source?: string;
	mapping?: readonly ImportColumnMapping[];
};

/** What {@link ImportService.preview} returns so an app can build a mapping UI. */
export type ImportPreviewResult = {
	columns: readonly string[];
	recordCount: number;
	sample: ReadonlyArray<Record<string, unknown>>;
};

export type ImportPlanResult = {
	total: number;
	willCreate: number;
	willUpdate: number;
	byType: Readonly<Record<string, number>>;
	warnings: readonly string[];
};

export type ImportRunResult = {
	created: number;
	updated: number;
	skipped: number;
	failed: ReadonlyArray<{ externalId: string | null; reason: string }>;
};

/** IE-2 — run the shared import engine over a source the app already holds.
 *  `plan` is the non-destructive dry-run; `run` commits the idempotent upsert.
 *  Type-scoped on the app's `entities.write:<targetType>` grant. */
export type ImportService = {
	/** Read the source's columns + a row sample (no write) to drive a mapping UI. */
	preview(request: ImportRequest): Promise<ImportPreviewResult>;
	plan(request: ImportRequest): Promise<ImportPlanResult>;
	run(request: ImportRequest): Promise<ImportRunResult>;
};

/**
 * Live-resolved presentation for one entity pin, recomputed shell-side on
 * every dashboard snapshot (never persisted — the `IconRecord` stores
 * only the entity id). Keyed by dashboard icon id in the snapshot's
 * `pins` map. App-kind icons have no entry (they resolve from the app
 * registry as before).
 */
export type PinResolution = {
	/** Current object title (`properties.title ?? properties.name`),
	 *  falling back to the stored `IconRecord.label` then the entity id. */
	label: string;
	/** The object's own universal icon, or `null` → the tile falls back to
	 *  the opener-app badge / id-seeded gradient. */
	icon: Icon | null;
	/** The app that `intent.open` routes this entity to — drawn as the
	 *  small corner badge. `null` when no opener is registered. */
	appId: string | null;
	/** The opener app's human display name — the badge's identity fallback
	 *  when its icon asset can't be resolved (an uninstalled/iconless
	 *  opener). `null` mirrors `appId === null`. */
	appName: string | null;
	/** Target no longer resolves (deleted / binned). The tile renders a
	 *  greyed tombstone with an explicit "remove pin" — never auto-removed
	 *  (a restore-from-Bin re-lights the pin in place). */
	missing: boolean;
};

// ─── Identity (sovereign signing) ───────────────────────────────────────────

export type IdentityUser = {
	id: string;
	publicKeyBase64: string;
	fingerprint: string;
};

export type IdentityService = {
	user(): Promise<IdentityUser>;
	/** Requires `identity.sign` capability. */
	signPayload(payload: Uint8Array): Promise<Uint8Array>;
};

// ─── Roster (vault membership + self-asserted display profiles) ──────────────
//
// The collaboration crypto spine keys membership on raw sovereign Ed25519
// pubkeys (the entity's signed access record). A pubkey can't render in a member
// list, so each identity publishes a self-asserted, signed `Profile/v1`
// {displayName, avatarRef, pubkey}. The roster service joins the two: the
// authoritative pubkey roster from the access record, resolved through the
// cached profiles, so apps render names + faces while the pubkey stays the
// identity. Per §Self-asserted display profile (Collab-C6).

/** Membership role on a shared entity — the wire mirror of the main-side
 *  `AccessRole`. Values are the stored wire format; never renumber. */
export enum RosterRole {
	Owner = "owner",
	Editor = "editor",
	Viewer = "viewer",
}

/** One resolved member of a channel / shared entity. The `pubkey` is the durable
 *  cross-device identity (the join key); the display fields are a best-effort
 *  resolution that may be absent until the member's signed profile snapshot has
 *  propagated (then the UI falls back to the always-resolvable `fingerprint`). */
export type RosterMember = {
	/** base64 sovereign Ed25519 public key — the durable identity + join key. */
	pubkey: string;
	role: RosterRole;
	/** True for the local vault owner ("you"). */
	isSelf: boolean;
	/** `ed25519:<hex>` short fingerprint — always derivable from the pubkey. */
	fingerprint: string;
	/** Resolved display name (a local petname wins over the self-asserted name);
	 *  absent when no profile has been seen for this pubkey yet. */
	displayName?: string;
	/** Asset ref for the member's avatar; absent when none / not yet seen. */
	avatarRef?: string;
};

/** The local user's own display profile. `displayName` is "" until the user has
 *  set one — consumers fall back to the fingerprint or a default. */
export type RosterSelf = {
	pubkey: string;
	fingerprint: string;
	displayName: string;
	avatarRef?: string;
};

export type RosterProfileInput = {
	displayName: string;
	avatarRef?: string;
};

export type RosterService = {
	/** Members of `entityId` (a channel / shared entity) — always includes self,
	 *  including silent members granted access but who have never posted. Requires
	 *  `roster.read`. */
	members(entityId: string): Promise<RosterMember[]>;
	/** The local user's own display profile. Requires `roster.read`. */
	self(): Promise<RosterSelf>;
	/** Set the local user's display profile (signed in-process with the sovereign
	 *  key — an app can only ever write its own vault's profile). Requires
	 *  `roster.write`. */
	setSelf(input: RosterProfileInput): Promise<RosterSelf>;
};

/** A collaborator's self-signed share invite, serialized as a compact,
 *  copy-pasteable token (base64url JSON). It carries only the collaborator's
 *  PUBLIC keys + a signature binding them to the identity — safe to hand over an
 *  out-of-band channel (paste / QR). An owner redeems it via `sharing.share`. */
export type ShareInviteToken = string;

/** One member of a shared entity's signed access record — the durable audit
 *  view (active grants + retained revokes). Pair with `roster.members` for the
 *  display-resolved (name + face) list. */
export type SharedMember = {
	/** base64 sovereign Ed25519 public key — the durable identity + join key. */
	pubkey: string;
	role: RosterRole;
	/** False once revoked; the row is retained for audit. */
	active: boolean;
	/** Revocation timestamp (ms), or null while active. */
	revokedAt: number | null;
};

/** A saved contact — a teammate whose verified invite you've kept, so you can
 *  share to them by a click (share-by-name) instead of re-pasting a code. */
export type SharedContact = {
	/** base64 sovereign Ed25519 public key — the share target + dedup key. */
	pubkey: string;
	displayName: string;
};

/** Collab-C5 — the app-facing window onto multi-user sharing: mint your own
 *  invite, and (as an entity Owner) grant / revoke other people's access. The
 *  crypto is the proven Stage-10 spine (per-entity DEK + HPKE member-wraps +
 *  signed access record); this service is the capability-gated surface over it.
 *  `sharing.read` (mint own invite, read access) is a default grant;
 *  `sharing.share` (grant / revoke — privileged) is scarce and re-checked
 *  server-side, so by default only trusted shell surfaces can grant. */
export type SharingService = {
	/** Mint THIS user's self-signed invite token to hand to an entity Owner
	 *  (paste / QR). Exposes only public keys. Requires `sharing.read`. */
	createInvite(label: string): Promise<ShareInviteToken>;
	/** Owner: grant `invite` access to `entityId` at `role`, delivering the
	 *  entity DEK over the relay so the collaborator can read + sync it. Returns
	 *  the resolved access record. Requires `sharing.share`. */
	share(input: {
		entityId: string;
		type: string;
		/** A pasted invite token, OR omit and pass `contact` (a saved pubkey). */
		invite?: ShareInviteToken;
		/** A saved contact's pubkey — share by name without re-pasting a code. */
		contact?: string;
		role: RosterRole;
	}): Promise<SharedMember[]>;
	/** Owner: share a COLLECTION container (a chat Channel, a Project) — grants
	 *  the target on the container AND cascades the same grant + DEK onto every
	 *  existing child (its messages / tasks), so the whole collection syncs.
	 *  Children created later are auto-shared by the shell. Pass an `invite`
	 *  token or a saved `contact` pubkey. Requires `sharing.share`. */
	shareCollection(input: {
		entityId: string;
		type: string;
		invite?: ShareInviteToken;
		contact?: string;
		role: RosterRole;
	}): Promise<SharedMember[]>;
	/** Save a teammate's pasted invite under a display name so they can later be
	 *  shared-to by a click (share-by-name). Verifies the invite. Requires
	 *  `sharing.read`. */
	saveContact(input: { invite: ShareInviteToken; displayName: string }): Promise<SharedContact>;
	/** The saved contacts directory — the share-by-name picker. Requires
	 *  `sharing.read`. */
	listContacts(): Promise<SharedContact[]>;
	/** Owner: revoke `member` (base64 pubkey). Signed, append-only audit — the
	 *  row is retained. Returns the resolved access record. Requires
	 *  `sharing.share`. */
	revoke(input: { entityId: string; type: string; member: string }): Promise<SharedMember[]>;
	/** The resolved access record (active grants + revoked audit) for `entityId`.
	 *  Requires `sharing.read`. */
	access(entityId: string): Promise<SharedMember[]>;
};

// ─── UI (windows, notifications, menus, settings) ───────────────────────────

export type WindowSpec = {
	windowId: string; // per-app
	title?: string;
	width?: number;
	height?: number;
};

export type Notification = {
	title: string;
	body?: string;
	kind?: "info" | "success" | "warning" | "error";
	/** Stable cross-window identity for a logical alert (e.g. a reminder's
	 *  `${sourceId}#${fireAtMs}`). The shell collapses a second post of the
	 *  same `(appId, dedupeKey)` within a short window so multiple windows of
	 *  the same app don't record/pop the alert twice. Omit for one-off
	 *  notifications (always recorded). */
	dedupeKey?: string;
};

/**
 * One item in an app's published tray section (Stage 7.8). Clicking an
 * item with an `intent` dispatches it through the shell IntentsBus
 * attributed to the publishing app — the tray reuses the curated-verb
 * intent path rather than a bespoke app callback channel. An item with
 * no `intent` is inert (a label/separator-like affordance).
 *
 * v1 renders OS-native (`Tray` + `Menu`); the `fancy-menus` app-rendered
 * tray is the later upgrade once that dep lands.
 */
export type TrayMenuItem = {
	id: string;
	label: string;
	enabled?: boolean;
	intent?: { verb: string; payload?: Record<string, unknown> };
};

export type TraySpec = {
	tooltip?: string;
	items: TrayMenuItem[];
};

/** Publish / clear this app's section of the single shell-owned tray.
 *  Gated by the `tray.publish` capability. */
export type TrayService = {
	publish(spec: TraySpec): Promise<void>;
	clear(): Promise<void>;
};

export type UiService = {
	openWindow(spec: WindowSpec): Promise<string>;
	closeWindow(id: string): Promise<void>;
	notify(notification: Notification): Promise<void>;
	/** 9.8.9 — hand an in-app search off to the shell's global search
	 *  palette (the launcher), optionally pre-filled with `query`. The
	 *  shell focuses the dashboard and opens the palette; the app should
	 *  close its own search UI. Cap `search.open` (install-time grant). */
	openSearch(args: { query?: string }): Promise<void>;
	tray: TrayService;
};

/** Transient cross-surface theme preview (9.9.6; cap `theme.preview`). The
 *  shell sanitizes the spec then paints it across the dashboard + app windows
 *  for `durationMs`, auto-reverting. `clearPreview` reverts immediately. */
export type ThemeService = {
	preview(spec: ThemePreviewSpec): Promise<void>;
	clearPreview(): Promise<void>;
};

// ─── Capabilities ──────────────────────────────────────────────────────────

export type CapabilitiesService = {
	list(): readonly string[];
	request(capability: string, reason: string): Promise<boolean>;
	subscribe(onChange: (capabilities: readonly string[]) => void): Subscription;
};

// ─── Properties (vault-level: PropertyDef + Dictionary catalogs) ────────────

/**
 * Vault-level property + dictionary service — see VP-3 in
 *  and the [[properties-are-vault-level]]
 * memory. The authoritative store lives in the shell; this proxy
 * marshals the requests over the broker and surfaces typed snapshots.
 *
 * Capability gating: `properties.read` for the read-path methods;
 * `properties.write` for `setProperty` / `removeProperty` /
 * `setDictionary` / `removeDictionary`. Both caps are default-minimum
 * grants so apps don't pay a prompt to use the shared catalog.
 *
 * Live updates: `onChange(listener)` fires whenever the shell-owned
 * properties store mutates — including writes from other surfaces
 * (Settings → Data, sibling apps, future sync peers). The listener is
 * intentionally a bare "stale" signal; the app calls `list()` to fetch
 * the authoritative snapshot (re-running the broker's capability
 * check). The SDK's default in-package impl returns a no-op
 * subscription — the preload overrides it with the real IPC-backed
 * channel before exposing the runtime to app code.
 */
export type PropertiesService = {
	list(): Promise<PropertiesSnapshot>;
	getProperty(key: string): Promise<PropertyDef | null>;
	setProperty(def: PropertyDef): Promise<void>;
	removeProperty(key: string): Promise<void>;
	getDictionary(id: string): Promise<Dictionary | null>;
	setDictionary(dict: Dictionary): Promise<void>;
	removeDictionary(id: string): Promise<void>;
	onChange(listener: () => void): Subscription;
};

export type PropertiesSnapshot = {
	properties: Readonly<Record<string, PropertyDef>>;
	dictionaries: Readonly<Record<string, Dictionary>>;
};

// ─── Platform catalog (doc 63 — the Agent context layer) ────────────────────

/** One installed app as the Agent sees it: identity + human display meta. No
 *  bundle paths / signatures — only what's needed to reason about the app. */
export type PlatformCatalogApp = {
	id: string;
	name: string;
	description?: string;
	hasIcon: boolean;
};

/** A property of an object type, distilled from the type's JSON-Schema. */
export type PlatformCatalogProperty = {
	name: string;
	/** JSON-Schema `type` ("string" / "number" / "array" / …), when declared. */
	valueType?: string;
	/** The fixed value set, when the schema constrains the property to an enum. */
	enumValues?: string[];
	required: boolean;
};

/** An object type an app produces + the properties it carries. */
export type PlatformCatalogEntityType = {
	id: string;
	ownerApp: string;
	properties: PlatformCatalogProperty[];
};

/** An action/verb an app handles — a unit of the Agent's tool vocabulary. */
export type PlatformCatalogIntent = {
	ownerApp: string;
	verb: string;
	kind?: string;
	entityType?: string;
	label?: string;
	group?: string;
};

/** The whole-platform snapshot: what apps exist, the object types they produce
 *  (+ properties), and the actions they expose. Read-only, sanitized, and
 *  carries NO vault content — data lives behind `entities` / `search`. doc 63. */
export type PlatformCatalog = {
	apps: PlatformCatalogApp[];
	entityTypes: PlatformCatalogEntityType[];
	intents: PlatformCatalogIntent[];
};

/**
 * Platform introspection (doc 63 — the Agent context layer). A read-only,
 * capability-gated view of the installed-app registry the Agent uses to learn
 * what world it is in: the apps, their object types + properties, and their
 * action vocabulary. The `apps.list` surface anticipated in apps-handlers.ts,
 * broadened to types + intents.
 *
 * Capability: `platform.read` (scarce — not a default grant). The broker
 * re-checks it against the ledger fail-closed.
 */
export type PlatformService = {
	catalog(): Promise<PlatformCatalog>;
};

// ─── Shortcuts (runtime registrations + active-scope, 6.10c) ────────────────

/** Wire shape for a runtime-registered (dynamic) shortcut declaration.
 *  Identical to the manifest's `shortcuts: [...]` entry shape so apps
 *  can declare the same form once and re-use it for state-dependent
 *  registrations. `id` is app-scoped (no `/`); the shell namespaces it
 *  as `app/<app-id>/<id>`. */
export type ShortcutDeclaration = {
	id: string;
	default: string;
	label: string;
	scope?: string;
	shadowsShell?: boolean;
};

/**
 * Apps register state-dependent (dynamic) shortcuts at runtime through
 * this service — per §Aggregation across
 * the sandbox boundary. The shell adds the entries to its
 * `ShortcutRegistry` under `app/<app-id>/<id>` and they survive only
 * for the app's lifetime (cleared on the app's last window close).
 *
 * Capability: `shortcuts.register`, default-granted at install per
 *  §Capabilities ("it's part of being an app"). Static manifest
 * `shortcuts: [...]` declarations don't need this call — they're
 * mirrored at install time (6.10b).
 *
 * Active scope (`setActiveScope`) is the focused app's way of telling
 * the shell what kind of UI surface is active right now (e.g.
 * "editor", "selection") so the cheatsheet can filter narrow-scoped
 * bindings. `null` clears the scope (every binding is treated as
 * active). 6.10c.
 */
export type ShortcutsService = {
	register(args: { additions: readonly ShortcutDeclaration[] }): Promise<void>;
	unregister(args: { ids: readonly string[] }): Promise<void>;
	setActiveScope(args: { scope: string | null }): Promise<void>;
};

/**
 * AI broker — the app-facing surface of the AI foundations (doc 22) and
 * the conversation surface (doc 55). The app sends a transcript; the
 * broker routes to a configured `ModelProvider` (local Ollama in v1-beta,
 * BYO cloud later), enforces `ai.use`, and never exposes a provider key
 * or raw network to the app. The v1 slice is single-shot `generate`;
 * token-streaming (over a push channel) is the next rung.
 *
 * Capability: `ai.use` (+ `ai.provider:<id>` when a provider is pinned).
 */
export type AiService = {
	generate(req: AiGenerateRequest): Promise<AiGenerateResult>;
	/** Transform text — translate / rewrite / re-format (doc 22). Single-shot
	 *  generation under the hood; the output is a suggestion the caller owns. */
	transform(req: AiTransformRequest): Promise<AiTransformResult>;
	/** Extract declared fields from free text as a JSON suggestion (doc 22). */
	extract(req: AiExtractRequest): Promise<AiExtractResult>;
	/** Pre-send token/cost estimate for a generate request (doc 22 §Cost). */
	cost(req: AiGenerateRequest): Promise<AiCostEstimate>;
};

/**
 * MCP host surface (doc 64 — MCP-1). The Agent app (and an Automations AIAgent
 * step) call this to (a) discover the MCP tools it may use this turn and (b)
 * invoke one. The broker re-checks the per-server `mcp.server:<id>` capability
 * against the ledger (fail-closed); the SDK proxy declares it. Tool *results*
 * are UNTRUSTED — the caller tags them before feeding them to the model.
 */
export type McpService = {
	/** The fail-closed set of MCP tools the caller may use — only enabled +
	 *  reachable servers the caller is granted, projected + intersected. Each
	 *  carries its `serverId`/`toolName` for a follow-up `callTool`. */
	listTools(input?: { serverIds?: readonly string[] }): Promise<readonly McpAgentTool[]>;
	/** Invoke a tool. A write (or a tool whose surface changed since approval —
	 *  the rug-pull case) is refused unless `confirmed: true`; a hinted-safe read
	 *  may auto-run. Every call audits (arg-shape only). */
	callTool(input: {
		serverId: string;
		toolName: string;
		args?: Record<string, unknown>;
		confirmed?: boolean;
	}): Promise<{ content: unknown; isError: boolean }>;
};

/**
 * Automations host surface (11b.6 deploy) — the app-facing handle onto the
 * shell-side engine. `runNow` is the Manual trigger ("Run now"); the host
 * status/claim pair is the 11b.15 automation-host designation (which device
 * runs the scheduler — explicit takeover, no automatic failover in v1).
 *
 * Capability: `automations.run`, re-checked server-side.
 */
export type AutomationsRunResult = {
	/** Terminal `WorkflowRunStatus`, or null when the workflow is missing,
	 *  disabled, or refused by the capability gate (the persisted
	 *  `WorkflowRun/v1` carries the denial detail). */
	status: string | null;
};

export type AutomationsHostStatus = {
	/** This device's pairing-layer identity. */
	deviceId: string;
	/** The designated host device id, or null (single-device default —
	 *  every device runs). */
	hostDeviceId: string | null;
	/** Is THIS device currently running the scheduler? */
	scheduling: boolean;
};

export type AutomationsService = {
	/** Run a workflow immediately (Manual trigger). */
	runNow(input: { workflowId: string }): Promise<AutomationsRunResult>;
	/** The automation-host designation as seen by this device. */
	hostStatus(): Promise<AutomationsHostStatus>;
	/** Claim / take over automation hosting for this device. */
	claimHost(): Promise<AutomationsHostStatus>;
};

// ─── The runtime exposed via window.brainstorm ──────────────────────────────

export type AppRuntime = {
	readonly app: AppHandshake["app"];
	readonly capabilities: readonly string[];
	readonly launch: LaunchContext;
	readonly services: {
		readonly entities: EntitiesService;
		readonly vaultEntities: VaultEntitiesService;
		readonly search: SearchService;
		readonly network: NetworkService;
		readonly connectors: ConnectorsService;
		readonly mail: MailService;
		readonly caldav: CalDavService;
		readonly covers: CoversService;
		readonly blocks: BlocksService;
		readonly bp: BpService;
		readonly storage: StorageService;
		readonly settings: SettingsService;
		readonly files: FilesService;
		readonly credentials: CredentialsService;
		readonly intents: IntentsService;
		readonly dashboard: DashboardService;
		readonly export: ExportService;
		readonly import: ImportService;
		readonly icons: IconsService;
		readonly identity: IdentityService;
		readonly properties: PropertiesService;
		readonly platform: PlatformService;
		readonly roster: RosterService;
		readonly sharing: SharingService;
		readonly ui: UiService;
		readonly theme: ThemeService;
		readonly capabilities: CapabilitiesService;
		readonly shortcuts: ShortcutsService;
		readonly ai: AiService;
		readonly mcp: McpService;
		readonly automations: AutomationsService;
		readonly webView: WebViewClient;
		readonly selection: SelectionService;
		readonly dnd: DndService;
	};
	/** B11.16c — spellcheck suggestion seam. Overlaid by the shell preload;
	 *  absent on standalone/preview shells (spellcheck degrades to squiggles
	 *  only). */
	readonly spellcheck?: SpellcheckBridge;
	/** Active UI locale (BCP-47 tag) at the moment the runtime was exposed —
	 *  the launch handshake locale (or `DEFAULT_LOCALE` on non-shell hosts).
	 *  Like `capabilities`, this is a snapshot across the sandbox boundary: the
	 *  LIVE current locale arrives as the argument to `onLocaleChange` (12.15),
	 *  which is the value reactive code should track. */
	readonly locale: string;
	/** Subscribe to live locale changes. The handler fires with the new BCP-47
	 *  tag whenever the user switches language in Settings — the canonical
	 *  reactive source (mirrors `capability-changed`). Returns a `Subscription`
	 *  to detach. */
	onLocaleChange(handler: (locale: string) => void): Subscription;
	/** Active regional-format context (12.15 slice 15f) — locale + hour cycle +
	 *  time zone derived from Settings → Regional. A snapshot across the sandbox
	 *  boundary like `locale`; the LIVE value arrives as the argument to
	 *  `onFormatChange`. Feed it to `@brainstorm/sdk/date-formatters`. */
	readonly format: FormatContext;
	/** Subscribe to live regional-format changes. Fires whenever the user edits
	 *  a Regional setting. Returns a `Subscription` to detach. */
	onFormatChange(handler: (format: FormatContext) => void): Subscription;
	on<T extends LifecycleEvent["type"]>(event: T, handler: LifecycleHandler<T>): Subscription;
};

/**
 * Universal icon model — every entity / property / dictionary item / app
 * / vault can carry an icon, drawn from one of three sources. See
 * .
 *
 * Pack glyphs are addressed as `"<packId>/<glyphName>"` — today the only
 * registered pack is `"phosphor"`. Emoji is the raw codepoint(s). Image
 * is a `brainstorm://icon/<sha256>.<ext>` URL serving the bytes from
 * `<vault>/icons/<sha256>.<ext>`.
 */
export { IconKind, SkinTone } from "./icon";
export type { Icon } from "./icon";

/**
 * Tab-identity favicon codec — encodes a universal `Icon` as the favicon
 * URL an app publishes for the shell-drawn tab strip (the icon twin of
 * `document.title`). Apps call `@brainstorm/sdk/tab-identity`; the shell
 * recognises `TAB_ICON_NONE` as "no icon".
 */
export { TAB_ICON_NONE, emojiFaviconUrl, tabFaviconUrl } from "./tab-identity";

/**
 * Universal cover model — every object can carry a wide banner backdrop,
 * the visual companion to the universal icon. See
 * . Renderer + curated gradient set +
 * id-seeded fallback live in `@brainstorm/sdk/entity-cover`.
 */
export { CoverKind } from "./cover";
export type { Cover, CoverFocal } from "./cover";

/** Shared string-enum membership guard factory — the single
 *  implementation behind every `isLayoutMode` / `isFontRole` /
 *  `isIterationStatus` etc. (was a dozen hand-copied bodies). */
export { enumGuard } from "./enum-guard";

/**
 * Open-resolution pure core (;
 * OpenRes-1a). Target kinds + `normalizeOpenInput` + the dangerous-scheme
 * hard-block floor + the pure terminating ladder (`decideOpen`). The
 * shell-side `OpenResolver` (OpenRes-1b) gathers the facts + executes;
 * this is the side-effect-free decision the totality property tests pin.
 */
export {
	OpenTargetKind,
	OPEN_TARGET_KINDS,
	isOpenTargetKind,
	type OpenTarget,
	type OpenInput,
	HARD_BLOCKED_SCHEMES,
	isHardBlockedScheme,
	normalizeOpenInput,
	OpenRung,
	OpenRefusal,
	OsHandoffConsent,
	OsHandoffPromptDecision,
	OsHandoffSignatureKind,
	OS_HANDOFF_APP_ID,
	OS_HANDOFF_APP_LABEL,
	OpenWithDecisionKind,
	type OpenWithCandidate,
	type OpenWithDecision,
	parseOsHandoffSignature,
	osHandoffSignature,
	type OpenFacts,
	type OpenResolution,
	decideOpen,
} from "./open-resolution";

/**
 * Layouts as data — `brainstorm/Layout/v1`
 * shape + cell-kind enums + validators. Stage 8.1 contract freeze; the
 * resolver (8.2) / render pipeline (8.3) / form-designer (8.10) and the
 * B7 `cover` chrome surface build on this. No blocking OQ (OQ-90 gates
 * the chrome render pipeline at 8.4, not this contract).
 */
export {
	areAppLayoutsValid,
	AppLayoutIssueCode,
	CHROME_KINDS,
	ChromeKind,
	collectCellIds,
	effectiveReadingOrder,
	isChromeKind,
	isLayoutCellKind,
	isLayoutContext,
	isLayoutMode,
	isValidLayout,
	LAYOUT_CELL_KINDS,
	LAYOUT_CONTEXTS,
	LAYOUT_MODES,
	LAYOUT_TYPE_URL,
	LayoutCellKind,
	LayoutContext,
	LayoutIssueCode,
	LayoutMode,
	validateAppLayouts,
	validateLayout,
} from "./layout";
export type {
	AppLayoutConfig,
	AppLayoutIssue,
	AppLayoutManifestEntry,
	BlockCell,
	ChromeCell,
	DividerCell,
	FreeformPlacement,
	GridPlacement,
	GroupCell,
	LayoutCell,
	LayoutDef,
	LayoutIssue,
	PropertyCell,
	TextCell,
} from "./layout";

/**
 * Typography — `brainstorm/Typography/v1`, one of the three composable
 * theme pieces (§Typography). Stage 8.7
 * contract freeze; the theme-editor (9.9) + app-preload theme injection
 * consume the resolved stacks. No bundled font binaries in v1.
 */
export {
	FONT_ROLES,
	FontRole,
	isFontRole,
	isTypographyScale,
	isValidTypography,
	resolveFontStack,
	SYSTEM_TYPOGRAPHY,
	TYPOGRAPHY_SCALES,
	TYPOGRAPHY_TYPE_URL,
	TypographyIssueCode,
	TypographyScale,
	validateTypography,
} from "./typography";
export type { FontStack, TypographyDef, TypographyIssue } from "./typography";

/**
 * Icon packs — `brainstorm/IconPack/v1` + the shell-curated canonical
 * icon-name registry (§Icon packs).
 * Stage 8.6 contract/registry half; the `<Icon>` component / `useIcon`
 * hook / pack-resolver (renderer) consume it. Ships no SVG glyphs.
 */
export {
	CANONICAL_ICON_NAMES,
	CANONICAL_ICON_REGISTRY_VERSION,
	ICON_PACK_STYLES,
	ICON_PACK_TYPE_URL,
	IconPackIssueCode,
	IconPackStyle,
	isAppScopedIconName,
	isCanonicalIconName,
	isIconPackStyle,
	isReferenceableIconName,
	isValidIconPack,
	resolveIconSvg,
	validateIconPack,
} from "./icon-pack";
export type { IconGlyph, IconPackDef, IconPackIssue, IconPackMetadata } from "./icon-pack";
export {
	IconPackSvgSanitizeCode,
	IconPackSvgSanitizeSeverity,
	findIconPackSvgIssues,
	isIconPackSvgSafe,
	sanitizeIconPackSvg,
} from "./icon-pack-sanitizer";
export type { IconPackSvgSanitizeIssue } from "./icon-pack-sanitizer";

/**
 * Canonical semantic-token namespace — the frozen `--kebab` CSS variable
 * names a `brainstorm/TokenSet/v1` may override (
 * store.md §Validation). Snapshot of the `@brainstorm/tokens` flattened
 * key space; pinned by a drift test in the tokens package.
 */
export { CANONICAL_TOKEN_NAMES, TOKEN_NAME_VERSION, isCanonicalTokenName } from "./token-names";

/**
 * Token sets — `brainstorm/TokenSet/v1`, one of the three composable
 * theme pieces (§What's distributed). Stage
 * 9.9.1 contract freeze; the theme-editor (9.9) authors them as partial
 * override maps over the base theme and the render layer applies them.
 */
export {
	EMPTY_TOKEN_SET,
	TOKEN_SET_APPEARANCES,
	TOKEN_SET_TYPE_URL,
	TokenSetAppearance,
	TokenSetIssueCode,
	isTokenSetAppearance,
	isValidTokenSet,
	resolveTokenOverrides,
	validateTokenSet,
} from "./token-set";
export type { TokenSetDef, TokenSetIssue } from "./token-set";

/**
 * Themes — `brainstorm/Theme/v1`, the composite referencing one
 * TokenSet + IconPack + Typography (and optionally a StylePack, 9.9.4).
 * Stage 9.9.1 contract freeze; the theme-editor (9.9) composes them and
 * the shell resolves + applies the union. References are structural only
 * — dependency resolution lands in 9.9.5.
 */
export {
	BUILTIN_ICON_PACK,
	BUILTIN_TOKEN_SET,
	BUILTIN_TYPOGRAPHY,
	DEFAULT_THEME_COMPOSITE,
	THEME_REF_KINDS,
	THEME_TYPE_URL,
	ThemeIssueCode,
	ThemeRefKind,
	isThemeRefKind,
	isValidTheme,
	isValidThemeRef,
	resolveThemeRef,
	validateTheme,
} from "./theme";
export type { ThemeComponentRef, ThemeDef, ThemeIssue } from "./theme";

/**
 * Style packs — `brainstorm/StylePack/v1`, the optional fourth composable
 * theme piece: user-authored raw CSS targeting the frozen `data-bs-*` hook
 * surface (§What's distributed; OQ-183). Stage
 * 9.9.4 contract freeze. The canonical CSS lives in the entity's code
 * buffer; `properties.css` mirrors it. `sanitizeStylePackCss` is the
 * bundle validator that blocks script/network/exfil vectors.
 */
export {
	EMPTY_STYLE_PACK,
	STYLE_PACK_BODY_ROOT,
	STYLE_PACK_CSS_MIME,
	STYLE_PACK_ISSUE_CODES,
	STYLE_PACK_TYPE_URL,
	StylePackIssueCode,
	isStylePackIssueCode,
	isValidStylePack,
	resolveStylePack,
	validateStylePack,
} from "./style-pack";
export type { StylePackDef, StylePackIssue } from "./style-pack";
export {
	StylePackSanitizeCode,
	StylePackSanitizeSeverity,
	isStylePackCssSafe,
	sanitizeStylePackCss,
} from "./style-pack-sanitizer";
export type { StylePackSanitizeIssue } from "./style-pack-sanitizer";

/**
 * Token-set contrast lint (WCAG 2.1; OQ-171) — asserts the text-bearing
 * foreground/background token pairs meet minimum contrast over the resolved
 * (base ∪ overrides) colour values. Used by the theme-editor (9.9.6) + CLI.
 */
export {
	CONTRAST_PAIRS,
	ContrastLevel,
	contrastRatio,
	lintTokenContrast,
	parseColor,
} from "./token-set-contrast";
export type { ContrastIssue, ContrastPair } from "./token-set-contrast";

/**
 * The frozen `data-bs-region` hook contract (OQ-183) — stable chrome
 * anchors StylePack CSS targets. The shell + SDK stamp these; a structural
 * guard asserts they're present in the rendered chrome.
 */
export {
	STYLE_HOOK_ATTR,
	STYLE_HOOK_REGIONS,
	STYLE_HOOK_VERSION,
	isStyleHookRegion,
} from "./style-hooks";

/**
 * Transient cross-surface theme preview (9.9.6; OQ-170) — the theme-editor
 * asks the shell to paint a theme across all surfaces for a few seconds then
 * revert. `sanitizeThemePreview` is the trusted chokepoint (canonical tokens
 * + safe values only) since the spec crosses from a sandboxed app.
 */
export {
	THEME_PREVIEW_DEFAULT_MS,
	THEME_PREVIEW_MAX_MS,
	THEME_PREVIEW_MAX_VALUE_LEN,
	THEME_PREVIEW_MIN_MS,
	clampPreviewDuration,
	isUnsafePreviewValue,
	sanitizeThemePreview,
} from "./theme-preview";
export type { ThemePreviewPayload, ThemePreviewSpec } from "./theme-preview";

/**
 * Automations — `brainstorm/Workflow|Trigger|WorkflowRun|Reminder/v1`
 * (doc 39). Stage 11b.1 contract freeze: shapes + enums + structural
 * validators + the security keystone (`agent-tools ⊆ workflow-caps ⊆
 * app-caps`, fail-closed). The shell-side scheduler (11b.2) + runner
 * (11b.3/.4) interpret these; AI/HTTP/Code step kinds are declared but
 * their interpreters are gated.
 */
export {
	AutomationIssueCode,
	CapabilityTier,
	ConcurrencyPolicy,
	CONCURRENCY_POLICIES,
	ENGINE_STEP_KINDS,
	ENGINE_TRIGGER_KINDS,
	ENTITY_EVENT_VERBS,
	ENTITY_OPS,
	EXPORT_TEXT_FORMATS,
	EntityEventVerb,
	EntityOp,
	MEMORY_MODES,
	MemoryMode,
	REMINDER_TYPE_URL,
	STEP_KINDS,
	StepKind,
	TERMINAL_RUN_STATUSES,
	TRIGGER_KINDS,
	TRIGGER_TYPE_URL,
	TriggerKind,
	WORKFLOW_RUN_STATUSES,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
	WorkflowRunStatus,
	aggregateWorkflowCapabilities,
	agentToolCapabilities,
	capabilityImplies,
	isCapabilitySubset,
	isConcurrencyPolicy,
	isEntityEventVerb,
	isEntityOp,
	isMemoryMode,
	isStepKind,
	isTriggerKind,
	isValidReminder,
	isValidTrigger,
	isValidWorkflow,
	isValidWorkflowRun,
	isWorkflowRunStatus,
	missingCapabilities,
	stepCapabilities,
	validateCapabilityTiers,
	validateReminder,
	validateTrigger,
	validateWorkflow,
	validateWorkflowRun,
} from "./automations";
export type {
	AgentTool,
	AICallStep,
	AIAgentStep,
	AutomationIssue,
	BranchStep,
	CapabilityTierInput,
	CapabilityTierResult,
	CapabilityViolation,
	CodeStep,
	EntityStep,
	ExportStep,
	ExportTextFormat,
	ForEachStep,
	HTTPStep,
	IntentStep,
	NotifyStep,
	ReminderDef,
	StepId,
	SubWorkflowStep,
	TriggerDef,
	TriggerStep,
	WaitStep,
	WorkflowDef,
	WorkflowRunDef,
	WorkflowStep,
} from "./automations";
export {
	propertiesToReminder,
	propertiesToTrigger,
	propertiesToWorkflow,
	reminderToProperties,
	triggerToProperties,
	workflowToProperties,
} from "./automation-codec";
export { completeReminder, snoozeReminder } from "./reminder-transitions";
export {
	COMMENT_KINDS,
	COMMENT_TYPE_URL,
	CommentIssueCode,
	CommentKind,
	CommentStatus,
	buildThreads,
	commentStatus,
	isCommentKind,
	isValidComment,
	openThreadCount,
	threadCommentIds,
	threadKeyFor,
	validateComment,
} from "./comments";
export type {
	CommentAnchor,
	CommentDef,
	CommentIssue,
	CommentSuggestion,
	CommentThread,
} from "./comments";

// ─── Conversation / messaging (doc 55 — Agent app + Chats foundation) ───────
export {
	AI_EXTRACT_FIELD_TYPES,
	AI_STREAM_EVENT_KINDS,
	AI_TRANSFORM_KINDS,
	aiCapabilitiesForRequest,
	aiExtractCapabilitiesForRequest,
	aiTransformCapabilitiesForRequest,
	AiExtractFieldType,
	AiStreamEventKind,
	AiTransformKind,
	buildExtractMessages,
	buildTransformMessages,
	estimateTokens,
	extractFieldsFromTypeSchema,
	mergeExtractFields,
	CONVERSATION_MEMORY_MODES,
	CONVERSATION_TYPE_URL,
	ConversationIssueCode,
	ConversationMemoryMode,
	isAiExtractFieldType,
	isAiStreamEventKind,
	isAiTransformKind,
	isConversationMemoryMode,
	parseExtractResult,
	isMessageRole,
	isSenderKind,
	isValidConversation,
	isValidMessage,
	isValidMemory,
	MEMORY_TYPE_URL,
	MemoryIssueCode,
	validateMemory,
	AI_CONTENT_PART_KINDS,
	ANTHROPIC_PROVIDER_ID,
	ATTACHMENT_KINDS,
	AiContentPartKind,
	AttachmentKind,
	GEMINI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	isAiContentPartKind,
	isAttachmentKind,
	MESSAGE_ROLES,
	MESSAGE_TYPE_URL,
	MISTRAL_PROVIDER_ID,
	MessageRole,
	OLLAMA_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	SENDER_KINDS,
	SenderKind,
	messageText,
	senderRole,
	validateConversation,
	validateMessage,
} from "./conversation";
export type {
	AiChatMessage,
	AiContentPart,
	AiCostEstimate,
	AiExtractField,
	AiExtractRequest,
	AiExtractResult,
	AiGenerateRequest,
	AiGenerateResult,
	AiImagePart,
	AiProvenance,
	AiTextPart,
	AiStreamEvent,
	AiTransformRequest,
	AiTransformResult,
	AiUsage,
	TypeSchemaForExtract,
	AssistantSender,
	ConversationDef,
	ConversationIssue,
	EntityAttachment,
	MediaAttachment,
	MemoryDef,
	MemoryIssue,
	MessageAttachment,
	MessageDef,
	MessageSender,
	ParticipantSender,
	PersonAttachment,
	ToolSender,
	UserSender,
} from "./conversation";

// ─── Shared agent loop (11b.7 — Automations AIAgent + Agent app) ────────────
export {
	AGENT_LOOP_DEFAULT_MAX_ITERATIONS,
	AGENT_LOOP_MAX_ITERATIONS_CEILING,
	AgentStopReason,
	ToolRefusalReason,
	buildAgentSystemPrompt,
	intersectAgentTools,
	parseAgentReply,
	runAgentLoop,
} from "./agent-loop";
export type {
	AgentLoopConfig,
	AgentLoopPorts,
	AgentLoopResult,
	AgentLoopStep,
	AgentToolCall,
} from "./agent-loop";

// ─── MCP integrations (doc 64 — MCP client) ─────────────────────────────────
export {
	HTTP_MCP_TRANSPORTS,
	MCP_SPAWN_LOCAL_CAP,
	MCP_STDIO_MAX_ARGS,
	MCP_TOOL_DESCRIPTION_MAX,
	MCP_TOOL_NAME_MAX,
	MCP_TOOLS_PER_SERVER_MAX,
	McpFrictionDecision,
	McpRugPullKind,
	McpServerHealth,
	McpTransportKind,
	decideToolFriction,
	detectRugPull,
	fingerprintTools,
	intersectMcpTools,
	isHttpMcpTransport,
	isServerGranted,
	isStdioMcpTransport,
	isValidMcpServerId,
	isValidStdioArgs,
	isValidStdioCommand,
	mcpServerCapability,
	mcpServerCredentialKeyName,
	mcpToolId,
	projectMcpTools,
	sanitizeToolDescriptor,
	toolDescriptorFingerprint,
} from "./mcp";
export type {
	McpAgentTool,
	McpApprovedFingerprints,
	McpRugPull,
	McpServerConfig,
	McpToolDescriptor,
} from "./mcp";

// ─── Connector framework (doc 56) ──────────────────────────────────────────
export {
	AUTH_STATES,
	AuthState,
	CONFLICT_POLICIES,
	CONNECTOR_ACCOUNT_TYPE_URL,
	CONNECTOR_TYPE_URL,
	ConflictPolicy,
	ConnectorIssueCode,
	EgressRefusalReason,
	ENGINE_SYNC_DIRECTIONS,
	MAX_SYNC_MAPPINGS_HARD,
	MAX_SYNC_MAPPINGS_SOFT,
	SYNC_DIRECTIONS,
	SYNC_MAPPING_TYPE_URL,
	SYNC_RUN_STATUSES,
	SYNC_RUN_TYPE_URL,
	SyncDirection,
	SyncRunStatus,
	TERMINAL_SYNC_RUN_STATUSES,
	capabilityImplies as connectorCapabilityImplies,
	connectorEgressCapabilities,
	connectorRequiredCapabilities,
	isAuthState,
	isConflictPolicy,
	isEgressAllowed,
	isSyncDirection,
	isSyncRunStatus,
	isValidConnector,
	isValidConnectorAccount,
	isValidSyncMapping,
	isValidSyncRun,
	isWildcardAll,
	parseOriginPattern,
	validateConnector,
	validateConnectorAccount,
	validateConnectorRequest,
	validateSyncMapping,
	validateSyncRun,
} from "./connector";
export type {
	ConnectorAccountDef,
	ConnectorDef,
	ConnectorIssue,
	EgressDecision,
	SyncMappingDef,
	SyncRunDef,
} from "./connector";

// ─── Mail (Mailbox app — doc 53) ───────────────────────────────────────────

export {
	AUTH_KINDS,
	AuthKind,
	deriveThreadKey,
	EMAIL_TYPE_URL,
	FOLDER_ROLES,
	FolderRole,
	formatMailAddress,
	isAuthKind,
	isEmailAddress,
	isFolderRole,
	isMailFlag,
	isMailProtocol,
	isSyncWindow,
	isValidEmail,
	isValidMailAccount,
	isValidMailFolder,
	MAIL_ACCOUNT_TYPE_URL,
	MAIL_FLAGS,
	MAIL_FOLDER_TYPE_URL,
	MAIL_PROTOCOLS,
	MailFlag,
	MailIssueCode,
	MailProtocol,
	normalizeAddress,
	parseAddressList,
	parseMailAddress,
	SYNC_WINDOW_ALL_MAX_MESSAGES,
	SYNC_WINDOWS,
	syncWindowDays,
	SyncWindow,
	validateEmail,
	validateMailAccount,
	validateMailFolder,
} from "./mail";
export type {
	EmailDef,
	MailAccountDef,
	MailAddress,
	MailFolderDef,
	MailHostConfig,
	MailIssue,
	ThreadInput,
} from "./mail";

// ─── CalDAV (Calendar two-way sync — 9.15.19) ──────────────────────────────

export {
	CALDAV_ACCOUNT_TYPE_URL,
	CALDAV_CALENDAR_REF_PROP,
	CALDAV_CALENDAR_TYPE_URL,
	CALDAV_SYNC_STATES,
	CalDavIssueCode,
	CalDavSyncState,
	isCalDavSyncState,
	validateCalDavAccount,
	validateCalDavCalendar,
} from "./caldav";
export type {
	CalDavAccountDef,
	CalDavCalendarDef,
	CalDavCalendarInfo,
	CalDavIssue,
	CalDavService,
	CalDavSyncSummary,
} from "./caldav";

// ─── Web Browser (doc 54 — WebView host-service wire contract) ─────────────

export {
	APP_WEBVIEW_EVENT_CHANNEL,
	APP_TAB_COMMAND_CHANNEL,
	SitePermissionKind,
	TabCommandKind,
	TabLoadState,
	TabSecurityState,
	WEB_BROWSE_CAP,
	WEB_CAPTURE_CAP,
	WEBVIEW_SERVICE,
	WebViewEventKind,
	WebViewMethod,
} from "./web-view";
export type {
	TabCommand,
	WebViewClient,
	WebViewEvent,
	WebViewRect,
	WebViewRequest,
} from "./web-view";

// ─── Recurrence (shared by Tasks + Calendar) ───────────────────────────────

export {
	type CustomRecurrence,
	type DailyRecurrence,
	isRecurrence,
	type MonthlyRecurrence,
	type Recurrence,
	RecurrenceKind,
	WEEKDAYS,
	Weekday,
	type WeeklyRecurrence,
	type YearlyRecurrence,
} from "./recurrence";
export {
	MAX_OCCURRENCES,
	type OccurrenceOptions,
	birthdayOccurrencesInRange,
	occurrencesInRange,
	yearlyRecurrenceForDate,
} from "./recurrence-occurrences";
export {
	DEFAULT_RECURRENCE_LABELS,
	type OrdinalKey,
	type RecurrenceSummaryLabels,
	summarizeRecurrence,
} from "./recurrence-summary";
export { nextOccurrence } from "./recurrence-next";
export { recurrenceToRRule, rruleToRecurrence, stripRRulePrefix } from "./recurrence-rrule";

// ─── Properties + dictionaries (vault-level contract) ───────────────────────

export {
	ALLOWED_VIEWS,
	type Cardinality,
	CARDINALITY_HARD_MAX,
	type CellProps,
	DateGranularity,
	type DateValue,
	DEFAULT_CARDINALITY,
	defaultViewFor,
	type Dictionary,
	type DictionaryItem,
	type DisplayOptions,
	type EntityFilter,
	FILE_ENTITY_TYPE,
	isAllowedView,
	isMultiValued,
	isRequired,
	KIND_PRESET_ORDER,
	type LabeledValue,
	type MultiValueElementByValueType,
	PRESET_DEFAULTS,
	type PresetDefaults,
	type PropertyDef,
	PropertyFormat,
	PropertyKindPreset,
	type PropertyValue,
	type PropertyValueByValueType,
	PropertyView,
	type Range,
	type ScalarValueByValueType,
	type Scope,
	presetOf,
	ValueType,
	type VocabularyRef,
} from "./properties";

export {
	COLLECTION_TYPE_URL,
	ListMode,
	type MemberExclude,
	type MemberInclude,
	type MemberOverrides,
	type MemberOverrideSource,
	MEMBERS_HARD_CAP,
} from "./collections";

export {
	TEMPLATE_TYPE_URL,
	TemplateKind,
	type Template,
	TEMPLATE_CONTROL_KEYS,
	TEMPLATE_PRESENTATION_KEYS,
} from "./templates";

// ─── Property predicate / filter language (9.3.5.1b) ────────────────────────

export {
	type Comparand,
	type FilterGroupNode,
	FilterGroupOp,
	type FilterNode,
	FilterNodeKind,
	type FilterPredicateNode,
	isPropertyRef,
	type PropertyPath,
	type PropertyPredicate,
	type PropertyRef,
	type ScalarValue,
} from "./predicate";

// ─── Collection shapes: List / ListSource / ListView (9.3.5.1b) ─────────────

export {
	type BoardLayoutOptions,
	type CalendarLayoutOptions,
	CalendarRange,
	CalendarRecurring,
	CalendarWeekStart,
	type ColumnFormula,
	type ColumnRollup,
	type ColumnSpec,
	type CompiledViewFilter,
	CompositeOp,
	EmptyPlacement,
	type GalleryLayoutOptions,
	type GridLayoutOptions,
	type GroupBy,
	type LayoutOptions,
	LinkDirection,
	type List,
	type ListLayoutOptions,
	type ListSource,
	type ListSourceByFilter,
	type ListSourceByLink,
	type ListSourceByType,
	type ListSourceByVocabulary,
	type ListSourceComposite,
	ListSourceKind,
	type ListView,
	ListViewKind,
	type SortKey,
	SortDirection,
	type TimelineLayoutOptions,
	TimelineDensity,
	TimelineMode,
} from "./list";

// ─── Self-hosting entity types (Brainstorm-builds-Brainstorm) ───────────────

export {
	DESIGN_DOC_CATEGORIES,
	DESIGN_DOC_JSON_SCHEMA,
	type DesignDocCategory,
	type DesignDocEntity,
	ITERATION_JSON_SCHEMA,
	ITERATION_STATUSES,
	type IterationEntity,
	IterationStatus,
	MILESTONE_JSON_SCHEMA,
	type MilestoneEntity,
	OPEN_QUESTION_JSON_SCHEMA,
	OPEN_QUESTION_STATUSES,
	type OpenQuestionEntity,
	OpenQuestionStatus,
	RELEASE_JSON_SCHEMA,
	RELEASE_STATUSES,
	type ReleaseEntity,
	ReleaseStatus,
	SELF_HOSTING_ENTITY_TYPES,
	SELF_HOSTING_JSON_SCHEMAS,
	type SelfHostingEntity,
	SelfHostingEntityType,
	STAGE_JSON_SCHEMA,
	type StageEntity,
	isDesignDocCategory,
	isIterationStatus,
	isOpenQuestionStatus,
	isReleaseStatus,
	isSelfHostingEntityType,
} from "./self-hosting";
export { defaultIconForType, GENERIC_TYPE_ICON } from "./type-icon";

// ─── Universal rich-text body (§Universal rich-text body) ──────

/**
 * The reserved `Y.XmlText` root name carrying every entity's universal,
 * lazy rich-text body — `"root"`, the well-known name `@lexical/yjs`
 * binds to. Centralised so the preload bridge, react-yjs helpers, shell
 * ydoc transport, and the per-app body editors (Notes / Tasks /
 * Bookmarks workflows) all name the same root by the same string.
 * Changing the value or its type would invalidate every existing
 * snapshot and break the @lexical/yjs binding — pinned by
 * `universal-body.test.ts`.
 */
export { UNIVERSAL_BODY_FRAGMENT_NAME, type UniversalBodyFragmentName } from "./universal-body";

/**
 * Canonical entity Y.Doc layout — the well-known roots that make the
 * entity's Y.Doc the source of truth and `entities.db` a derived
 * projection. Centralised so the
 * ydoc worker, entities service, projection codec, and apps name the same
 * roots by the same strings; part of the on-disk protocol.
 */
export {
	ENTITY_PROPS_MAP_NAME,
	ENTITY_LINKS_ARRAY_NAME,
	type EntityPropsMapName,
	type EntityLinksArrayName,
	type EntityDocLink,
} from "./entity-doc";

/** The action surface (doc 63) — the verb / group / trust enums, the wire
 *  types, and the pure grouping / dedupe / cap / trust logic shared by the
 *  shell resolver and the SDK host primitive. */
export {
	ACTION_GROUP_ORDER,
	ActionGroup,
	ActionTrustTier,
	ContributedVerb,
	INLINE_ACTIONS_PER_GROUP,
	type ContributedAction,
	type ContributedActionGroup,
	type ContributedActionTarget,
	contributedActionId,
	groupContributedActions,
	groupForVerb,
} from "./contributed-actions";
