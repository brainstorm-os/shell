/**
 * Connector contracts (`brainstorm/Connector|ConnectorAccount|SyncMapping|SyncRun/v1`)
 * per.
 *
 * One signed bridge-app contract + one shell-side OAuth / credential /
 * sync broker turns any external system (Gmail, GitHub, Slack, an
 * internal API) into a sandboxed, capability-scoped connector that
 * mirrors external resources into vault entities and exposes intents.
 * The four canonical types frozen here are the data the shell-side OAuth
 * broker (Connector-2), the `connectors.request` egress proxy
 * (Connector-3), and the sync engine (Connector-4) interpret.
 *
 * **Contract-freeze scope (Connector-1).** Shapes + enums + structural
 * validators + the security keystone: the *custody / egress invariant*
 * (doc 56 §The custody invariant). A connector never holds the OAuth
 * client secret or token, and its network egress is its declared origin
 * set only — `network.connect:*` is rejected. The keystone derives a
 * connector's required capability set from its frozen origins + the
 * entity types it writes, and answers `isEgressAllowed` fail-closed.
 *
 * Near-leaf: only the `enum-guard` leaf is imported, so this barrel
 * re-exports with no cycle. Capability strings are parsed locally (a
 * three-line mirror of the shell ledger's `parseCapability`, doc 09
 * §Capabilities) and host patterns matched locally (a mirror of the
 * shell's `main/network/host-patterns.ts`) to keep this a dependency-free
 * contract leaf — sdk-types cannot import from `@brainstorm-os/shell`.
 */

import { enumGuard } from "./enum-guard";

export const CONNECTOR_TYPE_URL = "brainstorm/Connector/v1";
export const CONNECTOR_ACCOUNT_TYPE_URL = "brainstorm/ConnectorAccount/v1";
export const SYNC_MAPPING_TYPE_URL = "brainstorm/SyncMapping/v1";
export const SYNC_RUN_TYPE_URL = "brainstorm/SyncRun/v1";

/** Local alias for an entity id — a plain `string` here (rather than the
 *  `index.ts` `EntityId` alias) so this contract leaf stays
 *  dependency-free and introduces no barrel cycle. */
type ConnectorEntityId = string;

// ───────────────────────────── enums ─────────────────────────────

/** Per-mapping sync direction (doc 56 §`SyncMapping/v1`). The engine
 *  spine (Connector-4) shipped `pull`; Connector-5 added `push`/`two-way`
 *  (OQ-CN-3 v1: content-based change detection + last-writer-wins with a
 *  per-mapping prefer-local/prefer-remote override). */
export enum SyncDirection {
	Pull = "pull",
	Push = "push",
	TwoWay = "two-way",
}

export const SYNC_DIRECTIONS = Object.freeze([
	SyncDirection.Pull,
	SyncDirection.Push,
	SyncDirection.TwoWay,
]) as readonly SyncDirection[];

/** The directions the sync engine interprets (Connector-4 `pull`,
 *  Connector-5 `push`/`two-way`). */
export const ENGINE_SYNC_DIRECTIONS = Object.freeze([
	SyncDirection.Pull,
	SyncDirection.Push,
	SyncDirection.TwoWay,
]) as readonly SyncDirection[];

/** Conflict resolution when both sides changed (doc 56). Default
 *  `external-wins` for `pull`. */
export enum ConflictPolicy {
	ExternalWins = "external-wins",
	VaultWins = "vault-wins",
	TwoWayMerge = "two-way-merge",
}

export const CONFLICT_POLICIES = Object.freeze([
	ConflictPolicy.ExternalWins,
	ConflictPolicy.VaultWins,
	ConflictPolicy.TwoWayMerge,
]) as readonly ConflictPolicy[];

/** An account's auth lifecycle (doc 56 §`ConnectorAccount/v1`). Revoking
 *  deletes the Tier-2 token and flips to `revoked`; a failed shell-side
 *  refresh flips to `expired` (OQ-CN-4). */
export enum AuthState {
	Active = "active",
	Expired = "expired",
	Revoked = "revoked",
}

export const AUTH_STATES = Object.freeze([
	AuthState.Active,
	AuthState.Expired,
	AuthState.Revoked,
]) as readonly AuthState[];

/** A sync execution's lifecycle (doc 56 §`SyncRun/v1`, mirrors
 *  `WorkflowRunStatus`). */
export enum SyncRunStatus {
	Queued = "queued",
	Running = "running",
	Succeeded = "succeeded",
	Failed = "failed",
	Cancelled = "cancelled",
}

export const SYNC_RUN_STATUSES = Object.freeze([
	SyncRunStatus.Queued,
	SyncRunStatus.Running,
	SyncRunStatus.Succeeded,
	SyncRunStatus.Failed,
	SyncRunStatus.Cancelled,
]) as readonly SyncRunStatus[];

/** A run is finished (no further state transitions). */
export const TERMINAL_SYNC_RUN_STATUSES = Object.freeze(
	new Set<SyncRunStatus>([SyncRunStatus.Succeeded, SyncRunStatus.Failed, SyncRunStatus.Cancelled]),
);

export const isSyncDirection = enumGuard(SYNC_DIRECTIONS);
export const isConflictPolicy = enumGuard(CONFLICT_POLICIES);
export const isAuthState = enumGuard(AUTH_STATES);
export const isSyncRunStatus = enumGuard(SYNC_RUN_STATUSES);

// ──────────────────────── entity payloads ────────────────────────

/** `brainstorm/Connector/v1` — an installed connector configuration (the
 *  app provides the code; this is the user's instance of it). The
 *  `egressOrigins` are frozen from the manifest and shown read-only. */
export type ConnectorDef = {
	connectorAppId: string;
	displayName: string;
	enabled: boolean;
	/** The exact hosts the broker permits egress to (`api.github.com`,
	 *  `*.slack.com`). `*` / `network.connect:*` is rejected at validation. */
	egressOrigins: string[];
	/** The connector's API base URL — `connectors.request` resolves
	 *  relative paths against it; it must be inside `egressOrigins`. */
	apiBaseUrl: string;
	/** Default seconds between scheduled syncs (a `SyncMapping` registers a
	 *  `Time` trigger at this interval). */
	defaultSyncInterval: number;
};

/** `brainstorm/ConnectorAccount/v1` — one authenticated account on a
 *  connector. **Holds no secret** — the token lives in Tier 2 keyed by
 *  this entity's id (doc 29). This row holds only the non-secret
 *  bookkeeping. */
export type ConnectorAccountDef = {
	connectorRef: ConnectorEntityId;
	externalAccountLabel: string;
	scopesGranted: string[];
	authState: AuthState;
	lastAuthAt?: string;
};

/** `brainstorm/SyncMapping/v1` — how an external resource type maps to a
 *  vault entity type (doc 56 §`SyncMapping/v1`). */
export type SyncMappingDef = {
	accountRef: ConnectorEntityId;
	/** e.g. `github:issue`, `gcal:event`, `slack:message`. */
	externalKind: string;
	/** The canonical vault type it projects to (`brainstorm/Task/v1`, …) —
	 *  never a connector-specific type (doc 56 §single object space). */
	entityType: string;
	/** External field → property map; connector-declared, user-overridable
	 *  later (OQ-CN-1 resolved: default ships in the manifest). */
	fieldMap: Record<string, unknown>;
	direction: SyncDirection;
	conflictPolicy: ConflictPolicy;
	/** Selective-sync bound (doc 20), e.g. "issues assigned to me, open". */
	filter?: Record<string, unknown>;
	/** Delta cursor (ETag / `updated_since` / webhook checkpoint); persists
	 *  so a restart resumes. */
	cursor?: Record<string, unknown>;
};

/** `brainstorm/SyncRun/v1` — one sync execution (mirrors
 *  `WorkflowRun/v1`). Auto-pruned (default 90 days). */
export type SyncRunDef = {
	mappingRef: ConnectorEntityId;
	startedAt: string;
	finishedAt?: string;
	status: SyncRunStatus;
	pulled: number;
	pushed: number;
	conflicts: number;
	error?: string;
	costNote?: string;
};

// ──────────────────────── volume budgets ────────────────────────
//
// doc 56 §Performance budgets: max active SyncMapping per vault.

/** Past this, the save path warns (doc 56: 200 soft). */
export const MAX_SYNC_MAPPINGS_SOFT = 200;
/** Past this, the save path rejects (doc 56: 2000 hard). */
export const MAX_SYNC_MAPPINGS_HARD = 2000;

// ─────────────────── custody / egress keystone ───────────────────
//
// The security-critical core of the connector framework (doc 56 §The
// custody invariant). Two invariants, enforced fail-closed:
//   1. A connector's egress is its declared origin set ONLY; `*` is
//      rejected. `isEgressAllowed` is the authoritative checkpoint the
//      shell's `connectors.request` runs on every outbound URL.
//   2. A connector's capability footprint is exactly derivable from its
//      frozen origins + the entity types it writes — the user reviews
//      that aggregate at install (`connectorRequiredCapabilities`).

/** `<service>.<verb>[:<scope>]` → its parts. Local mirror of the shell
 *  ledger's `parseCapability` (doc 09) to keep this leaf dependency-free. */
function parseCapability(cap: string): { capability: string; scope: string | null } {
	const colon = cap.indexOf(":");
	if (colon < 0) return { capability: cap, scope: null };
	return { capability: cap.slice(0, colon), scope: cap.slice(colon + 1) };
}

/** A parsed origin pattern. `port === null` means "the scheme default". */
type OriginPattern = { scheme: string; host: string; port: number | null };

/** The default TCP port for a scheme, or null for an unknown scheme. */
function defaultPort(scheme: string): number | null {
	if (scheme === "https") return 443;
	if (scheme === "http") return 80;
	return null;
}

/** Parse an origin pattern (`https://api.github.com`, `*.slack.com`,
 *  `api.github.com:8443`) into `{scheme, host, port}`. A bare host gets
 *  the `https` default scheme. Returns null if unparseable. */
export function parseOriginPattern(raw: string): OriginPattern | null {
	let s = raw.trim().toLowerCase();
	if (s.length === 0) return null;
	let scheme = "https";
	const schemeSep = s.indexOf("://");
	if (schemeSep >= 0) {
		scheme = s.slice(0, schemeSep);
		s = s.slice(schemeSep + 3);
		if (scheme.length === 0) return null;
	}
	// Strip any path / query the author left on the origin.
	const slash = s.indexOf("/");
	if (slash >= 0) s = s.slice(0, slash);
	if (s.length === 0) return null;
	let port: number | null = null;
	const colon = s.lastIndexOf(":");
	if (colon >= 0) {
		const portStr = s.slice(colon + 1);
		s = s.slice(0, colon);
		if (!/^[0-9]+$/.test(portStr)) return null;
		const n = Number(portStr);
		if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
		port = n;
	}
	if (s.length === 0) return null;
	return { scheme, host: s, port };
}

/** Does `host` match an origin pattern's host? Exact, or `*.suffix`
 *  (subdomains only, NOT the apex). Mirrors `main/network/host-patterns.ts`
 *  intentionally minus the `.suffix`/CIDR forms — a connector manifest
 *  lists exact hosts or a single subdomain wildcard, nothing broader. */
function hostMatchesPattern(host: string, pattern: string): boolean {
	const h = host.trim().toLowerCase();
	const p = pattern.trim().toLowerCase();
	if (p.startsWith("*.")) {
		const suffix = p.slice(1); // ".slack.com"
		return h.endsWith(suffix) && h.length > suffix.length;
	}
	return h === p;
}

/** Is this origin / capability scope the rejected catch-all? A connector
 *  may not request arbitrary egress (doc 56) — `*`, `*://*`, a bare `*`
 *  host, or a `*` capability scope are all refused. */
export function isWildcardAll(value: string): boolean {
	const v = value.trim().toLowerCase();
	if (v === "*" || v === "*://*" || v === "*:*") return true;
	const parsed = parseOriginPattern(v);
	if (parsed && parsed.host === "*") return true;
	return false;
}

/**
 * Is `url` within the connector's frozen `egressOrigins`? The
 * authoritative checkpoint `connectors.request` runs before every
 * outbound call. Fail-closed: an unparseable URL, a wildcard-all origin,
 * or no match → `false`. Scheme + host + (scheme-default-aware) port must
 * all match a frozen origin.
 */
export function isEgressAllowed(frozenOrigins: readonly string[], url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
	const host = parsed.hostname.toLowerCase();
	const urlPort = parsed.port.length > 0 ? Number(parsed.port) : defaultPort(scheme);
	for (const raw of frozenOrigins) {
		if (isWildcardAll(raw)) continue; // never honored — rejected at validation
		const pattern = parseOriginPattern(raw);
		if (!pattern) continue;
		if (pattern.scheme !== scheme) continue;
		if (!hostMatchesPattern(host, pattern.host)) continue;
		const patternPort = pattern.port ?? defaultPort(scheme);
		if (patternPort !== urlPort) continue;
		return true;
	}
	return false;
}

/** Why an egress request was refused — surfaced in the audit log so a
 *  Denied request is never silent (doc 56). */
export enum EgressRefusalReason {
	Unparseable = "unparseable-url",
	WildcardOrigin = "wildcard-origin-rejected",
	OutOfScope = "out-of-frozen-origin-set",
}

export type EgressDecision = { allowed: true } | { allowed: false; reason: EgressRefusalReason };

/**
 * The fail-closed decision `connectors.request` (Connector-3) and the
 * OAuth token-exchange bootstrap (Connector-2) run on a candidate URL.
 * Returns a typed reason on refusal so the caller logs the refusal rather
 * than failing silently.
 */
export function validateConnectorRequest(
	frozenOrigins: readonly string[],
	url: string,
): EgressDecision {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { allowed: false, reason: EgressRefusalReason.Unparseable };
	}
	void parsed;
	if (frozenOrigins.some((o) => isWildcardAll(o))) {
		// A connector that declared `*` is invalid; refuse rather than honor it.
		return { allowed: false, reason: EgressRefusalReason.WildcardOrigin };
	}
	if (!isEgressAllowed(frozenOrigins, url)) {
		return { allowed: false, reason: EgressRefusalReason.OutOfScope };
	}
	return { allowed: true };
}

/** A `network.connect:<origin>` capability per frozen origin (never `*`),
 *  deterministically sorted. Wildcard-all origins are dropped (they are a
 *  validation error, not a grantable scope). */
export function connectorEgressCapabilities(egressOrigins: readonly string[]): string[] {
	const caps = new Set<string>();
	for (const raw of egressOrigins) {
		if (isWildcardAll(raw)) continue;
		const pattern = parseOriginPattern(raw);
		if (!pattern) continue;
		const port = pattern.port === null ? "" : `:${pattern.port}`;
		caps.add(`network.connect:${pattern.scheme}://${pattern.host}${port}`);
	}
	return [...caps].sort();
}

/**
 * The aggregate capability set a connector needs — the union the user
 * reviews and grants at install (doc 56 §Trust & distribution): a
 * `network.connect:<origin>` per frozen origin plus an `entities.write:<type>`
 * per entity type it writes. Deterministically sorted for a stable
 * capability sheet; mirrors `aggregateWorkflowCapabilities`.
 */
export function connectorRequiredCapabilities(input: {
	egressOrigins: readonly string[];
	entityTypes?: readonly string[];
}): string[] {
	const caps = new Set<string>(connectorEgressCapabilities(input.egressOrigins));
	for (const type of input.entityTypes ?? []) {
		if (type.trim().length > 0) caps.add(`entities.write:${type}`);
	}
	return [...caps].sort();
}

/** Does a `held` grant satisfy a `requested` capability? Mirrors the
 *  ledger scope rule (doc 09): same `service.verb`, and either an exact
 *  scope, a `*` wildcard grant, or both unscoped. */
export function capabilityImplies(held: string, requested: string): boolean {
	const h = parseCapability(held);
	const r = parseCapability(requested);
	if (h.capability !== r.capability) return false;
	if (r.scope === null) return h.scope === null;
	return h.scope === r.scope || h.scope === "*";
}

// ──────────────────────────── validators ────────────────────────────
//
// Structural validation only — non-blank required fields, known enum
// members, no wildcard egress, no embedded secret. Does NOT recurse into
// referenced entities (the broker/runner's concern). Each returns a list
// of stable issue codes so callers can localise.

export enum ConnectorIssueCode {
	EmptyConnectorAppId = "empty-connector-app-id",
	EmptyDisplayName = "empty-display-name",
	EmptyEgressOrigins = "empty-egress-origins",
	WildcardEgressOrigin = "wildcard-egress-origin",
	InvalidEgressOrigin = "invalid-egress-origin",
	ApiBaseUrlOutOfScope = "api-base-url-out-of-scope",
	InvalidSyncInterval = "invalid-sync-interval",
	MissingConnectorRef = "missing-connector-ref",
	InvalidAuthState = "invalid-auth-state",
	EmbeddedSecret = "embedded-secret",
	MissingAccountRef = "missing-account-ref",
	EmptyExternalKind = "empty-external-kind",
	EmptyEntityType = "empty-entity-type",
	InvalidDirection = "invalid-direction",
	InvalidConflictPolicy = "invalid-conflict-policy",
	MissingMappingRef = "missing-mapping-ref",
	InvalidRunStatus = "invalid-run-status",
}

export type ConnectorIssue = { code: ConnectorIssueCode; message: string };

function isBlank(v: unknown): boolean {
	return typeof v !== "string" || v.trim().length === 0;
}

/** Keys whose presence on an account def signals a leaked secret — the
 *  custody invariant says the token lives in Tier 2, never on the entity. */
const SECRET_KEY_PATTERN =
	/(token|secret|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key)/i;

export function validateConnector(def: ConnectorDef): ConnectorIssue[] {
	const issues: ConnectorIssue[] = [];
	if (isBlank(def.connectorAppId)) {
		issues.push({
			code: ConnectorIssueCode.EmptyConnectorAppId,
			message: "Connector has no app id.",
		});
	}
	if (isBlank(def.displayName)) {
		issues.push({
			code: ConnectorIssueCode.EmptyDisplayName,
			message: "Connector has no display name.",
		});
	}
	if (!Array.isArray(def.egressOrigins) || def.egressOrigins.length === 0) {
		issues.push({
			code: ConnectorIssueCode.EmptyEgressOrigins,
			message: "Connector declares no egress origins.",
		});
	} else {
		for (const origin of def.egressOrigins) {
			if (isWildcardAll(origin)) {
				issues.push({
					code: ConnectorIssueCode.WildcardEgressOrigin,
					message: `Connector requests wildcard egress "${origin}" — rejected.`,
				});
			} else if (!parseOriginPattern(origin)) {
				issues.push({
					code: ConnectorIssueCode.InvalidEgressOrigin,
					message: `Connector egress origin "${origin}" is not a valid host pattern.`,
				});
			}
		}
	}
	if (
		!isBlank(def.apiBaseUrl) &&
		Array.isArray(def.egressOrigins) &&
		!isEgressAllowed(def.egressOrigins, def.apiBaseUrl)
	) {
		issues.push({
			code: ConnectorIssueCode.ApiBaseUrlOutOfScope,
			message: `apiBaseUrl "${def.apiBaseUrl}" is outside the declared egress origins.`,
		});
	}
	if (
		typeof def.defaultSyncInterval !== "number" ||
		!Number.isFinite(def.defaultSyncInterval) ||
		def.defaultSyncInterval <= 0
	) {
		issues.push({
			code: ConnectorIssueCode.InvalidSyncInterval,
			message: "Connector defaultSyncInterval must be a positive number of seconds.",
		});
	}
	return issues;
}

export function validateConnectorAccount(def: ConnectorAccountDef): ConnectorIssue[] {
	const issues: ConnectorIssue[] = [];
	if (isBlank(def.connectorRef)) {
		issues.push({
			code: ConnectorIssueCode.MissingConnectorRef,
			message: "Account has no connector reference.",
		});
	}
	if (!isAuthState(def.authState)) {
		issues.push({
			code: ConnectorIssueCode.InvalidAuthState,
			message: `Unknown auth state "${String(def.authState)}".`,
		});
	}
	// Custody invariant as a structural test: no token-shaped key may live
	// on the account entity (it belongs in Tier 2, doc 29).
	for (const key of Object.keys(def as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			issues.push({
				code: ConnectorIssueCode.EmbeddedSecret,
				message: `Account entity carries a secret-shaped field "${key}" — tokens belong in Tier 2.`,
			});
		}
	}
	return issues;
}

export function validateSyncMapping(def: SyncMappingDef): ConnectorIssue[] {
	const issues: ConnectorIssue[] = [];
	if (isBlank(def.accountRef)) {
		issues.push({
			code: ConnectorIssueCode.MissingAccountRef,
			message: "Mapping has no account reference.",
		});
	}
	if (isBlank(def.externalKind)) {
		issues.push({
			code: ConnectorIssueCode.EmptyExternalKind,
			message: "Mapping has no external kind.",
		});
	}
	if (isBlank(def.entityType)) {
		issues.push({
			code: ConnectorIssueCode.EmptyEntityType,
			message: "Mapping has no entity type.",
		});
	}
	if (!isSyncDirection(def.direction)) {
		issues.push({
			code: ConnectorIssueCode.InvalidDirection,
			message: `Unknown sync direction "${String(def.direction)}".`,
		});
	}
	if (!isConflictPolicy(def.conflictPolicy)) {
		issues.push({
			code: ConnectorIssueCode.InvalidConflictPolicy,
			message: `Unknown conflict policy "${String(def.conflictPolicy)}".`,
		});
	}
	return issues;
}

export function validateSyncRun(def: SyncRunDef): ConnectorIssue[] {
	const issues: ConnectorIssue[] = [];
	if (isBlank(def.mappingRef)) {
		issues.push({
			code: ConnectorIssueCode.MissingMappingRef,
			message: "Run has no mapping reference.",
		});
	}
	if (!isSyncRunStatus(def.status)) {
		issues.push({
			code: ConnectorIssueCode.InvalidRunStatus,
			message: `Unknown run status "${String(def.status)}".`,
		});
	}
	return issues;
}

export const isValidConnector = (def: ConnectorDef): boolean => validateConnector(def).length === 0;
export const isValidConnectorAccount = (def: ConnectorAccountDef): boolean =>
	validateConnectorAccount(def).length === 0;
export const isValidSyncMapping = (def: SyncMappingDef): boolean =>
	validateSyncMapping(def).length === 0;
export const isValidSyncRun = (def: SyncRunDef): boolean => validateSyncRun(def).length === 0;
