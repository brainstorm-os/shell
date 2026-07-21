/**
 * OpenersRepository — CRUD on `registry.db.openers`.
 *
 * An opener says "app X handles entity-type/MIME Y as primary or secondary".
 * Rows are replaced wholesale per app on install/update — old registrations
 * are cleared, new ones inserted.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";

/** What an opener row's `target` is keyed by. `EntityType`/`Mime` are the
 *  original surface; `Scheme`/`Extension` were added for the open-resolution
 *  ladder (OpenRes-1a, doc 57 §Openable targets) so the Web Browser can
 *  register `scheme:https`, Files an `extension:*` tail, etc. — no new verb,
 *  just more target kinds the one resolver matches. Enum, not a raw union,
 *  per CLAUDE.md (the literals are the on-disk + wire form). */
export enum OpenerTargetKind {
	EntityType = "entity_type",
	Mime = "mime",
	Scheme = "scheme",
	Extension = "extension",
}

export type OpenerRecord = {
	appId: string;
	targetKind: OpenerTargetKind;
	target: string;
	kind: "primary" | "secondary";
};

export class OpenersRepository {
	constructor(private readonly db: SqliteDatabase) {}

	insert(opener: OpenerRecord): void {
		this.db
			.prepare("INSERT INTO openers (app_id, target_kind, target, kind) VALUES (?, ?, ?, ?)")
			.run(opener.appId, opener.targetKind, opener.target, opener.kind);
	}

	insertMany(openers: readonly OpenerRecord[]): void {
		const stmt = this.db.prepare(
			"INSERT INTO openers (app_id, target_kind, target, kind) VALUES (?, ?, ?, ?)",
		);
		for (const o of openers) {
			stmt.run(o.appId, o.targetKind, o.target, o.kind);
		}
	}

	deleteForApp(appId: string): number {
		const result = this.db.prepare("DELETE FROM openers WHERE app_id = ?").run(appId);
		return Number(result.changes);
	}

	listForTarget(targetKind: OpenerTargetKind, target: string): OpenerRecord[] {
		const rows = this.db
			.prepare(
				"SELECT app_id, target_kind, target, kind FROM openers WHERE target_kind = ? AND target = ?",
			)
			.all(targetKind, target) as Array<{
			app_id: string;
			target_kind: OpenerTargetKind;
			target: string;
			kind: "primary" | "secondary";
		}>;
		return rows.map((r) => ({
			appId: r.app_id,
			targetKind: r.target_kind,
			target: r.target,
			kind: r.kind,
		}));
	}

	listForApp(appId: string): OpenerRecord[] {
		const rows = this.db
			.prepare(
				"SELECT app_id, target_kind, target, kind FROM openers WHERE app_id = ? ORDER BY target_kind, target",
			)
			.all(appId) as Array<{
			app_id: string;
			target_kind: OpenerTargetKind;
			target: string;
			kind: "primary" | "secondary";
		}>;
		return rows.map((r) => ({
			appId: r.app_id,
			targetKind: r.target_kind,
			target: r.target,
			kind: r.kind,
		}));
	}

	/** Every distinct `target` string registered under `targetKind`,
	 *  ASC-sorted + deduplicated by SQLite. Used by the OpenRes-1c
	 *  Settings → Defaults catalog to enumerate the schemes / extensions
	 *  the user can pin a default handler for (without listing every
	 *  app-row twice when two apps register the same scheme). */
	listDistinctTargets(targetKind: OpenerTargetKind): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT target FROM openers WHERE target_kind = ? ORDER BY target ASC")
			.all(targetKind) as Array<{ target: string }>;
		return rows.map((r) => r.target);
	}
}
