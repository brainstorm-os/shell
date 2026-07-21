/**
 * SQLite migration runner per §Schema migration.
 *
 *   Each domain DB tracks its schema version in a `_schema_version` table:
 *
 *     CREATE TABLE _schema_version (
 *       version    INTEGER PRIMARY KEY,
 *       applied_at INTEGER NOT NULL,
 *       description TEXT NOT NULL
 *     );
 *
 *   On open, the runner reads the row with the highest `version`, compares
 *   against the in-code migration list, and applies any pending migrations
 *   inside a single transaction. Forward-only — the migration list is
 *   append-only and migrations are never modified after release.
 *
 * Built on top of `runMigrations<Context>` from `util/schema-version.ts` so
 * the same ordering / forward-only / error-propagation rules apply.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { type Migration, runMigrations } from "../util/schema-version";

export type SqliteMigration = Migration<SqliteDatabase>;

const ENSURE_SCHEMA_VERSION_TABLE = `
	CREATE TABLE IF NOT EXISTS _schema_version (
		version     INTEGER PRIMARY KEY,
		applied_at  INTEGER NOT NULL,
		description TEXT NOT NULL
	);
`;

/**
 * Read the current schema version. Returns 0 when the `_schema_version`
 * table is absent or empty — i.e. this is a fresh DB and version-0 means
 * "no migrations applied yet".
 */
export function getSchemaVersion(db: SqliteDatabase): number {
	db.exec(ENSURE_SCHEMA_VERSION_TABLE);
	const row = db.prepare("SELECT MAX(version) AS v FROM _schema_version").get() as
		| { v: number | null }
		| undefined;
	return row?.v ?? 0;
}

/**
 * Apply pending migrations up to (and including) the highest-numbered entry
 * in `migrations`. Each migration runs inside a transaction so a partial
 * failure rolls back cleanly.
 *
 * Returns the new schema version after application.
 */
export async function applyMigrations(
	db: SqliteDatabase,
	migrations: readonly SqliteMigration[],
): Promise<number> {
	if (migrations.length === 0) return getSchemaVersion(db);

	const current = getSchemaVersion(db);
	const target = migrations[migrations.length - 1]?.version ?? current;
	if (target <= current) return current;

	const wrapped: SqliteMigration[] = migrations.map((m) => ({
		version: m.version,
		description: m.description,
		up: (database: SqliteDatabase) => {
			const txn = database.transaction(() => {
				const result = m.up(database);
				if (result instanceof Promise) {
					throw new Error(
						`SQLite migration ${m.version} returned a Promise — migrations must be synchronous`,
					);
				}
				database
					.prepare("INSERT INTO _schema_version (version, applied_at, description) VALUES (?, ?, ?)")
					.run(m.version, Date.now(), m.description);
			});
			txn();
		},
	}));

	const result = await runMigrations<SqliteDatabase>(current, target, wrapped, db);
	return result.to;
}
