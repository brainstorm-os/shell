/**
 * EntityVersionsRepository — `entities.db.entity_versions` (10.16).
 *
 * One row per checkpoint. The body is NOT here: `frame_offset`/`frame_length`
 * address it inside the entity's `.yhist` (`yhist-store.ts`). LOCAL state —
 * never syncs (OQ-VH-1).
 */

import type { HistoryPrincipalKind, VersionCause } from "@brainstorm-os/sdk-types";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";

/** A writer recorded on a checkpoint, with the time of its last write in the
 *  window the checkpoint closes. */
export type StoredPrincipal = { kind: HistoryPrincipalKind; id: string; lastWriteAt: number };

export type EntityVersionRecord = {
	versionId: string;
	entityId: string;
	at: number;
	cause: VersionCause;
	changeSetId: string | null;
	principals: StoredPrincipal[];
	frameOffset: number;
	frameLength: number;
	stateKey: string;
	properties: Record<string, unknown>;
};

/** The columns retention needs — no properties JSON is parsed. */
export type EntityVersionRetentionRow = {
	versionId: string;
	entityId: string;
	at: number;
	cause: VersionCause;
	changeSetId: string | null;
	frameOffset: number;
	frameLength: number;
	propertiesBytes: number;
};

type Row = {
	version_id: string;
	entity_id: string;
	at: number;
	cause: string;
	change_set_id: string | null;
	principals: string;
	frame_offset: number;
	frame_length: number;
	state_key: string;
	properties: string;
};

const COLUMNS =
	"version_id, entity_id, at, cause, change_set_id, principals, frame_offset, frame_length, state_key, properties";

export class EntityVersionsRepository {
	constructor(private readonly db: SqliteDatabase) {}

	insert(record: EntityVersionRecord): void {
		this.db
			.prepare(`INSERT INTO entity_versions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				record.versionId,
				record.entityId,
				record.at,
				record.cause,
				record.changeSetId,
				JSON.stringify(record.principals),
				record.frameOffset,
				record.frameLength,
				record.stateKey,
				JSON.stringify(record.properties),
			);
	}

	get(versionId: string): EntityVersionRecord | null {
		const row = this.db
			.prepare(`SELECT ${COLUMNS} FROM entity_versions WHERE version_id = ?`)
			.get(versionId) as Row | undefined;
		return row ? toRecord(row) : null;
	}

	/** Newest first. */
	listByEntity(entityId: string): EntityVersionRecord[] {
		const rows = this.db
			.prepare(
				`SELECT ${COLUMNS} FROM entity_versions WHERE entity_id = ? ORDER BY at DESC, rowid DESC`,
			)
			.all(entityId) as Row[];
		return rows.map(toRecord);
	}

	latestForEntity(entityId: string): EntityVersionRecord | null {
		const row = this.db
			.prepare(
				`SELECT ${COLUMNS} FROM entity_versions WHERE entity_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`,
			)
			.get(entityId) as Row | undefined;
		return row ? toRecord(row) : null;
	}

	listByChangeSet(changeSetId: string): EntityVersionRecord[] {
		const rows = this.db
			.prepare(`SELECT ${COLUMNS} FROM entity_versions WHERE change_set_id = ? ORDER BY at, rowid`)
			.all(changeSetId) as Row[];
		return rows.map(toRecord);
	}

	hasInChangeSet(entityId: string, changeSetId: string): boolean {
		return (
			this.db
				.prepare("SELECT 1 FROM entity_versions WHERE entity_id = ? AND change_set_id = ? LIMIT 1")
				.get(entityId, changeSetId) !== undefined
		);
	}

	/** Checkpoints of `entityId` taken strictly after `at`, oldest first. */
	listAfter(entityId: string, at: number): EntityVersionRecord[] {
		const rows = this.db
			.prepare(
				`SELECT ${COLUMNS} FROM entity_versions WHERE entity_id = ? AND at > ? ORDER BY at, rowid`,
			)
			.all(entityId, at) as Row[];
		return rows.map(toRecord);
	}

	listForRetention(): EntityVersionRetentionRow[] {
		const rows = this.db
			.prepare(
				`SELECT version_id, entity_id, at, cause, change_set_id, frame_offset, frame_length,
					length(properties) AS properties_bytes
				FROM entity_versions`,
			)
			.all() as Array<
			Omit<Row, "principals" | "state_key" | "properties"> & { properties_bytes: number }
		>;
		return rows.map((r) => ({
			versionId: r.version_id,
			entityId: r.entity_id,
			at: r.at,
			cause: r.cause as VersionCause,
			changeSetId: r.change_set_id,
			frameOffset: r.frame_offset,
			frameLength: r.frame_length,
			propertiesBytes: r.properties_bytes,
		}));
	}

	deleteMany(versionIds: readonly string[]): number {
		if (versionIds.length === 0) return 0;
		const stmt = this.db.prepare("DELETE FROM entity_versions WHERE version_id = ?");
		let changes = 0;
		this.db.transaction(() => {
			for (const id of versionIds) changes += Number(stmt.run(id).changes);
		})();
		return changes;
	}

	/** Re-point every row of `entityId` whose frame moved during a `.yhist`
	 *  rewrite. `moved` maps old offset → new offset. */
	relocateFrames(entityId: string, moved: ReadonlyMap<number, number>): void {
		if (moved.size === 0) return;
		const stmt = this.db.prepare(
			"UPDATE entity_versions SET frame_offset = ? WHERE entity_id = ? AND frame_offset = ?",
		);
		// Two passes through a negative staging offset so an old offset that is
		// also some other frame's new offset can never be re-matched mid-update.
		this.db.transaction(() => {
			for (const [from] of moved) stmt.run(-1 - from, entityId, from);
			for (const [from, to] of moved) stmt.run(to, entityId, -1 - from);
		})();
	}
}

function toRecord(row: Row): EntityVersionRecord {
	return {
		versionId: row.version_id,
		entityId: row.entity_id,
		at: row.at,
		cause: row.cause as VersionCause,
		changeSetId: row.change_set_id,
		principals: parseJson<StoredPrincipal[]>(row.principals, []),
		frameOffset: row.frame_offset,
		frameLength: row.frame_length,
		stateKey: row.state_key,
		properties: parseJson<Record<string, unknown>>(row.properties, {}),
	};
}

function parseJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}
