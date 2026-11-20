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
	/** base64 key of whoever signed it — whose quota it counts against. */
	signer: string;
};

/** Ceiling on the GRANTS remembered per entity from the root, and — as one
 *  pool — from everyone else. Only statements that had effect are remembered,
 *  so reaching either takes an owner, not an outsider. */
export const ACCESS_STATEMENTS_PER_ENTITY_MAX = 4096;

/** Ceiling on the statements remembered per entity from any ONE signer other
 *  than the root, so a single co-owner cannot fill the memory. */
export const ACCESS_STATEMENTS_PER_SIGNER_MAX = 256;

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
			"SELECT kind, sig, body, signer FROM access_statements WHERE entity_id = ? ORDER BY seen_at, sig",
		).all(entityId) as Array<{ kind: string; sig: string; body: string; signer: string }>;
		return rows.map((row) => ({
			kind:
				row.kind === AccessStatementKind.Revoke
					? AccessStatementKind.Revoke
					: AccessStatementKind.Grant,
			sig: row.sig,
			body: row.body,
			signer: row.signer,
		}));
	}

	/**
	 * Remember statements. Already-known ones are left alone. Returns how many
	 * could NOT be kept, so the caller can say so — nothing is dropped silently.
	 *
	 * What is kept is decided by what losing it would cost:
	 *   - a REVOKE signed by `rootPub` is always kept, with no ceiling: it is the
	 *     owner removing someone, and forgetting it is how a removal comes undone;
	 *   - a revoke from anyone else is kept within that signer's quota, evicting
	 *     that signer's own oldest remembered GRANT to make room if need be;
	 *   - a grant is kept within its signer's quota and its pool's ceiling (the
	 *     root has a pool to itself). Forgetting a grant only ever removes access.
	 */
	remember(
		entityId: string,
		records: readonly AccessStatementRecord[],
		now: number,
		rootPub: string,
	): number {
		let dropped = 0;
		for (const record of records) {
			const known = this.stmt(
				"SELECT 1 FROM access_statements WHERE entity_id = ? AND kind = ? AND sig = ?",
			).get(entityId, record.kind, record.sig);
			if (known !== undefined) continue;
			if (!this.makeRoom(entityId, record, rootPub)) {
				dropped++;
				continue;
			}
			this.stmt(
				"INSERT INTO access_statements (entity_id, kind, sig, body, seen_at, signer) VALUES (?, ?, ?, ?, ?, ?) " +
					"ON CONFLICT(entity_id, kind, sig) DO NOTHING",
			).run(entityId, record.kind, record.sig, record.body, now, record.signer);
		}
		return dropped;
	}

	private count(entityId: string, where: string, ...args: string[]): number {
		const row = this.stmt(
			`SELECT COUNT(*) AS n FROM access_statements WHERE entity_id = ? AND ${where}`,
		).get(entityId, ...args) as { n: number };
		return Number(row.n);
	}

	private makeRoom(entityId: string, record: AccessStatementRecord, rootPub: string): boolean {
		const fromRoot = record.signer === rootPub;
		const isRevoke = record.kind === AccessStatementKind.Revoke;
		if (fromRoot) {
			if (isRevoke) return true;
			return (
				this.count(entityId, "kind = ? AND signer = ?", AccessStatementKind.Grant, rootPub) <
				ACCESS_STATEMENTS_PER_ENTITY_MAX
			);
		}
		const mine = this.count(entityId, "signer = ?", record.signer);
		if (mine >= ACCESS_STATEMENTS_PER_SIGNER_MAX) {
			if (!isRevoke) return false;
			const evicted = this.stmt(
				"DELETE FROM access_statements WHERE rowid = (SELECT rowid FROM access_statements " +
					"WHERE entity_id = ? AND signer = ? AND kind = ? ORDER BY seen_at, sig LIMIT 1)",
			).run(entityId, record.signer, AccessStatementKind.Grant);
			return Number(evicted.changes) > 0;
		}
		if (isRevoke) return true;
		return (
			this.count(entityId, "kind = ? AND signer <> ?", AccessStatementKind.Grant, rootPub) <
			ACCESS_STATEMENTS_PER_ENTITY_MAX
		);
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
