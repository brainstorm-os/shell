/**
 * ConnectorWebhooksRepository — CRUD on `registry.db.connector_webhooks`
 * (Connector-6).
 *
 * The durable backing for connector webhook-in endpoints: one shell-minted
 * `/wh/<routeId>/<secret>` route per `SyncMapping`, dispatching
 * `connectors.sync(mappingId)` when an authenticated request arrives (doc 56
 * §Sync model). Endpoints survive restart here and die with the owning
 * `ConnectorAccount` (`revokeByAccount` on disconnect).
 *
 * Custody invariant: the plaintext secret exists only in the `mint` return
 * value (the one-time reveal the caller embeds in the endpoint URL). At rest
 * this table holds the SHA-256 hex digest ONLY — registry.db is not yet
 * encrypted (Stage 3b), so an offline read of the DB must not recover a live
 * endpoint secret. No method returns a secret after mint; the ingress plane
 * verifies by hashing the presented value (`webhookSecretMatchesSha256`).
 */

import { createHash, randomBytes } from "node:crypto";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";

/** A persisted connector webhook endpoint — shell-internal (the digest never
 *  reaches an app; apps see only `routeId` + the base URLs). */
export type ConnectorWebhookRecord = {
	routeId: string;
	mappingId: string;
	accountId: string;
	connectorAppId: string;
	secretSha256: string;
	createdAt: number;
};

/** The one-time mint result. `secret` is never stored — this is the only
 *  moment it exists in plaintext. */
export type MintedConnectorWebhook = {
	routeId: string;
	secret: string;
};

type ConnectorWebhookRow = {
	route_id: string;
	mapping_id: string;
	account_id: string;
	connector_app_id: string;
	secret_sha256: string;
	created_at: number;
};

const genRouteId = (): string => `cw_${randomBytes(12).toString("base64url")}`;
/** 24 random bytes → 32 url-safe chars; fixed length so the constant-time
 *  compare's length gate is not an oracle. */
const genSecret = (): string => randomBytes(24).toString("base64url");

export const sha256Hex = (value: string): string =>
	createHash("sha256").update(value, "utf8").digest("hex");

export class ConnectorWebhooksRepository {
	constructor(
		private readonly db: SqliteDatabase,
		private readonly now: () => number = Date.now,
		private readonly ids: { routeId(): string; secret(): string } = {
			routeId: genRouteId,
			secret: genSecret,
		},
	) {}

	/** Mint the endpoint for a mapping, REPLACING any existing one (mint on an
	 *  existing mapping IS rotation: fresh routeId + fresh secret, the old URL
	 *  goes dead atomically). Returns the plaintext secret exactly once. */
	mint(input: {
		mappingId: string;
		accountId: string;
		connectorAppId: string;
	}): MintedConnectorWebhook {
		const routeId = this.ids.routeId();
		const secret = this.ids.secret();
		this.db.prepare("DELETE FROM connector_webhooks WHERE mapping_id = ?").run(input.mappingId);
		this.db
			.prepare(
				`INSERT INTO connector_webhooks
					(route_id, mapping_id, account_id, connector_app_id, secret_sha256, created_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				routeId,
				input.mappingId,
				input.accountId,
				input.connectorAppId,
				sha256Hex(secret),
				this.now(),
			);
		return { routeId, secret };
	}

	getByMapping(mappingId: string): ConnectorWebhookRecord | null {
		const row = this.db
			.prepare("SELECT * FROM connector_webhooks WHERE mapping_id = ?")
			.get(mappingId) as ConnectorWebhookRow | undefined;
		return row ? fromRow(row) : null;
	}

	/** Every endpoint — shell-internal (feeds the ingress route table). */
	listAll(): ConnectorWebhookRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM connector_webhooks ORDER BY created_at")
			.all() as ConnectorWebhookRow[];
		return rows.map(fromRow);
	}

	/** Revoke a mapping's endpoint. Returns whether a row was removed. */
	revokeByMapping(mappingId: string): boolean {
		const result = this.db
			.prepare("DELETE FROM connector_webhooks WHERE mapping_id = ?")
			.run(mappingId);
		return Number(result.changes) > 0;
	}

	/** Account disconnect — every endpoint under the account dies with it
	 *  (doc 56 §Trust: revoke is never a silent half-state). Returns the
	 *  number of endpoints removed. */
	revokeByAccount(accountId: string): number {
		const result = this.db
			.prepare("DELETE FROM connector_webhooks WHERE account_id = ?")
			.run(accountId);
		return Number(result.changes);
	}
}

function fromRow(r: ConnectorWebhookRow): ConnectorWebhookRecord {
	return {
		routeId: r.route_id,
		mappingId: r.mapping_id,
		accountId: r.account_id,
		connectorAppId: r.connector_app_id,
		secretSha256: r.secret_sha256,
		createdAt: r.created_at,
	};
}
