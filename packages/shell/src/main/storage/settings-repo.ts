/**
 * SettingsRepository — typed CRUD over `settings.db` (per-app, per-device
 * key/value). Per the Stage 5 repository-pattern rule, all SQL for the
 * `settings` table lives here; the settings service is pure orchestration.
 *
 * App-scoped: every method takes the broker-verified `appId`, so one app
 * can never reach another's namespace (the same isolation the retired
 * `kv.json` silo had, now enforced by the table's composite PK).
 * `value` is an opaque JSON string the caller serialises/parses.
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";

export type SettingsEntry = { key: string; value: string };

export class SettingsRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	get(appId: string, key: string): string | null {
		const row = this.stmt("SELECT value FROM settings WHERE app_id = ? AND key = ?").get(
			appId,
			key,
		) as { value: string } | undefined;
		return row ? row.value : null;
	}

	set(appId: string, key: string, value: string): void {
		this.stmt(
			"INSERT INTO settings (app_id, key, value) VALUES (?, ?, ?) ON CONFLICT (app_id, key) DO UPDATE SET value = excluded.value",
		).run(appId, key, value);
	}

	delete(appId: string, key: string): boolean {
		const result = this.stmt("DELETE FROM settings WHERE app_id = ? AND key = ?").run(appId, key);
		return Number(result.changes) > 0;
	}

	/** All entries for an app whose key starts with `prefix` (""=all),
	 *  ordered by key for deterministic listing. */
	list(appId: string, prefix = ""): SettingsEntry[] {
		const rows = this.stmt(
			"SELECT key, value FROM settings WHERE app_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key",
		).all(appId, `${escapeLike(prefix)}%`) as Array<{ key: string; value: string }>;
		return rows.map((r) => ({ key: r.key, value: r.value }));
	}
}

/** Escape LIKE wildcards in a user-supplied prefix so `%`/`_`/`\` in a key
 *  prefix match literally (paired with `ESCAPE '\'`). */
function escapeLike(prefix: string): string {
	return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
