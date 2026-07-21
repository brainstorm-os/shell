/**
 * Connector framework — production dependency assembly.
 *
 * Builds the `connectors` service deps from the live shell primitives:
 * Net-1 egress, the Tier-2 `CredentialStore`, and the entities repo /
 * service. Kept out of `index.ts` so the wiring is reviewable in one
 * place and the broker/proxy/service modules stay Electron-free + unit-
 * tested. Shell-internal reads use the entities repo directly (the shell
 * is privileged, like the shortcuts handler); connector-attributed writes
 * go through the capability-checked entities handler under the connector's
 * app identity so `entities.write:ConnectorAccount` is enforced.
 *
 * Real-shell verification (loopback OAuth round-trip + live provider) is
 * pending — the engine is fully unit-tested; this is the deploy seam.
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	CONNECTOR_ACCOUNT_TYPE_URL,
	ConflictPolicy,
	type ConnectorAccountDef,
	SYNC_RUN_TYPE_URL,
	SyncDirection,
} from "@brainstorm-os/sdk-types";
import type { CredentialStore } from "../credentials/store";
import type { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import {
	type ConnectorRequestDeps,
	type ResolvedAccount,
	type ResolvedConnector,
	makeConnectorRequest,
} from "./connectors-request";
import type { ConnectorsServiceDeps } from "./connectors-service";
import {
	type ConnectorsSync,
	type SyncContext,
	makeConnectorsSync,
} from "./connectors-sync-service";
import { type ConnectorEgress, decodeJsonResponse } from "./egress";
import {
	OAuthBroker,
	type ProviderConfig,
	type StoredToken,
	type TokenStore,
} from "./oauth-broker";
import { loopbackRedirectProvider } from "./oauth-redirect";
import {
	CONNECTOR_EXTERNAL_ID_PROP,
	type PullSpec,
	type PushSpec,
	type SyncedEntity,
} from "./sync-runner";

export type ConnectorsWiringDeps = {
	egress: ConnectorEgress;
	getRepo: () => Promise<EntitiesRepository | null>;
	getCredentials: () => CredentialStore | null;
	getLedger: () => Promise<CapabilityLedger | null>;
	/** Connector-attributed entities write under the connector's app id. */
	callEntities: (app: string, method: string, arg: unknown) => Promise<unknown>;
	openExternal: (url: string) => Promise<void>;
	notify: (n: { title: string; body: string }) => void;
	onRefused?: (info: { app: string; url: string; reason: string }) => void;
};

/** A `CredentialStore`-backed Tier-2 token store (JSON value under the
 *  vault master key). Key `oauth:<accountId>` inside the connector app's
 *  keyspace. */
function makeTokenStore(getCredentials: () => CredentialStore | null): TokenStore {
	const store = (): CredentialStore => {
		const s = getCredentials();
		if (!s) throw new Error("connectors: no active vault session for token storage");
		return s;
	};
	const key = (accountId: string): string => `oauth:${accountId}`;
	return {
		async set(connectorAppId, accountId, token) {
			await store().set(
				{ app: connectorAppId, key: key(accountId) },
				new TextEncoder().encode(JSON.stringify(token)),
			);
		},
		async get(connectorAppId, accountId) {
			const bytes = await store().get({ app: connectorAppId, key: key(accountId) });
			if (!bytes) return null;
			return JSON.parse(new TextDecoder().decode(bytes)) as StoredToken;
		},
		async delete(connectorAppId, accountId) {
			await store().delete({ app: connectorAppId, key: key(accountId) });
		},
	};
}

/** Read a `Connector/v1` entity's properties into a `ProviderConfig`. The
 *  connector app writes its manifest's OAuth + egress config onto the
 *  entity at install/connect time (doc 56 §single connector contract). */
function providerFromConnectorProps(
	props: Record<string, unknown>,
): { provider: ProviderConfig; connectorAppId: string; apiBaseUrl: string } | null {
	const oauth = props.oauth as Record<string, unknown> | undefined;
	const connectorAppId = typeof props.connectorAppId === "string" ? props.connectorAppId : "";
	const apiBaseUrl = typeof props.apiBaseUrl === "string" ? props.apiBaseUrl : "";
	const egressOrigins = Array.isArray(props.egressOrigins)
		? (props.egressOrigins.filter((o) => typeof o === "string") as string[])
		: [];
	if (!oauth || !connectorAppId || egressOrigins.length === 0) return null;
	if (
		typeof oauth.authorizeUrl !== "string" ||
		typeof oauth.tokenUrl !== "string" ||
		typeof oauth.clientId !== "string"
	) {
		return null;
	}
	const scopes = Array.isArray(oauth.scopes)
		? (oauth.scopes.filter((s) => typeof s === "string") as string[])
		: [];
	return {
		connectorAppId,
		apiBaseUrl,
		provider: {
			authorizeUrl: oauth.authorizeUrl,
			tokenUrl: oauth.tokenUrl,
			clientId: oauth.clientId,
			scopes,
			egressOrigins,
		},
	};
}

export function buildConnectorsServiceDeps(deps: ConnectorsWiringDeps): ConnectorsServiceDeps {
	const broker = new OAuthBroker({
		egress: deps.egress,
		tokens: makeTokenStore(deps.getCredentials),
		accounts: {
			async create(connectorAppId, def: ConnectorAccountDef) {
				const created = (await deps.callEntities(connectorAppId, "create", {
					type: CONNECTOR_ACCOUNT_TYPE_URL,
					properties: def,
				})) as { id: string };
				return { id: created.id };
			},
			async update(connectorAppId, accountId, patch) {
				await deps.callEntities(connectorAppId, "update", {
					id: accountId,
					patch,
				});
			},
		},
		openExternal: deps.openExternal,
		notify: deps.notify,
	});

	const resolveConnector = async (connectorRef: string): Promise<ResolvedConnector | null> => {
		const repo = await deps.getRepo();
		if (!repo) return null;
		const row = repo.get(connectorRef);
		if (!row) return null;
		return providerFromConnectorProps(row.properties);
	};

	const resolveAccount = async (accountId: string): Promise<ResolvedAccount | null> => {
		const repo = await deps.getRepo();
		if (!repo) return null;
		const accountRow = repo.get(accountId);
		if (!accountRow) return null;
		const connectorRef =
			typeof accountRow.properties.connectorRef === "string" ? accountRow.properties.connectorRef : "";
		const connector = await resolveConnector(connectorRef);
		if (!connector) return null;
		return { ...connector, accountId, connectorRef };
	};

	const requestDeps: ConnectorRequestDeps = {
		egress: deps.egress,
		broker,
		getLedger: deps.getLedger,
		...(deps.onRefused ? { onRefused: deps.onRefused } : {}),
	};
	const connectorRequest = makeConnectorRequest(requestDeps);

	// Connector-4 production sync: resolve a `SyncMapping` entity → run the
	// engine through the same egress proxy, projecting into entities under the
	// connector's identity.
	const resolveMapping = async (mappingId: string): Promise<SyncContext | null> => {
		const repo = await deps.getRepo();
		if (!repo) return null;
		const row = repo.get(mappingId);
		if (!row) return null;
		const p = row.properties;
		const accountRef = typeof p.accountRef === "string" ? p.accountRef : "";
		const account = await resolveAccount(accountRef);
		if (!account) return null;
		if (!p.pull || typeof p.pull !== "object") return null;
		return {
			connectorAppId: account.connectorAppId,
			apiBaseUrl: account.apiBaseUrl,
			mapping: {
				mappingId,
				accountRef,
				externalKind: typeof p.externalKind === "string" ? p.externalKind : "",
				entityType: typeof p.entityType === "string" ? p.entityType : "",
				fieldMap: (p.fieldMap as Record<string, unknown>) ?? {},
				direction: (p.direction as SyncDirection) ?? SyncDirection.Pull,
				conflictPolicy: (p.conflictPolicy as ConflictPolicy) ?? ConflictPolicy.ExternalWins,
				pull: p.pull as PullSpec,
				...(p.push && typeof p.push === "object" ? { push: p.push as PushSpec } : {}),
				egressOrigins: account.provider.egressOrigins,
				...(p.cursor && typeof p.cursor === "object"
					? { cursor: p.cursor as Record<string, unknown> }
					: {}),
			},
		};
	};

	const sync: ConnectorsSync = makeConnectorsSync({
		resolveMapping,
		request: async ({ connectorAppId, accountId, method, path, body }) => {
			const account = await resolveAccount(accountId);
			if (!account) throw new Error(`connectors.sync: unknown account ${accountId}`);
			const res = await connectorRequest({
				envelopeApp: connectorAppId,
				account,
				method,
				path,
				...(body !== undefined ? { body } : {}),
			});
			return decodeJsonResponse(res, "connectors.sync");
		},
		findByExternalId: async (entityType, key) => {
			const repo = await deps.getRepo();
			if (!repo) return null;
			for (const id of repo.listIdsWithProperty(CONNECTOR_EXTERNAL_ID_PROP, key)) {
				if (repo.get(id)?.type === entityType) return id;
			}
			return null;
		},
		getEntity: async (id) => {
			const repo = await deps.getRepo();
			const row = repo?.get(id);
			if (!row) return null;
			return { id: row.id, properties: row.properties, updatedAt: row.updatedAt };
		},
		listByExternalIdPrefix: async (entityType, prefix) => {
			const repo = await deps.getRepo();
			if (!repo) return [];
			const out: SyncedEntity[] = [];
			for (const id of repo.idsByTypes([entityType])) {
				const row = repo.get(id);
				const key = row?.properties[CONNECTOR_EXTERNAL_ID_PROP];
				if (!row || typeof key !== "string" || !key.startsWith(prefix)) continue;
				out.push({ id: row.id, properties: row.properties, updatedAt: row.updatedAt });
			}
			return out;
		},
		createEntity: async (connectorAppId, type, properties) =>
			(await deps.callEntities(connectorAppId, "create", { type, properties })) as { id: string },
		updateEntity: async (connectorAppId, id, patch) => {
			await deps.callEntities(connectorAppId, "update", { id, patch });
		},
		persistSyncRun: async (connectorAppId, def) => {
			await deps.callEntities(connectorAppId, "create", {
				type: SYNC_RUN_TYPE_URL,
				properties: def,
			});
		},
		advanceCursor: async (mappingId, cursor) => {
			const ctx = await resolveMapping(mappingId);
			if (!ctx) return;
			await deps.callEntities(ctx.connectorAppId, "update", {
				id: mappingId,
				patch: { cursor },
			});
		},
		now: () => Date.now(),
		...(deps.onRefused
			? {
					onError: (context: string, error: unknown) =>
						deps.onRefused?.({ app: "connectors.sync", url: context, reason: String(error) }),
				}
			: {}),
	});

	return {
		broker,
		redirectProvider: loopbackRedirectProvider,
		resolveConnector,
		resolveAccount,
		request: connectorRequest,
		sync: (mappingRef: string) => sync.runSync(mappingRef),
		getLedger: deps.getLedger,
	};
}
