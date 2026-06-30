/**
 * IntentsBus — shell-mediated dispatch for the curated intent verbs per
 *  and the navigation resolver per
 * .
 *
 * Stage 7.5 lands the minimum-viable surface:
 *   - `suggest(query)` — list registered handlers for a (verb, payload) pair.
 *   - `dispatch(request)` — pick a handler and route to it. For the
 *     navigation verbs (`open` / `quick-look`) with an `entityId` payload,
 *     route to the LaunchOrchestrator with a
 *     `LaunchContext = { reason: "open-entity", entityId }` and, for an
 *     already-running destination, also push the original verb over the
 *     `app:intent` channel (so e.g. Preview can tell a quick-look from an
 *     open). Other verbs return a structured no-channel error in v1 — the
 *     full delivery surface lands per-verb when they need it.
 *
 * Navigation modes + focus-existing (per) live in `launchInto`:
 * the open payload's `navMode` (replace / new-tab / new-window) chooses the
 * placement, and a route-equivalent already-open tab is focused instead of
 * duplicated. Tab routes are seeded from the launch context at open time;
 * `ui.windows.setRoute` (app-published in-place navigation) is the additive
 * follow-up that keeps the route current after a replace.
 */

import {
	ActionTrustTier,
	type ContributedAction,
	type ContributedActionTarget,
	type ContributedVerb,
	type Intent,
	type LaunchContext,
	OS_HANDOFF_APP_ID,
	OS_HANDOFF_APP_LABEL,
	OpenRefusal,
	OpenRung,
	type OpenTarget,
	OpenTargetKind,
	type OpenWithCandidate,
	type OpenWithDecision,
	OpenWithDecisionKind,
	OsHandoffConsent,
	OsHandoffPromptDecision,
	OsHandoffSignatureKind,
	SendIntentVerb,
	contributedActionId,
	decideOpen,
	groupForVerb,
	normalizeOpenInput,
	osHandoffSignature,
} from "@brainstorm/sdk-types";
import { entityRoute } from "../../shared/route";
import { NavigationMode } from "../../shared/window-types";
import type { LaunchOrchestrator } from "../apps/launch-orchestrator";
import type { AppLauncher, AppWindow } from "../apps/launcher";
import type {
	IntentQuery,
	IntentRecord,
	IntentsRepository,
} from "../storage/registry-repo/intents-repo";
import {
	type OpenerRecord,
	OpenerTargetKind,
	type OpenersRepository,
} from "../storage/registry-repo/openers-repo";
import type { EntityTargetResolver } from "./entity-target";
import { deliverIntentToAppWindow } from "./intent-broadcast";
import { sanitizeActionLabel } from "./sanitize-label";

/** The curated navigation verbs the bus resolves id→type/MIME for and
 *  hands a launch/delivery channel. `open` additionally unions the
 *  `openers` registry into its handler set; `quick-look` routes purely on
 *  the `quick-look` intent rows (Preview's per-MIME handlers). Centralised
 *  so the literals aren't re-typed across the resolver paths (per
 *  CLAUDE.md — no raw string discriminators). */
export const OPEN_VERB = "open";
const QUICK_LOOK_VERB = "quick-look";

/** Mailbox-4 — the composer-routing verbs. A dispatch routes to the
 *  handling app (the mail composer) with the full intent riding the launch
 *  context (fresh window) or the `app:intent` push (running window). */
const COMPOSER_VERBS: ReadonlySet<string> = new Set([
	SendIntentVerb.Compose,
	SendIntentVerb.Reply,
	SendIntentVerb.Forward,
]);

/** The action-surface verbs (doc 63 / AS-3) that ride a generic delivery
 *  channel: a dispatch routes to the contributing app with the full intent on
 *  the launch context (fresh window) or pushed over `app:intent` (running
 *  window) — same pattern the composer verbs use. `compose` is already a
 *  composer verb (handled above); the rest gain a channel here so a contributed
 *  `process`/`convert`/`share`/`export`/`insert` action actually reaches its
 *  handler instead of dead-ending at `no-delivery-channel`. */
const ACTION_SURFACE_VERBS: ReadonlySet<string> = new Set([
	"process",
	"convert",
	"share",
	"export",
	"insert",
]);

/** Synthetic handler id for a shell-side `send` (doc 53 §Sending — the
 *  MailTransport performs the submission; no app window is the handler).
 *  Sibling of `SYSTEM_HANDLER_ID`. */
const MAIL_TRANSPORT_HANDLER_ID = "mail-transport";

/** `source.app` value the shell/dashboard uses (mirrors
 *  `intent-handlers.ts` SHELL_INTENT_SOURCE). A shell-originated open is a
 *  user click in trusted chrome, so it may hand off to the OS implicitly
 *  (the first-use consent prompt is the review) — an app must hold
 *  `system.open-external`. */
const SHELL_INTENT_SOURCE = "shell";

/** Synthetic handler id reported for a successful OS handoff (doc 57
 *  rung 5). Not a real app — distinguishes "the OS opened it" from an
 *  in-vault app launch in the dispatch result + future analytics. */
const SYSTEM_HANDLER_ID = "system";

/** Pick the app for a set of opener rows: a `primary` opener wins, else
 *  the first row (install order). Mirrors `pickHandler`'s priority band. */
function pickOpenerAppId(rows: readonly OpenerRecord[]): string | null {
	return (rows.find((r) => r.kind === "primary") ?? rows[0])?.appId ?? null;
}

/** The distinct app ids in an opener-row set, preserving order of first
 *  appearance. Two openers from the same app (e.g. primary `https` + a
 *  secondary `http`) collapse to one entry. */
function uniqueAppIds(rows: readonly OpenerRecord[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of rows) {
		if (!seen.has(r.appId)) {
			seen.add(r.appId);
			out.push(r.appId);
		}
	}
	return out;
}

/** Build the picker candidate list from opener rows: primary openers
 *  first, then secondaries; one row per distinct app id (a primary +
 *  secondary from the same app collapse to "primary"). Labels resolve
 *  via `resolveAppLabel`, falling back to the bare appId.
 *
 *  When `includeOsHandoff` is true (OpenRes-1c slice 7 — sticky
 *  app-vs-OS first-use fork), appends the OS-handoff sentinel as a
 *  trailing candidate so the picker also surfaces "Open with system
 *  default" for the user to pick + optionally pin as the sticky
 *  default. The label `OS_HANDOFF_APP_LABEL` is a string constant in
 *  English; the renderer maps the sentinel app id to the localized
 *  copy via `t(shell.openWith.prompt.osHandoffLabel)`. */
function buildOpenWithCandidates(
	rows: readonly OpenerRecord[],
	resolveAppLabel: ((appId: string) => string) | undefined,
	includeOsHandoff: boolean,
): OpenWithCandidate[] {
	const seen = new Set<string>();
	const primary: OpenWithCandidate[] = [];
	const secondary: OpenWithCandidate[] = [];
	for (const r of rows) {
		if (seen.has(r.appId)) continue;
		seen.add(r.appId);
		const label = resolveAppLabel ? resolveAppLabel(r.appId) : r.appId;
		const candidate: OpenWithCandidate = { appId: r.appId, label, kind: r.kind };
		if (r.kind === "primary") primary.push(candidate);
		else secondary.push(candidate);
	}
	const ordered = [...primary, ...secondary];
	if (includeOsHandoff) {
		ordered.push({
			appId: OS_HANDOFF_APP_ID,
			label: OS_HANDOFF_APP_LABEL,
			kind: "os-handoff",
		});
	}
	return ordered;
}

/** Payload shape the SDK ships over the wire — same as */
export type IntentEnvelope = {
	verb: string;
	payload: Record<string, unknown>;
};

/** Stamp the resolved rung onto a launch result. The bus delegates the
 *  actual launch to `launchInto`, which doesn't know which rung
 *  produced the appId — we re-stamp on the way back so every dispatch
 *  result carries the rung. Preserves every other field. */
function stampRung(result: IntentDispatchResult, rung: OpenRung): IntentDispatchResult {
	if (result.handled) {
		return { ...result, rung };
	}
	return { ...result, rung };
}

/** Full dispatch result. `handled` mirrors §Failure modes.
 *
 *  **OpenRes-1c "Why did this open here?" data layer (2026-05-23)**: both
 *  variants carry an optional `rung: OpenRung` so a consumer (the future
 *  in-app explainer tooltip, telemetry, tests) can answer "which rung
 *  resolved this open" without re-running the resolver. The `handled:
 *  false` variant additionally carries `refusal: OpenRefusal` when the
 *  rung is `Refused`, surfacing *why* the floor or unknown-target rung
 *  blocked the open (dangerous scheme vs nothing-claims-it). All fields
 *  are optional so callers that don't care keep their existing shape —
 *  no migration needed in the renderer / IPC layers that ignore them. */
export type IntentDispatchResult =
	| {
			handled: true;
			handler: { appId: string; windowId?: string };
			value?: unknown;
			rung?: OpenRung;
	  }
	| {
			handled: false;
			reason: "no-handler" | "no-delivery-channel" | "cancelled" | "handler-error";
			message?: string;
			rung?: OpenRung;
			refusal?: OpenRefusal;
	  };

/** Suggested handler descriptor surfaced to the dispatching app. */
export type SuggestedHandler = {
	appId: string;
	label: string | null;
	priority: "primary" | "secondary";
};

export type IntentsBusOptions = {
	intents: IntentsRepository;
	orchestrator: LaunchOrchestrator;
	/** Optional launcher reference for delivering intents to *running*
	 *  apps. When omitted, `dispatch` falls back to the launch-context-
	 *  only path (newly-opened windows receive the intent via their
	 *  handshake; running apps stay focused but miss the new context).
	 *  Wired in production at `runtime/launch-setup.ts`; tests can omit
	 *  to keep the bus pure. */
	launcher?: AppLauncher;
	/** The `openers` registry. An opener row *is* "app X opens
	 *  entity-type/MIME Y" — semantically the `open` verb — so for that
	 *  verb its rows are merged into the intent handlers (apps that only
	 *  declared an opener, e.g. a pure viewer, are otherwise unreachable).
	 *  Optional so the bus stays pure in unit tests. */
	openers?: OpenersRepository;
	/** Resolves a bare entity id to its `{ type, mime }` so an `open`
	 *  dispatch that carries only an id (the common case — a mention, a
	 *  graph node) still reaches the type-specific opener. Optional; when
	 *  omitted the bus matches only on what the caller put in the payload
	 *  (the pre-resolver behaviour). */
	resolveEntityTarget?: EntityTargetResolver;
	/** The generic-object editor (Notes) — the doc-31 §Resolution
	 *  "fallback renderer" for the `open` verb. Many vault types have no
	 *  app-specific opener (e.g. `brainstorm/Person/v1`, owned by the
	 *  Contacts provider, surfaced only as a curated List inside Database);
	 *  without this an id-only/typed `open` of one of them resolved to
	 *  zero handlers and silently no-op'd (the reported "clicking graph
	 *  nodes does nothing"). Every object has a rich-text body (per the
	 *  universal-body design — apps are workflows over one object space),
	 *  so the default editor for an otherwise-unclaimed object is Notes.
	 *  When set, an `open` that resolved a real entity type but matched no
	 *  handler routes here instead. The fallback is *secondary* and only
	 *  applied when nothing else claims the type, so a Note still opens in
	 *  Notes, a Task in Tasks, etc. A per-(verb, type) user override lands
	 *  with Settings → Defaults (Stage 8, doc 37 §Default handlers).
	 *  Optional so the bus stays pure in unit tests. */
	genericEntityViewerAppId?: string;
	/** The Settings → Defaults override: the user's chosen handler app id
	 *  for a `(verb, entityType)` pair, or `null` when unset. Consulted
	 *  before same-app / priority selection — and honoured even when the
	 *  chosen app isn't a natural candidate (the user picked it explicitly;
	 *  a synthetic handler is synthesised so the choice is never silently
	 *  dropped). A stale override whose app no longer claims the pair still
	 *  routes via the normal pick. Wired from the DashboardStore in
	 *  `runtime/launch-setup.ts`; omitted in unit tests. */
	resolveDefaultHandler?: (
		verb: string,
		entityType: string | undefined,
	) => (string | null) | Promise<string | null>;
	/** OpenRes-1b — the open-resolution ladder's external rungs. When a
	 *  `open` payload normalizes to a `scheme` / `file` target (a bookmark
	 *  URL, an attachment) instead of an entity, `dispatch` runs the pure
	 *  `decideOpen` ladder using these. All optional so the bus stays pure
	 *  in unit tests and entity/internal dispatch is byte-for-byte
	 *  unchanged when they're omitted. */
	/** Active vault path — lets `normalizeOpenInput` tell an in-vault
	 *  `file:` from an out-of-vault one (the security floor). */
	getVaultPath?: () => string | null;
	/** Per-vault first-use OS-handoff consent for a target signature
	 *  (`scheme:https` / `ext:pdf`). Absent ⇒ first-use. */
	resolveOsHandoffConsent?: (signature: string) => OsHandoffConsent | Promise<OsHandoffConsent>;
	/** May this dispatch source hand off to the OS? Shell/first-party
	 *  chrome clicks always may (the consent prompt is the review); an app
	 *  / agent must hold `system.open-external`. */
	mayHandoff?: (sourceApp: string) => boolean | Promise<boolean>;
	/** The one OS-handoff boundary — `shell.openExternal` for a scheme,
	 *  `shell.openPath` for a file (doc 57 §System default). The single
	 *  place the resolver leaves the vault; injected so the bus stays
	 *  testable and there is exactly one egress chokepoint to audit. */
	openExternal?: (target: OpenTarget) => Promise<{ ok: boolean; error?: string }>;
	/** Raise the OpenRes-1c first-use consent prompt for `signature`
	 *  (`scheme:<scheme>` / `ext:<ext>`) + a user-facing `uri` (the actual
	 *  URL / file path being opened). Absent ⇒ no prompt available; the
	 *  bus falls back to the existing fail-closed explained refusal. */
	promptOsHandoffConsent?: (signature: string, uri: string) => Promise<OsHandoffPromptDecision>;
	/** Persist the user's allow/deny decision so the next attempt for the
	 *  same signature skips the prompt. Per-vault, sibling to
	 *  `setDefaultHandler`. Absent ⇒ decisions are session-scoped only. */
	recordOsHandoffConsent?: (signature: string, decision: OsHandoffConsent) => Promise<void> | void;
	/** OpenRes-1c slice 6 — raise the multi-candidate "Open with…" picker
	 *  for `signature` (`scheme:<scheme>` / `ext:<ext>`) + the user-facing
	 *  `uri` + the ordered candidate list. Absent ⇒ no picker; the bus
	 *  falls back to the pre-slice-6 silent first-pick (primary opener
	 *  wins, else first-registered). Slot is only consulted when there
	 *  are 2+ candidates — a single opener never raises the picker. */
	promptOpenWith?: (
		signature: string,
		uri: string,
		candidates: readonly OpenWithCandidate[],
	) => Promise<OpenWithDecision>;
	/** Resolve the human-readable label for one app id (read from the
	 *  manifest, with a process-lifetime cache). The bus calls this for
	 *  every candidate the picker shows. Falls back to the bare appId
	 *  when omitted. */
	resolveAppLabel?: (appId: string) => string;
	/** Persist the user's "Remember" choice as the `(open, signature)`
	 *  default so the next attempt for the same signature skips the
	 *  picker and goes straight to the chosen app. The signature is the
	 *  same `scheme:<scheme>` / `ext:<ext>` form `resolveDefaultHandler`
	 *  already reads. Absent ⇒ remember is best-effort no-op (session-
	 *  scoped only; the user can re-pick next time). */
	recordDefaultHandler?: (verb: string, signature: string, appId: string) => Promise<void> | void;
	/** Mailbox-4 — the shell-side delivery channel for the `send` verb (doc
	 *  53 §Sending: submission is idempotent and shell-side; no app window
	 *  handles it). The broker already ledger-checked the dispatcher for
	 *  `intents.dispatch:send` before the bus ran; the handler re-validates
	 *  the payload and dedupes on the client-stamped `submissionId`. Absent
	 *  ⇒ `send` reports no-delivery-channel (fail closed). */
	sendMail?: (payload: Record<string, unknown>, sourceApp: string) => Promise<unknown>;
	/** The action surface (doc 63 / AS-4) — the trust tier of a contributing
	 *  app, derived from its install provenance (first-party / catalog-signed →
	 *  Trusted; sideloaded/unsigned → Sideloaded). `suggestActions` tags every
	 *  contribution so the host can quarantine sideloaded rows under "More…".
	 *  Absent ⇒ everything reads as `Sideloaded` (the safe default — nothing
	 *  ranks inline without a positive trust signal). */
	resolveTrustTier?: (appId: string) => ActionTrustTier;
	/** The action surface (doc 63 / AS-4 + §Security) — the set of app ids whose
	 *  contributions the user has disabled wholesale (Settings → an app's
	 *  contributions). `suggestActions` drops every row from a listed app.
	 *  Resolved once per call (off the active vault's dashboard doc); absent ⇒
	 *  nothing is disabled. */
	resolveDisabledContributors?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
};

export class IntentsBus {
	constructor(private readonly options: IntentsBusOptions) {}

	async suggest(envelope: IntentEnvelope): Promise<SuggestedHandler[]> {
		const query = await this.resolveQuery(envelope);
		const handlers = this.candidatesFor(query);
		// An opener row carries no label (only explicit intent rows do), so fall
		// back to the app's manifest display name — the "Open with…" picker shows
		// "Books" / "Preview", never the bare `io.brainstorm.books` id.
		return handlers.map((h) => ({
			appId: h.appId,
			label: h.label ?? this.options.resolveAppLabel?.(h.appId) ?? null,
			priority: h.priority,
		}));
	}

	/**
	 * The action surface (doc 63 / AS-1+AS-2): the contributed actions other
	 * installed apps offer on `target`, restricted to `verbs`, relevance-gated
	 * by the target's discriminators (OQ-AS-2 — resolved type/mime, no value
	 * predicates), attributed + trust-tagged, and with the dispatching app's
	 * own contributions filtered out (an app doesn't surface its own actions as
	 * cross-app contributions — those are its built-ins). The host renders +
	 * groups + caps them via `groupContributedActions`; selecting one dispatches
	 * `(verb, kind)` to the contributor through the same fail-closed path. Pure
	 * read — no launch. Resolves `[]` when nothing applies.
	 */
	async suggestActions(
		input: { target: ContributedActionTarget; verbs: readonly ContributedVerb[] },
		source: { app: string },
	): Promise<ContributedAction[]> {
		const verbs = input.verbs.filter((v) => typeof v === "string" && v.length > 0);
		if (verbs.length === 0) return [];

		// Resolve the target's discriminators — an id-only target (the common
		// case: a mention, a graph node, a header ⋯) is widened to its
		// `{ type, mime }` so a contribution keyed on `entityType` still matches.
		const discriminators: { entityType?: string; mime?: string; format?: string } = {};
		if (input.target.entityType) discriminators.entityType = input.target.entityType;
		if (input.target.mime) discriminators.mime = input.target.mime;
		if (input.target.format) discriminators.format = input.target.format;
		const entityId = input.target.entityId;
		if (
			entityId &&
			(!discriminators.entityType || !discriminators.mime) &&
			this.options.resolveEntityTarget
		) {
			const resolved = await this.options.resolveEntityTarget(entityId);
			if (resolved?.type && !discriminators.entityType) discriminators.entityType = resolved.type;
			if (resolved?.mime && !discriminators.mime) discriminators.mime = resolved.mime;
		}

		const rows = this.options.intents.findActions(verbs, discriminators);
		const disabled = (await this.options.resolveDisabledContributors?.()) ?? null;
		const out: ContributedAction[] = [];
		for (const row of rows) {
			// An app never hosts its own contributions as cross-app actions — its
			// own actions are its built-ins. Skip the dispatcher's own rows.
			if (row.appId === source.app) continue;
			// Trust gate (AS-4): the user can disable a contributor wholesale.
			if (disabled?.has(row.appId)) continue;
			const trustTier = this.options.resolveTrustTier?.(row.appId) ?? ActionTrustTier.Sideloaded;
			const appLabel = this.options.resolveAppLabel?.(row.appId) ?? row.appId;
			const kind = row.kind ?? undefined;
			// The label is shell-rendered with attribution (doc 63 §Security —
			// "<label> — <app>") so a contribution can't impersonate a built-in.
			// The contributor's declared label is sanitized to a bounded plain
			// string; an absent label falls back to a verb+app description.
			const label = sanitizeActionLabel(row.label) ?? `${row.verb} — ${appLabel}`;
			out.push({
				id: contributedActionId(row.verb, kind, row.appId),
				verb: row.verb as ContributedVerb,
				...(kind ? { kind } : {}),
				label,
				...(row.icon ? { icon: row.icon } : {}),
				group: groupForVerb(row.verb),
				priority: row.priority,
				trustTier,
				appId: row.appId,
				appLabel,
			});
		}
		return out;
	}

	async dispatch(
		inEnvelope: IntentEnvelope,
		source: { app: string; webContentsId?: number },
	): Promise<IntentDispatchResult> {
		let envelope = inEnvelope;
		// Mailbox-4 — `send` is handled shell-side by the MailTransport, not
		// routed to an app window. The broker already checked the dispatcher
		// holds `intents.dispatch:send`; the mail service validates the
		// payload and dedupes on `submissionId` (idempotent on Message-ID).
		if (envelope.verb === SendIntentVerb.Send) {
			if (!this.options.sendMail) {
				return {
					handled: false,
					reason: "no-delivery-channel",
					message: `verb "${envelope.verb}" has no delivery channel in this shell version`,
				};
			}
			try {
				const value = await this.options.sendMail(envelope.payload, source.app);
				return { handled: true, handler: { appId: MAIL_TRANSPORT_HANDLER_ID }, value };
			} catch (error) {
				return { handled: false, reason: "handler-error", message: (error as Error).message };
			}
		}
		// OpenRes-1b — the `open` verb is the open-resolution ladder's one
		// entry. A payload that normalizes to a `scheme` / `file` target
		// (a bookmark URL, an attachment — not an entity id/type) takes the
		// external branch (floor → in-vault opener → OS handoff → explained
		// refusal). Entity / `brainstorm://entity` / id-less payloads fall
		// through to the **unchanged** entity flow below (zero regression).
		if (envelope.verb === OPEN_VERB) {
			const openInput: {
				entityId?: string;
				url?: string;
				deepLink?: string;
				path?: string;
			} = {};
			const pEntityId = stringOrUndefined(envelope.payload.entityId);
			if (pEntityId) openInput.entityId = pEntityId;
			const pUrl = stringOrUndefined(envelope.payload.url);
			if (pUrl) openInput.url = pUrl;
			const pDeepLink = stringOrUndefined(envelope.payload.deepLink);
			if (pDeepLink) openInput.deepLink = pDeepLink;
			const pPath = stringOrUndefined(envelope.payload.path);
			if (pPath) openInput.path = pPath;
			const vaultPath = this.options.getVaultPath?.() ?? undefined;
			const target = normalizeOpenInput(openInput, vaultPath ? { vaultPath } : undefined);
			if (target && (target.kind === OpenTargetKind.Scheme || target.kind === OpenTargetKind.File)) {
				return this.dispatchExternalOpen(target, envelope, source);
			}
			if (target && target.kind === OpenTargetKind.Internal && !target.entityId) {
				// A non-user-openable internal asset URL — explained refusal,
				// never the OS (decideOpen rung 6).
				return {
					handled: false,
					reason: "no-handler",
					message: `nothing can open ${target.uri} (internal, non-openable)`,
				};
			}
			// Internal `brainstorm://entity/<id>` → route to the entity flow.
			if (target && target.kind === OpenTargetKind.Internal && target.entityId) {
				envelope = {
					verb: envelope.verb,
					payload: { ...envelope.payload, entityId: target.entityId },
				};
			}
		}

		const query = await this.resolveQuery(envelope);
		const handlers = this.candidatesFor(query);
		// A user-set default (Settings → Defaults) is honoured even when the
		// chosen app isn't a natural candidate — they picked it explicitly,
		// so synthesise a handler rather than silently dropping the choice.
		const overrideAppId =
			(await this.options.resolveDefaultHandler?.(query.verb, query.entityType)) ?? null;
		const candidates =
			overrideAppId && !handlers.some((h) => h.appId === overrideAppId)
				? [...handlers, syntheticHandler(overrideAppId, query)]
				: handlers;
		if (candidates.length === 0) {
			return { handled: false, reason: "no-handler" };
		}

		// "Open with <app>" — the object menu stamps the user's explicit pick as
		// `handlerAppId`. An explicit per-open choice beats the stored default
		// and same-app routing; honoured only when that app is a real candidate
		// (a forged/stale id falls through to the normal pick, never launches an
		// app that can't claim the target).
		const forcedAppId = stringOrUndefined(envelope.payload.handlerAppId);
		const forced = forcedAppId ? candidates.find((h) => h.appId === forcedAppId) : undefined;
		const handler = forced ?? pickHandler(candidates, source, overrideAppId);
		const launchContext = launchContextFor(envelope, source.app);
		if (!launchContext) {
			// v1: only the navigation verbs (`open` / `quick-look`) have a
			// defined delivery channel (launch with LaunchContext + the
			// `app:intent` push for a running window). Other verbs need their
			// own runtime:lifecycle channel, which lands per-verb later.
			return {
				handled: false,
				reason: "no-delivery-channel",
				message: `verb "${envelope.verb}" has no delivery channel in this shell version`,
			};
		}

		const launched = await this.launchInto(handler.appId, launchContext, envelope, source);
		// The entity-flow + verb-with-explicit-handler paths land here.
		// Stamp `InVaultOpeners` so the renderer-side explainer (OpenRes-1c)
		// can surface "Opened in <App>" toasts uniformly. The external-open
		// branch stamps its own rung via `stampRung(...)` on each arm
		// (InVaultOpeners / StoredDefault / OsHandoff / Refused).
		return stampRung(launched, OpenRung.InVaultOpeners);
	}

	/**
	 * Launch (or focus + re-notify) one app for a resolved handler. If the
	 * destination is already running the launcher focuses the existing
	 * window without re-firing the handshake — so the new launch context
	 * never reaches the renderer; we look the window up first and, when
	 * found, also push the intent over `app:intent` so the running app
	 * re-reacts. Shared by the entity flow and the external-opener branch
	 * so both deliver context identically.
	 */
	private async launchInto(
		appId: string,
		launchContext: LaunchContext,
		envelope: IntentEnvelope,
		source: { app: string; webContentsId?: number },
	): Promise<IntentDispatchResult> {
		const mode = navModeFromPayload(envelope.payload);
		const route = launchContext.reason === "open-entity" ? entityRoute(launchContext.entityId) : null;

		// Focus-existing: a plain click or new-tab on an already-open route focuses
		// that tab instead of opening a duplicate. Explicit new-window skips it.
		if (route && mode !== NavigationMode.NewWindow) {
			const focused = this.options.launcher?.focusTabByRoute?.(route);
			if (focused) return { handled: true, handler: { appId, windowId: focused.windowId } };
		}

		try {
			let window: AppWindow;
			if (mode === NavigationMode.NewWindow) {
				window = await this.options.orchestrator.openInNewWindow({ appId, launch: launchContext });
			} else if (mode === NavigationMode.NewTab) {
				window = await this.openInNewTab(appId, launchContext, source);
			} else {
				// Replace — focus/create the app's main window; if it was already
				// running, push the intent so the renderer navigates in place.
				const existing: AppWindow | null = this.options.launcher?.getExistingWindow(appId) ?? null;
				window = await this.options.orchestrator.launch({ appId, launch: launchContext });
				if (existing) {
					deliverIntentToAppWindow(window, {
						verb: envelope.verb as Intent["verb"],
						payload: envelope.payload,
						source: source.app,
					});
				}
			}
			return { handled: true, handler: { appId, windowId: window.windowId } };
		} catch (error) {
			return { handled: false, reason: "handler-error", message: (error as Error).message };
		}
	}

	/** new-tab mode: add a tab to the source window's container when it's the
	 *  same app (the Chrome model — Cmd+Click opens next to where you clicked);
	 *  otherwise to the target app's existing container, or a fresh window when
	 *  the target app isn't open yet (tabs are intra-app per). */
	private async openInNewTab(
		appId: string,
		launchContext: LaunchContext,
		source: { app: string; webContentsId?: number },
	): Promise<AppWindow> {
		const launcher = this.options.launcher;
		const sourceContainerId =
			source.app === appId && source.webContentsId !== undefined
				? (launcher?.containerIdForWebContents(source.webContentsId) ?? null)
				: null;
		const targetContainerId =
			sourceContainerId ?? launcher?.getExistingWindow(appId)?.container.id ?? null;
		if (targetContainerId) {
			return this.options.orchestrator.addTab(targetContainerId, { appId, launch: launchContext });
		}
		return this.options.orchestrator.launch({ appId, launch: launchContext });
	}

	/**
	 * The open-resolution ladder's external rungs (doc 57): a `scheme` /
	 * `file` target. Gathers the facts, runs the **pure** `decideOpen`,
	 * then executes — delegate to an in-vault opener (rung 2/3), hand off
	 * to the OS (rung 5, cap + first-use-consent gated), or return an
	 * *explained* refusal (rung 6 — the floor, an unhandled target, or a
	 * not-yet-recorded first-use consent; the interactive prompt is
	 * OpenRes-1c). Never silent.
	 */
	private async dispatchExternalOpen(
		target: Extract<OpenTarget, { kind: OpenTargetKind.Scheme | OpenTargetKind.File }>,
		envelope: IntentEnvelope,
		source: { app: string },
	): Promise<IntentDispatchResult> {
		const signature =
			target.kind === OpenTargetKind.Scheme
				? osHandoffSignature(OsHandoffSignatureKind.Scheme, target.scheme)
				: osHandoffSignature(OsHandoffSignatureKind.Ext, target.extension ?? "");

		const openerRows =
			target.kind === OpenTargetKind.Scheme
				? (this.options.openers?.listForTarget(OpenerTargetKind.Scheme, target.scheme) ?? [])
				: target.extension
					? (this.options.openers?.listForTarget(OpenerTargetKind.Extension, target.extension) ?? [])
					: [];

		const storedDefaultAppId =
			(await this.options.resolveDefaultHandler?.(OPEN_VERB, signature)) ?? null;
		const consent =
			(await this.options.resolveOsHandoffConsent?.(signature)) ?? OsHandoffConsent.FirstUse;
		const callerMayHandoff =
			source.app === SHELL_INTENT_SOURCE
				? true
				: ((await this.options.mayHandoff?.(source.app)) ?? false);

		const resolution = decideOpen(target, {
			entityResolvable: false,
			hasStoredDefault: storedDefaultAppId !== null,
			hasInVaultOpener: openerRows.length > 0,
			consent,
			callerMayHandoff,
		});

		const uri = target.kind === OpenTargetKind.Scheme ? target.uri : target.path;

		switch (resolution.rung) {
			case OpenRung.StoredDefault: {
				// The user pinned "Open with system default" for this scheme /
				// extension — `defaultHandlers` stores the sentinel app id.
				// The pin IS the consent for a granted / first-use signature,
				// so skip the prompt and fall straight to the OS-handoff
				// chokepoint. A previously-Denied consent still wins though
				// — "never open this in OS" beats a later "always open this
				// in OS" pin, so the user has one path to stay denied
				// (clearing the pin in Settings) without their old explicit
				// refusal being silently overridden. Stamp `rung: OsHandoff`
				// (not StoredDefault) so the explainer surface reads the
				// truth — "Opened with system default" — rather than
				// "Opened in <app named __os__>".
				if (storedDefaultAppId === OS_HANDOFF_APP_ID) {
					if (consent === OsHandoffConsent.Denied) {
						return {
							handled: false,
							reason: "no-handler",
							message: `you blocked opening ${uri} (clear in Settings → Privacy)`,
							rung: OpenRung.OsHandoff,
						};
					}
					return this.executeOsHandoff(target, uri);
				}
				if (!storedDefaultAppId) {
					return {
						handled: false,
						reason: "no-handler",
						message: `no opener for ${uri}`,
						rung: resolution.rung,
					};
				}
				const launched = await this.launchInto(
					storedDefaultAppId,
					{ reason: "deep-link", deepLink: uri },
					envelope,
					source,
				);
				return stampRung(launched, resolution.rung);
			}
			case OpenRung.InVaultOpeners: {
				// OpenRes-1c slice 6 + slice 7 — picker raised when there's
				// ANY user-meaningful choice to make:
				//
				//   • slice 6 — 2+ distinct in-vault openers claim the same
				//     signature (`https` claimed by both Web-Browser and
				//     Bookmarks). The user picks which app handles it.
				//
				//   • slice 7 — 1+ in-vault opener AND the caller may hand
				//     off to the OS AND the user hasn't explicitly denied
				//     OS-handoff for this signature (`consent !== Denied`).
				//     This is the sticky app-vs-OS first-use fork: instead
				//     of silently routing every `https` click into the
				//     installed in-vault browser, ask the user once
				//     ("Open in Web Browser, or use the system default?").
				//     Pinning either choice (`remember: true`) persists it
				//     as the `(open, signature)` default the next attempt
				//     reads from `resolveDefaultHandler`.
				//
				// A single in-vault candidate AND no OS option (caller can't
				// hand off, or OS already denied) AND no picker wired keeps
				// the legacy auto-pick — zero regression.
				const distinctApps = uniqueAppIds(openerRows);
				const offerOsHandoff = callerMayHandoff && consent !== OsHandoffConsent.Denied;
				const candidates = this.options.promptOpenWith
					? buildOpenWithCandidates(openerRows, this.options.resolveAppLabel, offerOsHandoff)
					: [];
				if (candidates.length > 1 && this.options.promptOpenWith) {
					const decision = await this.options.promptOpenWith(signature, uri, candidates);
					if (decision.kind === OpenWithDecisionKind.Cancel) {
						return {
							handled: false,
							reason: "cancelled",
							message: `cancelled — choose an app to open ${uri}`,
							rung: resolution.rung,
						};
					}
					const pickedAppId = decision.appId;
					if (decision.remember) {
						await this.options.recordDefaultHandler?.(OPEN_VERB, signature, pickedAppId);
					}
					if (pickedAppId === OS_HANDOFF_APP_ID) {
						// The picker offered "Open with system default" too —
						// route through the shared OS-handoff chokepoint so
						// the result reads as rung=OsHandoff (the explainer
						// surfaces "Opened with system default"). The pick IS
						// the consent; skip the OS-handoff first-use prompt.
						return this.executeOsHandoff(target, uri);
					}
					if (!distinctApps.includes(pickedAppId)) {
						// Defensive: the renderer must not return an app id
						// that wasn't in the candidate list. Treat a forged
						// reply as a cancel so we never launch an app the
						// user didn't see in the picker.
						return {
							handled: false,
							reason: "no-handler",
							message: `no opener for ${uri}`,
							rung: resolution.rung,
						};
					}
					const launched = await this.launchInto(
						pickedAppId,
						{ reason: "deep-link", deepLink: uri },
						envelope,
						source,
					);
					return stampRung(launched, resolution.rung);
				}
				const appId = pickOpenerAppId(openerRows);
				if (!appId) {
					// Resolver said this rung should handle it but no opener
					// produced an app id (registry race / overlay-not-yet-
					// observed). Stamp the rung so the caller can show "we
					// tried the in-vault opener but it had no app to launch".
					return {
						handled: false,
						reason: "no-handler",
						message: `no opener for ${uri}`,
						rung: resolution.rung,
					};
				}
				const launched = await this.launchInto(
					appId,
					{ reason: "deep-link", deepLink: uri },
					envelope,
					source,
				);
				return stampRung(launched, resolution.rung);
			}
			case OpenRung.OsHandoff: {
				if (resolution.needsConsent) {
					// OpenRes-1c — first-use interactive prompt. When the
					// prompt host is wired, raise the modal and persist
					// the user's choice; when not wired, fall back to the
					// fail-closed explained refusal (the doc-57 invariant
					// — never silent).
					if (!this.options.promptOsHandoffConsent) {
						return {
							handled: false,
							reason: "no-handler",
							message: `opening ${uri} needs your permission to leave the vault`,
							rung: OpenRung.OsHandoff,
						};
					}
					const decision = await this.options.promptOsHandoffConsent(signature, uri);
					if (decision === OsHandoffPromptDecision.Cancel) {
						return {
							handled: false,
							reason: "no-handler",
							message: `cancelled — ${uri} stays in the vault`,
							rung: OpenRung.OsHandoff,
						};
					}
					if (decision === OsHandoffPromptDecision.Deny) {
						await this.options.recordOsHandoffConsent?.(signature, OsHandoffConsent.Denied);
						return {
							handled: false,
							reason: "no-handler",
							message: `you blocked opening ${uri} (clear in Settings → Privacy)`,
							rung: OpenRung.OsHandoff,
						};
					}
					// Allow — persist the choice so the next attempt
					// skips the prompt, then fall through to the actual
					// handoff below.
					await this.options.recordOsHandoffConsent?.(signature, OsHandoffConsent.Granted);
				}
				return this.executeOsHandoff(target, uri);
			}
			default: {
				// OpenRung.Refused — always explained (doc 57: never a no-op).
				// `refusal` is only defined on the Refused rung; the type
				// guard pins it for the response.
				const refusal =
					resolution.rung === OpenRung.Refused ? resolution.refusal : OpenRefusal.NoHandler;
				const why =
					refusal === OpenRefusal.DangerousScheme
						? `${uri} can't be opened for security reasons`
						: `nothing can open ${uri}`;
				return {
					handled: false,
					reason: "no-handler",
					message: why,
					rung: OpenRung.Refused,
					refusal,
				};
			}
		}
	}

	/**
	 * The OS-handoff egress chokepoint — shared by:
	 *   (a) the post-consent `OsHandoff` rung (first-use Allow, or already-
	 *       granted memory),
	 *   (b) the sentinel-pinned `StoredDefault` rung (user pinned "Open with
	 *       system default" — the pin IS the consent, so skip the prompt).
	 * Both paths stamp `rung: OsHandoff` on the result so the explainer
	 * reads the truth — "Opened with system default" — regardless of which
	 * branch fired.
	 */
	private async executeOsHandoff(
		target: Extract<OpenTarget, { kind: OpenTargetKind.Scheme | OpenTargetKind.File }>,
		uri: string,
	): Promise<IntentDispatchResult> {
		if (!this.options.openExternal) {
			return {
				handled: false,
				reason: "no-handler",
				message: `OS handoff unavailable for ${uri}`,
				rung: OpenRung.OsHandoff,
			};
		}
		const out = await this.options.openExternal(target);
		return out.ok
			? {
					handled: true,
					handler: { appId: SYSTEM_HANDLER_ID },
					rung: OpenRung.OsHandoff,
				}
			: {
					handled: false,
					reason: "handler-error",
					message: out.error ?? `the OS could not open ${uri}`,
					rung: OpenRung.OsHandoff,
				};
	}

	/**
	 * Build the match query, resolving a bare `open` entity id to its
	 * `{ type, mime }` when the caller didn't already supply a type. Only
	 * fills dimensions the payload left blank — an explicit `entityType` in
	 * the payload always wins (the dispatcher knew better).
	 */
	private async resolveQuery(envelope: IntentEnvelope): Promise<IntentQuery> {
		const query = toQuery(envelope);
		if (!this.options.resolveEntityTarget) return query;
		// `open` unions entity-type AND MIME openers, so it resolves whenever
		// either dimension is blank (see below). `quick-look` matches on MIME
		// (Preview's per-MIME rows), so resolve whenever the MIME is still
		// blank even if a type was supplied (Files passes a type but never the
		// MIME). The composer verbs (`reply` / `forward` / `compose`) match on
		// entity type only — a reply dispatched with just the email's entityId
		// resolves to `brainstorm/Email/v1` the same way an id-only open does.
		// Any other verb routes on its raw payload.
		if (envelope.verb === OPEN_VERB) {
			// `open` unions BOTH entity-type and MIME openers, so resolve
			// whenever EITHER dimension is still blank. A file-manager dispatch
			// carries `entityType: File/v1` but never the MIME — and a generic
			// `File/v1` has no content opener of its own (the viewer is keyed by
			// MIME). Short-circuiting on `entityType` alone hid every content
			// viewer, so "Open" on a PDF resolved only to the file manager's own
			// generic opener and dead-ended (same-app no-op).
			if (query.entityType !== undefined && query.mime !== undefined) return query;
		} else if (COMPOSER_VERBS.has(envelope.verb)) {
			if (query.entityType !== undefined) return query;
		} else if (envelope.verb === QUICK_LOOK_VERB) {
			if (query.mime !== undefined) return query;
		} else {
			return query;
		}
		const entityId = stringOrUndefined(envelope.payload.entityId);
		if (!entityId) return query;
		const target = await this.options.resolveEntityTarget(entityId);
		if (!target) return query;
		if (target.type && query.entityType === undefined) query.entityType = target.type;
		if (target.mime && query.mime === undefined) query.mime = target.mime;
		return query;
	}

	/**
	 * Handler candidates for a resolved query. For the `open` verb the
	 * `openers` registry is unioned in (an opener *is* an open handler);
	 * dedupe is by app id — an explicit intent row keeps its label, and the
	 * priority is the stronger of the two sources so an app that declared a
	 * *primary* opener isn't demoted by a secondary intent row. Re-sorted to
	 * the same contract `findHandlers` returns (primary first, then app id).
	 */
	private candidatesFor(query: IntentQuery): IntentRecord[] {
		const handlers = this.options.intents.findHandlers(query);
		if (query.verb !== OPEN_VERB) return handlers;

		const byApp = new Map<string, IntentRecord>();
		for (const h of handlers) byApp.set(h.appId, h);
		for (const opener of this.openerHandlers(query)) {
			const existing = byApp.get(opener.appId);
			if (!existing) {
				byApp.set(opener.appId, opener);
			} else if (existing.priority !== "primary" && opener.priority === "primary") {
				byApp.set(opener.appId, { ...existing, priority: "primary" });
			}
		}
		const merged = [...byApp.values()].sort(
			(a, b) =>
				(a.priority === "primary" ? 0 : 1) - (b.priority === "primary" ? 0 : 1) ||
				a.appId.localeCompare(b.appId),
		);
		if (merged.length > 0) return merged;
		// doc-31 §Resolution fallback renderer: a real typed entity that no
		// app claims still opens — in the generic-object editor (Notes)
		// rather than silently nowhere. Gated on a resolved `entityType` so
		// a malformed/blank `open` stays a no-handler (and the dispatcher
		// gets the structured failure) instead of always launching Notes.
		const fallbackAppId = this.options.genericEntityViewerAppId;
		if (!fallbackAppId || query.entityType === undefined) return merged;
		return [syntheticHandler(fallbackAppId, query)];
	}

	private openerHandlers(query: IntentQuery): IntentRecord[] {
		const openers = this.options.openers;
		if (!openers) return [];
		const rows: OpenerRecord[] = [];
		if (query.entityType !== undefined) {
			rows.push(...openers.listForTarget(OpenerTargetKind.EntityType, query.entityType));
		}
		if (query.mime !== undefined) {
			rows.push(...openers.listForTarget(OpenerTargetKind.Mime, query.mime));
		}
		return rows.map((r) => ({
			appId: r.appId,
			verb: OPEN_VERB,
			entityType: r.targetKind === OpenerTargetKind.EntityType ? r.target : null,
			mime: r.targetKind === OpenerTargetKind.Mime ? r.target : null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: r.kind,
			registeredAt: 0,
			icon: null,
			actionGroup: null,
		}));
	}
}

function toQuery(envelope: IntentEnvelope): IntentQuery {
	const payload = envelope.payload;
	const query: IntentQuery = {
		verb: envelope.verb,
	};
	const entityType = stringOrUndefined(payload.entityType);
	if (entityType !== undefined) query.entityType = entityType;
	const mime = stringOrUndefined(payload.mime);
	if (mime !== undefined) query.mime = mime;
	const format = stringOrUndefined(payload.format);
	if (format !== undefined) query.format = format;
	const kind = stringOrUndefined(payload.kind);
	if (kind !== undefined) query.kind = kind;
	const blockId = stringOrUndefined(payload.blockId);
	if (blockId !== undefined) query.blockId = blockId;
	return query;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read the navigation mode an app stamped onto the open payload (via
 *  `openEntity({ mode })`). Defaults to Replace — an app that doesn't pass a
 *  mode (or any non-navigation verb) keeps the in-place behavior. */
function navModeFromPayload(payload: Record<string, unknown>): NavigationMode {
	const raw = payload.navMode;
	if (raw === NavigationMode.NewTab) return NavigationMode.NewTab;
	if (raw === NavigationMode.NewWindow) return NavigationMode.NewWindow;
	return NavigationMode.Replace;
}

/**
 * Handler selection. Precedence:
 *   1. A user-set default for this (verb, type) — the Settings → Defaults
 *  override (§Default handlers). It wins over everything,
 *      including a same-app dispatch, but only when that app actually
 *      claims the (verb, type) — a stale override (app uninstalled, no
 *      longer a handler) is ignored so navigation never dead-ends.
 *   2. Same-app — an in-app dispatch lands back in the same app rather
 *      than ping-ponging to a sibling.
 *   3. Primary priority, then first-installed within a band.
 */
function pickHandler(
	handlers: readonly IntentRecord[],
	source: { app: string },
	overrideAppId?: string | null,
): IntentRecord {
	if (overrideAppId) {
		const preferred = handlers.find((h) => h.appId === overrideAppId);
		if (preferred) return preferred;
	}
	const sameApp = handlers.find((h) => h.appId === source.app);
	// Same-app keeps a dispatch in the app it came from — EXCEPT when the
	// source's only claim is a *secondary, generic* entity-type opener (the
	// "reveal in <file manager>" opener every app registers for `File/v1`)
	// and another app claims the target by its specific MIME. That's "Open a
	// file from the file manager": the user wants the content viewer
	// (Preview/Books), not to re-focus the file manager (a no-op). A primary
	// home-app opener (Notes for Note/v1, Books for Book/v1) still wins — it's
	// not generic, so it's never deferred. When we defer, drop the source's
	// opener from the pool so the fallback can't re-pick it.
	const deferSameApp =
		sameApp !== undefined &&
		sameApp.priority !== "primary" &&
		sameApp.mime === null &&
		handlers.some((h) => h.appId !== source.app && h.mime !== null);
	if (sameApp && !deferSameApp) return sameApp;
	const pool = deferSameApp ? handlers.filter((h) => h.appId !== source.app) : handlers;
	const primary = pool.find((h) => h.priority === "primary");
	const chosen = primary ?? pool[0];
	if (!chosen) {
		throw new Error("pickHandler: no handlers (caller must check length > 0)");
	}
	return chosen;
}

/** A handler record that doesn't come from the intents/openers registry —
 *  the generic-editor fallback and an explicit Settings → Defaults
 *  override both synthesise one so `pickHandler` can select it uniformly.
 *  `registeredAt: 0` keeps it last in any installed-order tiebreak. */
function syntheticHandler(appId: string, query: IntentQuery): IntentRecord {
	return {
		appId,
		verb: query.verb,
		entityType: query.entityType ?? null,
		mime: query.mime ?? null,
		format: null,
		kind: null,
		blockId: null,
		label: null,
		priority: "secondary",
		registeredAt: 0,
		icon: null,
		actionGroup: null,
	};
}

function launchContextFor(envelope: IntentEnvelope, sourceApp: string): LaunchContext | null {
	// Mailbox-4 + the action surface (doc 63) — the composer verbs and the
	// contributed-action verbs ride the launch context so a freshly-launched
	// handler receives the full payload (a running window gets the `app:intent`
	// push from `launchInto` instead). This is the generic delivery channel the
	// contribution dispatch relies on (the contributor handles the intent in its
	// own sandbox, under its own caps — doc 63 §Security).
	if (COMPOSER_VERBS.has(envelope.verb) || ACTION_SURFACE_VERBS.has(envelope.verb)) {
		return {
			reason: "intent",
			intent: {
				verb: envelope.verb as Intent["verb"],
				payload: envelope.payload,
				source: sourceApp,
			},
		};
	}
	if (envelope.verb !== OPEN_VERB && envelope.verb !== QUICK_LOOK_VERB) return null;
	const entityId = stringOrUndefined(envelope.payload.entityId);
	if (entityId) return { reason: "open-entity", entityId };
	const deepLink = stringOrUndefined(envelope.payload.deepLink);
	if (deepLink) return { reason: "deep-link", deepLink };
	return { reason: "fresh" };
}
