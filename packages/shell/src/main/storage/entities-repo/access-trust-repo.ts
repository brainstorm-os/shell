/**
 * `access_roots` + `access_statements` + `entity_containers` repository (0.16.0 sharing
 * authorization) — what THIS device knows about who holds authority over a
 * shared entity, kept outside the entity's own doc because the doc is writable
 * by every member.
 *
 *   - `access_roots` pins the entity's root owner on first sight. First pin
 *     wins: a later record can never move it.
 *   - `entity_containers` pins the container a shared child was first seen in,
 *     which is what the writer gate consults for the child (first pin wins).
 *   - `access_statements` is the device's memory of signed grants and revokes it
 *     has seen take effect, so deleting one from the doc's array changes nothing
 *     here.
 *
 * LOCAL state — never syncs, never crosses the wire. SQL lives only here
 * (CLAUDE.md §Repository pattern for SQL).
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";

/** Which half of an access entry a remembered statement is. */
export enum AccessStatementKind {
	Grant = "grant",
	Revoke = "revoke",
}

export type AccessStatementRecord = {
	kind: AccessStatementKind;
	/** The statement's own signature (base64) — its identity within an entity. */
	sig: string;
	/** The signed fields, JSON. */
	body: string;
};

/** Per-entity ceiling on remembered statements. Only statements that had
 *  effect are remembered, so reaching this takes an owner, not an outsider —
 *  the cap is there so even that cannot grow the table without bound. */
export const ACCESS_STATEMENTS_PER_ENTITY_MAX = 4096;

export class AccessTrustRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	getRoot(entityId: string): string | null {
		const row = this.stmt("SELECT root_pub FROM access_roots WHERE entity_id = ?").get(entityId) as
			| { root_pub: string }
			| undefined;
		return row?.root_pub ?? null;
	}

	/** Pin `rootPub` as the entity's root owner. A no-op when one is already
	 *  pinned — the first pin is the only pin. Returns the root now in force. */
	pinRoot(entityId: string, rootPub: string, now: number): string {
		this.stmt(
			"INSERT INTO access_roots (entity_id, root_pub, pinned_at) VALUES (?, ?, ?) " +
				"ON CONFLICT(entity_id) DO NOTHING",
		).run(entityId, rootPub, now);
		return this.getRoot(entityId) ?? rootPub;
	}

	listStatements(entityId: string): AccessStatementRecord[] {
		const rows = this.stmt(
			"SELECT kind, sig, body FROM access_statements WHERE entity_id = ? ORDER BY seen_at, sig",
		).all(entityId) as Array<{ kind: string; sig: string; body: string }>;
		return rows.map((row) => ({
			kind:
				row.kind === AccessStatementKind.Revoke
					? AccessStatementKind.Revoke
					: AccessStatementKind.Grant,
			sig: row.sig,
			body: row.body,
		}));
	}

	/** Remember statements. Already-known ones are left alone; past the
	 *  per-entity ceiling nothing more is taken. */
	remember(entityId: string, records: readonly AccessStatementRecord[], now: number): void {
		if (records.length === 0) return;
		const count = this.stmt("SELECT COUNT(*) AS n FROM access_statements WHERE entity_id = ?").get(
			entityId,
		) as { n: number };
		let room = ACCESS_STATEMENTS_PER_ENTITY_MAX - Number(count.n);
		for (const record of records) {
			if (room <= 0) return;
			const result = this.stmt(
				"INSERT INTO access_statements (entity_id, kind, sig, body, seen_at) VALUES (?, ?, ?, ?, ?) " +
					"ON CONFLICT(entity_id, kind, sig) DO NOTHING",
			).run(entityId, record.kind, record.sig, record.body, now);
			if (Number(result.changes) > 0) room--;
		}
	}

	getContainer(entityId: string): string | null {
		const row = this.stmt("SELECT container_id FROM entity_containers WHERE entity_id = ?").get(
			entityId,
		) as { container_id: string } | undefined;
		return row?.container_id ?? null;
	}

	/** Pin the container `entityId` was first seen in. First pin wins; returns
	 *  the container now in force. */
	pinContainer(entityId: string, containerId: string, now: number): string {
		this.stmt(
			"INSERT INTO entity_containers (entity_id, container_id, pinned_at) VALUES (?, ?, ?) " +
				"ON CONFLICT(entity_id) DO NOTHING",
		).run(entityId, containerId, now);
		return this.getContainer(entityId) ?? containerId;
	}

	/** Every entity pinned to `containerId`. */
	listContained(containerId: string): string[] {
		const rows = this.stmt(
			"SELECT entity_id FROM entity_containers WHERE container_id = ? ORDER BY pinned_at, entity_id",
		).all(containerId) as Array<{ entity_id: string }>;
		return rows.map((row) => row.entity_id);
	}
}
