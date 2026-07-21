/**
 * Connector-4/5 — the sync engine (`SyncRunner`).
 *
 * Pulls external resources for one `SyncMapping` and projects them into
 * the single object space as canonical entities (a `github:issue` becomes
 * a `Task/v1`), idempotent on a stable external id (doc 56 §Sync model;
 * reuses the doc 20 initial/selective/incremental + cursor model). The
 * analogue of `WorkflowRunner` — pure-ish, every IO injected, so the
 * spine is unit-tested and the in-process pipeline test drives it
 * end-to-end.
 *
 * Idempotency: each resource carries a stable external id; the projection
 * UPSERTS on a FLAT indexed dedupe key (`connectorExternalId`) so a re-run
 * never duplicates (the highest-risk invariant — the pipeline test pins
 * it). Richer provenance rides a separate `connector.source` block.
 *
 * Connector-5 — push / two-way (OQ-CN-3 v1 position): local changes are
 * detected CONTENT-BASED, not clock-based — `connector.source.pushedState`
 * records the stable-serialized outbound payload at the last sync point;
 * an entity pushes when its current outbound payload differs. This makes
 * the loop echo-free (a push's own bookkeeping write, and the provider
 * echoing the pushed values back on the next pull, both leave the state
 * equal) and immune to clock skew. When BOTH sides changed since the last
 * sync point, the per-mapping `conflictPolicy` is the prefer-local /
 * prefer-remote override (`vault-wins` / `external-wins`), and
 * `two-way-merge` resolves v1 as last-writer-wins by timestamp (remote
 * `cursorField` vs the entity's `updatedAt`); richer field-level merge +
 * a queued conflicts view is v2. Push only writes back entities that were
 * mirrored from the provider (they carry the external id) — creating new
 * remote resources from vault-born entities is v2. The first push-enabled
 * run BASELINES (records `pushedState` without writing to the provider)
 * so flipping a pull mapping to two-way never floods the provider.
 */

import {
	ConflictPolicy,
	SyncDirection,
	SyncRunStatus,
	isWildcardAll,
	validateConnectorRequest,
} from "@brainstorm-os/sdk-types";
import { applyFieldMap, readPath } from "./field-map";

/** The flat, indexed property every synced entity carries for the
 *  upsert-on-external-id lookup. Kept bare (not inside an envelope) so the
 *  entities `where` filter compiles to a direct `json_extract` match. */
export const CONNECTOR_EXTERNAL_ID_PROP = "connectorExternalId";
/** The richer provenance block (doc 19 §valueMeta) — round-trip handle. */
export const CONNECTOR_SOURCE_PROP = "connector.source";

/** The `{externalId}` placeholder a push path template carries. */
const EXTERNAL_ID_PLACEHOLDER = "{externalId}";
const DEFAULT_PUSH_METHOD = "PATCH";

/** Declarative pull descriptor the connector ships in its manifest and the
 *  shell engine executes generically — no connector code runs shell-side. */
export type PullSpec = {
	/** Path (resolved against the connector's apiBaseUrl) of the list call. */
	path: string;
	/** Static query params applied on every pull (e.g. ordering/scope). For an
	 *  incremental cursor to be safe the listing must be ordered by the cursor
	 *  field ascending, or out-of-order updates fall outside the cursor window
	 *  and are never re-fetched. */
	query?: Record<string, string>;
	/** Dotted path to the resource array in the JSON response; root if absent. */
	listPath?: string;
	/** Field on each resource holding its stable external id. */
	externalIdField: string;
	/** Query param carrying the incremental cursor (e.g. `since`). */
	cursorParam?: string;
	/** Field on each resource whose max becomes the next cursor (e.g.
	 *  `updated_at`). Also the remote LWW timestamp for `two-way-merge`. */
	cursorField?: string;
};

/** Connector-5 — declarative write-back descriptor: how one locally-changed
 *  mirrored entity returns to the provider. Manifest-shipped, shell-executed
 *  (no connector code runs shell-side), same posture as `PullSpec`. */
export type PushSpec = {
	/** Path template (resolved against apiBaseUrl); `{externalId}` is
	 *  replaced, URL-encoded, per entity. */
	path: string;
	/** HTTP method of the write-back; default `PATCH`. */
	method?: string;
	/** Outbound payload field → entity property path / value-map — the same
	 *  `applyFieldMap` convention as the pull fieldMap, applied to the entity
	 *  properties. */
	fieldMap: Record<string, unknown>;
};

export type ResolvedMapping = {
	mappingId: string;
	accountRef: string;
	externalKind: string;
	entityType: string;
	fieldMap: Record<string, unknown>;
	direction: SyncDirection;
	conflictPolicy: ConflictPolicy;
	pull: PullSpec;
	/** Required for `push` / `two-way` mappings (the runner fails closed
	 *  without it). */
	push?: PushSpec;
	/** Frozen egress origins of the owning connector (for the in-engine
	 *  defense-in-depth scope check). */
	egressOrigins: readonly string[];
	cursor?: Record<string, unknown>;
};

/** An entity row as the push / conflict machinery needs it. */
export type SyncedEntity = {
	id: string;
	properties: Record<string, unknown>;
	/** Epoch ms of the entity's last write — the local LWW timestamp. */
	updatedAt: number;
};

export type SyncRunnerPorts = {
	/** The auth-injected, egress-scoped provider call (→ `connectors.request`
	 *  for this mapping's account). Returns the decoded JSON body. */
	request(input: { method: string; path: string; body?: unknown }): Promise<unknown>;
	/** The entity id whose `connectorExternalId` equals the key, or null. */
	findByExternalId(entityType: string, externalKey: string): Promise<string | null>;
	createEntity(entityType: string, properties: Record<string, unknown>): Promise<{ id: string }>;
	updateEntity(id: string, patch: Record<string, unknown>): Promise<void>;
	/** Full row for two-way conflict detection. Required for `two-way`. */
	getEntity?(id: string): Promise<SyncedEntity | null>;
	/** Mirrored entities of `entityType` whose dedupe key starts with the
	 *  mapping's `<externalKind>:` prefix — the push-phase candidate set.
	 *  Required for `push` / `two-way`. */
	listByExternalIdPrefix?(entityType: string, prefix: string): Promise<SyncedEntity[]>;
	now(): number;
};

export type SyncRunResult = {
	mappingRef: string;
	status: SyncRunStatus;
	startedAt: string;
	finishedAt: string;
	pulled: number;
	pushed: number;
	conflicts: number;
	error?: string;
	/** The advanced cursor to persist on the mapping (absent ⇒ unchanged). */
	nextCursor?: Record<string, unknown>;
};

/** A stable, namespaced dedupe key so two connectors that both emit id `42`
 *  never collide (e.g. `github:issue:42`). */
export function externalKey(externalKind: string, externalId: unknown): string {
	return `${externalKind}:${String(externalId)}`;
}

/** The provenance block a synced entity carries under `connector.source`. */
type ConnectorSource = {
	externalId?: string;
	externalKind?: string;
	accountRef?: string;
	syncedAt?: string;
	/** Connector-5 — the stable-serialized outbound payload at the last sync
	 *  point; the content-based LOCAL-change baseline. */
	pushedState?: string;
	/** Connector-5 — the stable-serialized pulled (mapped) values at the last
	 *  sync point; the content-based REMOTE-change baseline. Without it a
	 *  local edit would be indistinguishable from a remote edit (both make
	 *  the incoming resource differ from the entity). */
	pulledState?: string;
};

/** Deterministic serialization (recursively sorted object keys) so two
 *  structurally-equal payloads always compare equal. */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function sourceOf(properties: Record<string, unknown>): ConnectorSource | null {
	const raw = properties[CONNECTOR_SOURCE_PROP];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	return raw as ConnectorSource;
}

/** The pulled-side sync-point state: the entity's current values of the
 *  pull-mapped properties, serialized deterministically. */
function pulledStateOf(
	fieldMap: Record<string, unknown>,
	properties: Record<string, unknown>,
): string {
	const picked: Record<string, unknown> = {};
	for (const key of Object.keys(fieldMap)) {
		if (properties[key] !== undefined) picked[key] = properties[key];
	}
	return stableStringify(picked);
}

enum ConflictWinner {
	Remote = "remote",
	Local = "local",
}

type PullPhaseResult = {
	pulled: number;
	conflicts: number;
	nextCursor?: Record<string, unknown>;
};

export class SyncRunner {
	constructor(private readonly ports: SyncRunnerPorts) {}

	async run(mapping: ResolvedMapping): Promise<SyncRunResult> {
		const startedAt = new Date(this.ports.now()).toISOString();
		const base: Omit<SyncRunResult, "status" | "finishedAt"> = {
			mappingRef: mapping.mappingId,
			startedAt,
			pulled: 0,
			pushed: 0,
			conflicts: 0,
		};

		const writesBack = mapping.direction !== SyncDirection.Pull;
		if (writesBack && !mapping.push) {
			return {
				...base,
				status: SyncRunStatus.Failed,
				finishedAt: new Date(this.ports.now()).toISOString(),
				error: `push-spec-missing:${mapping.direction}`,
			};
		}
		if (writesBack && !this.ports.listByExternalIdPrefix) {
			return {
				...base,
				status: SyncRunStatus.Failed,
				finishedAt: new Date(this.ports.now()).toISOString(),
				error: "push-ports-missing",
			};
		}

		try {
			let pull: PullPhaseResult = { pulled: 0, conflicts: 0 };
			if (mapping.direction !== SyncDirection.Push) {
				pull = await this.pullPhase(mapping);
			}
			let pushed = 0;
			if (writesBack) {
				pushed = await this.pushPhase(mapping);
			}
			return {
				...base,
				pulled: pull.pulled,
				pushed,
				conflicts: pull.conflicts,
				status: SyncRunStatus.Succeeded,
				finishedAt: new Date(this.ports.now()).toISOString(),
				...(pull.nextCursor ? { nextCursor: pull.nextCursor } : {}),
			};
		} catch (error) {
			return {
				...base,
				status: SyncRunStatus.Failed,
				finishedAt: new Date(this.ports.now()).toISOString(),
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async pullPhase(mapping: ResolvedMapping): Promise<PullPhaseResult> {
		const path = this.buildPath(mapping);
		const body = await this.ports.request({ method: "GET", path });
		const resources = this.extractList(body, mapping.pull.listPath);

		let pulled = 0;
		let conflicts = 0;
		let nextCursorValue: string | undefined;
		for (const resource of resources) {
			const externalId = readPath(resource, mapping.pull.externalIdField);
			if (externalId === undefined) continue;
			const key = externalKey(mapping.externalKind, externalId);
			const mapped = applyFieldMap(mapping.fieldMap, resource);
			const properties: Record<string, unknown> = { ...mapped };
			properties[CONNECTOR_EXTERNAL_ID_PROP] = key;
			properties[CONNECTOR_SOURCE_PROP] = {
				externalId: String(externalId),
				externalKind: mapping.externalKind,
				accountRef: mapping.accountRef,
				syncedAt: new Date(this.ports.now()).toISOString(),
			};
			conflicts += await this.upsert(mapping, key, properties, mapped, resource);
			pulled += 1;
			if (mapping.pull.cursorField) {
				const cursorVal = readPath(resource, mapping.pull.cursorField);
				if (typeof cursorVal === "string" && (!nextCursorValue || cursorVal > nextCursorValue)) {
					nextCursorValue = cursorVal;
				}
			}
		}

		const out: PullPhaseResult = { pulled, conflicts };
		if (mapping.pull.cursorParam && nextCursorValue) {
			out.nextCursor = { [mapping.pull.cursorParam]: nextCursorValue };
		}
		return out;
	}

	/** Upsert one pulled resource. Returns the number of conflicts it hit
	 *  (0 or 1). `pull` keeps the Connector-4 semantics exactly: an existing
	 *  entity is overwritten (`external-wins`) or left alone (`vault-wins`);
	 *  `two-way` adds content-based both-sides-changed detection. */
	private async upsert(
		mapping: ResolvedMapping,
		key: string,
		properties: Record<string, unknown>,
		mapped: Record<string, unknown>,
		resource: unknown,
	): Promise<number> {
		const existingId = await this.ports.findByExternalId(mapping.entityType, key);
		if (!existingId) {
			if (mapping.push && mapping.direction !== SyncDirection.Pull) {
				const source = properties[CONNECTOR_SOURCE_PROP] as ConnectorSource;
				source.pushedState = stableStringify(applyFieldMap(mapping.push.fieldMap, properties));
				source.pulledState = pulledStateOf(mapping.fieldMap, properties);
			}
			await this.ports.createEntity(mapping.entityType, properties);
			return 0;
		}

		if (mapping.direction !== SyncDirection.TwoWay) {
			if (mapping.conflictPolicy === ConflictPolicy.VaultWins) return 0;
			await this.ports.updateEntity(existingId, properties);
			return 0;
		}

		return await this.twoWayApply(mapping, existingId, properties, mapped, resource);
	}

	private async twoWayApply(
		mapping: ResolvedMapping,
		existingId: string,
		properties: Record<string, unknown>,
		mapped: Record<string, unknown>,
		resource: unknown,
	): Promise<number> {
		if (!this.ports.getEntity) throw new Error("push-ports-missing");
		const existing = await this.ports.getEntity(existingId);
		if (!existing) {
			await this.ports.updateEntity(existingId, properties);
			return 0;
		}

		const source = sourceOf(existing.properties);
		const incomingPulledState = pulledStateOf(mapping.fieldMap, mapped);
		// Pre-baseline (a mapping just flipped from pull) the last-pulled state
		// is unknown; compare against the entity's current mapped values as a
		// best effort until the push phase stamps the baselines.
		const remoteBaseline =
			source?.pulledState ?? pulledStateOf(mapping.fieldMap, existing.properties);
		const remoteChanged = incomingPulledState !== remoteBaseline;
		const pushSpec = mapping.push;
		const localChanged =
			pushSpec !== undefined &&
			source?.pushedState !== undefined &&
			stableStringify(applyFieldMap(pushSpec.fieldMap, existing.properties)) !== source.pushedState;

		if (!remoteChanged) return 0; // local-only changes are the push phase's job

		let conflict = 0;
		let winner = ConflictWinner.Remote;
		if (localChanged) {
			conflict = 1;
			winner = this.resolveConflictWinner(mapping, resource, existing.updatedAt);
		}
		if (winner === ConflictWinner.Remote) {
			if (pushSpec) {
				const merged = { ...existing.properties, ...properties };
				const sourceOut = properties[CONNECTOR_SOURCE_PROP] as ConnectorSource;
				sourceOut.pushedState = stableStringify(applyFieldMap(pushSpec.fieldMap, merged));
				sourceOut.pulledState = incomingPulledState;
			}
			await this.ports.updateEntity(existingId, properties);
		}
		// winner === local: keep the vault values; the push phase sends them.
		return conflict;
	}

	/** OQ-CN-3 (v1 position): the per-mapping policy is a prefer-local /
	 *  prefer-remote override; `two-way-merge` resolves as last-writer-wins
	 *  by timestamp. An unknown remote timestamp resolves remote
	 *  (deterministic, matches the pull default). Richer merge is v2. */
	private resolveConflictWinner(
		mapping: ResolvedMapping,
		resource: unknown,
		localUpdatedAt: number,
	): ConflictWinner {
		switch (mapping.conflictPolicy) {
			case ConflictPolicy.ExternalWins:
				return ConflictWinner.Remote;
			case ConflictPolicy.VaultWins:
				return ConflictWinner.Local;
			case ConflictPolicy.TwoWayMerge: {
				const field = mapping.pull.cursorField;
				const raw = field ? readPath(resource, field) : undefined;
				const remoteTs = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
				if (Number.isNaN(remoteTs)) return ConflictWinner.Remote;
				return remoteTs >= localUpdatedAt ? ConflictWinner.Remote : ConflictWinner.Local;
			}
		}
	}

	private async pushPhase(mapping: ResolvedMapping): Promise<number> {
		const spec = mapping.push;
		const list = this.ports.listByExternalIdPrefix;
		if (!spec || !list) throw new Error("push-ports-missing");
		const rows = await list(mapping.entityType, `${mapping.externalKind}:`);

		let pushed = 0;
		for (const row of rows) {
			const source = sourceOf(row.properties);
			if (!source || source.accountRef !== mapping.accountRef) continue;
			if (!source.externalId) continue;
			const payload = applyFieldMap(spec.fieldMap, row.properties);
			const state = stableStringify(payload);
			const pulledState = pulledStateOf(mapping.fieldMap, row.properties);
			if (source.pushedState === undefined) {
				// Baseline run: record the sync-point states without writing to
				// the provider, so flipping an existing pull mapping to
				// push/two-way never floods the remote with unchanged mirrors.
				await this.ports.updateEntity(row.id, {
					[CONNECTOR_SOURCE_PROP]: { ...source, pushedState: state, pulledState },
				});
				continue;
			}
			if (state === source.pushedState) continue;
			const path = spec.path
				.split(EXTERNAL_ID_PLACEHOLDER)
				.join(encodeURIComponent(source.externalId));
			await this.ports.request({ method: spec.method ?? DEFAULT_PUSH_METHOD, path, body: payload });
			// After a successful push both sides hold the vault values — refresh
			// both baselines so neither the bookkeeping write nor the provider
			// echoing the pushed values back triggers another cycle.
			await this.ports.updateEntity(row.id, {
				[CONNECTOR_SOURCE_PROP]: {
					...source,
					syncedAt: new Date(this.ports.now()).toISOString(),
					pushedState: state,
					pulledState,
				},
			});
			pushed += 1;
		}
		return pushed;
	}

	private buildPath(mapping: ResolvedMapping): string {
		const spec = mapping.pull;
		const params = new URLSearchParams(spec.query ?? {});
		if (spec.cursorParam && mapping.cursor) {
			const cursorValue = mapping.cursor[spec.cursorParam];
			if (typeof cursorValue === "string" && cursorValue.length > 0) {
				params.set(spec.cursorParam, cursorValue);
			}
		}
		const qs = params.toString();
		if (!qs) return spec.path;
		const sep = spec.path.includes("?") ? "&" : "?";
		return `${spec.path}${sep}${qs}`;
	}

	private extractList(body: unknown, listPath?: string): unknown[] {
		const value = listPath ? readPath(body, listPath) : body;
		return Array.isArray(value) ? value : [];
	}
}

/** Defense-in-depth: a mapping whose connector declares a wildcard origin,
 *  or a pull/push path that escapes the frozen origins, must never sync.
 *  The service handler calls this before building a runner. */
export function isMappingSyncable(mapping: ResolvedMapping, apiBaseUrl: string): boolean {
	if (mapping.egressOrigins.some((o) => isWildcardAll(o))) return false;
	const candidates = [mapping.pull.path];
	if (mapping.push) {
		candidates.push(mapping.push.path.split(EXTERNAL_ID_PLACEHOLDER).join("0"));
	}
	for (const candidate of candidates) {
		let url: string;
		try {
			url = new URL(candidate, apiBaseUrl).toString();
		} catch {
			return false;
		}
		if (!validateConnectorRequest(mapping.egressOrigins, url).allowed) return false;
	}
	return true;
}
