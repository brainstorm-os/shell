/**
 * Connector-4 — `connectors.sync(mappingRef)`: the orchestrator a scheduled
 * `SyncMapping` fire (or a manual run) routes to. It resolves the mapping +
 * its account, runs a `SyncRunner` with broker-backed ports (the provider
 * call goes through `connectors.request`, so credentials never enter this
 * layer — only `accountRef` does), persists a `SyncRun/v1`, and advances
 * the mapping's cursor. The analogue of the AutomationsHost's
 * `runWorkflow` + `persistRun`.
 */

import {
	MAX_SYNC_MAPPINGS_HARD,
	MAX_SYNC_MAPPINGS_SOFT,
	SyncRunStatus,
} from "@brainstorm-os/sdk-types";
import { toSyncRunDef } from "./sync-run-def";
import {
	type ResolvedMapping,
	type SyncRunResult,
	SyncRunner,
	type SyncedEntity,
	isMappingSyncable,
} from "./sync-runner";

/** A resolved mapping plus the routing context the sync service needs. */
export type SyncContext = {
	mapping: ResolvedMapping;
	connectorAppId: string;
	apiBaseUrl: string;
};

export type ConnectorsSyncDeps = {
	/** Resolve a `SyncMapping` entity (+ its connector) for a fire. */
	resolveMapping(mappingId: string): Promise<SyncContext | null>;
	/** Decoded provider call through `connectors.request` for the account. */
	request(input: {
		connectorAppId: string;
		accountId: string;
		method: string;
		path: string;
		body?: unknown;
	}): Promise<unknown>;
	findByExternalId(entityType: string, externalKey: string): Promise<string | null>;
	/** Connector-5 — full row for two-way conflict detection. */
	getEntity(id: string): Promise<SyncedEntity | null>;
	/** Connector-5 — the push-phase candidate set for a mapping. */
	listByExternalIdPrefix(entityType: string, prefix: string): Promise<SyncedEntity[]>;
	createEntity(
		connectorAppId: string,
		entityType: string,
		properties: Record<string, unknown>,
	): Promise<{ id: string }>;
	updateEntity(connectorAppId: string, id: string, patch: Record<string, unknown>): Promise<void>;
	persistSyncRun(connectorAppId: string, def: ReturnType<typeof toSyncRunDef>): Promise<void>;
	advanceCursor(mappingId: string, cursor: Record<string, unknown>): Promise<void>;
	now(): number;
	onError?(context: string, error: unknown): void;
};

/** A concrete sync port — assignable to the host's `ConnectorSyncPort`
 *  (whose `runSync` returns `Promise<unknown>`) while exposing the typed
 *  result to direct callers (tests, `runNow`). */
export type ConnectorsSync = { runSync(mappingId: string): Promise<SyncRunResult | null> };

export function makeConnectorsSync(deps: ConnectorsSyncDeps): ConnectorsSync {
	return {
		async runSync(mappingId: string): Promise<SyncRunResult | null> {
			const ctx = await deps.resolveMapping(mappingId);
			if (!ctx) return null;
			// Defense in depth: never sync a mapping whose pull escapes the
			// connector's frozen egress origins.
			if (!isMappingSyncable(ctx.mapping, ctx.apiBaseUrl)) {
				const failed: SyncRunResult = {
					mappingRef: mappingId,
					status: SyncRunStatus.Failed,
					startedAt: new Date(deps.now()).toISOString(),
					finishedAt: new Date(deps.now()).toISOString(),
					pulled: 0,
					pushed: 0,
					conflicts: 0,
					error: "pull-path-out-of-egress-scope",
				};
				await deps.persistSyncRun(ctx.connectorAppId, toSyncRunDef(failed));
				return failed;
			}

			const runner = new SyncRunner({
				request: (input) =>
					deps.request({
						connectorAppId: ctx.connectorAppId,
						accountId: ctx.mapping.accountRef,
						method: input.method,
						path: input.path,
						...(input.body !== undefined ? { body: input.body } : {}),
					}),
				findByExternalId: deps.findByExternalId,
				getEntity: deps.getEntity,
				listByExternalIdPrefix: deps.listByExternalIdPrefix,
				createEntity: (entityType, properties) =>
					deps.createEntity(ctx.connectorAppId, entityType, properties),
				updateEntity: (id, patch) => deps.updateEntity(ctx.connectorAppId, id, patch),
				now: deps.now,
			});

			const result = await runner.run(ctx.mapping);
			try {
				await deps.persistSyncRun(ctx.connectorAppId, toSyncRunDef(result));
				if (result.nextCursor) await deps.advanceCursor(mappingId, result.nextCursor);
			} catch (error) {
				deps.onError?.(`persist sync ${mappingId}`, error);
			}
			return result;
		},
	};
}

export type SyncMappingCapVerdict = { ok: boolean; warn: boolean; count: number };

/**
 * Enforce the doc-56 volume budget at the `SyncMapping` save / registration
 * boundary: warn past the soft cap, reject past the hard cap. Counted from
 * the live mapping total.
 */
export function checkSyncMappingCap(activeCount: number): SyncMappingCapVerdict {
	return {
		ok: activeCount < MAX_SYNC_MAPPINGS_HARD,
		warn: activeCount >= MAX_SYNC_MAPPINGS_SOFT,
		count: activeCount,
	};
}
