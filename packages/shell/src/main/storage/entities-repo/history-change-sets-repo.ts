/**
 * HistoryChangeSetsRepository — `entities.db.history_change_sets` (10.16).
 *
 * A change set groups the checkpoints one multi-entity operation took (a bulk
 * edit, an agent run, an import, a restore), so the whole operation reverts as
 * one action. `principals` is who the operation acts as — the revert's "edited
 * since by someone else" rule is measured against it. LOCAL state (OQ-VH-1).
 */

import type { HistoryPrincipalKind, VersionCause } from "@brainstorm-os/sdk-types";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";

export type ChangeSetPrincipal = { kind: HistoryPrincipalKind; id: string };

export type HistoryChangeSetRecord = {
	changeSetId: string;
	cause: VersionCause;
	principals: ChangeSetPrincipal[];
	createdAt: number;
};

type Row = { change_set_id: string; cause: string; principals: string; created_at: number };

export class HistoryChangeSetsRepository {
	constructor(private readonly db: SqliteDatabase) {}

	create(record: HistoryChangeSetRecord): void {
		this.db
			.prepare(
				"INSERT INTO history_change_sets (change_set_id, cause, principals, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(record.changeSetId, record.cause, JSON.stringify(record.principals), record.createdAt);
	}

	get(changeSetId: string): HistoryChangeSetRecord | null {
		const row = this.db
			.prepare(
				"SELECT change_set_id, cause, principals, created_at FROM history_change_sets WHERE change_set_id = ?",
			)
			.get(changeSetId) as Row | undefined;
		if (!row) return null;
		let principals: ChangeSetPrincipal[] = [];
		try {
			principals = JSON.parse(row.principals) as ChangeSetPrincipal[];
		} catch {
			principals = [];
		}
		return {
			changeSetId: row.change_set_id,
			cause: row.cause as VersionCause,
			principals,
			createdAt: row.created_at,
		};
	}

	/** Every change set's principals, keyed by id — retention's per-principal cap. */
	listPrincipals(): Map<string, ChangeSetPrincipal[]> {
		const rows = this.db
			.prepare("SELECT change_set_id, principals FROM history_change_sets")
			.all() as Array<Pick<Row, "change_set_id" | "principals">>;
		const out = new Map<string, ChangeSetPrincipal[]>();
		for (const r of rows) {
			try {
				out.set(r.change_set_id, JSON.parse(r.principals) as ChangeSetPrincipal[]);
			} catch {
				out.set(r.change_set_id, []);
			}
		}
		return out;
	}

	/** Drop change sets no checkpoint references any more. */
	deleteOrphans(): number {
		const result = this.db
			.prepare(
				`DELETE FROM history_change_sets WHERE NOT EXISTS (
					SELECT 1 FROM entity_versions v WHERE v.change_set_id = history_change_sets.change_set_id
				)`,
			)
			.run();
		return Number(result.changes);
	}
}
