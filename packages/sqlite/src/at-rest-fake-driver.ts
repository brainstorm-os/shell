/**
 * Test-only synchronous SQLCipher-shaped driver.
 *
 * `better-sqlite3-multiple-ciphers` cannot build/load under Bun (no matching
 * native ABI) and is blocked from-source on the dev box (Python 3.14 /
 * libexpat — OQ-34). To prove the Stage 3b key-derivation, fail-closed and
 * plaintext → encrypted migration logic regardless of driver availability,
 * this fake models the exact SQLCipher surface those code paths touch:
 *
 *   - `PRAGMA key = "x'<hex>'"` sets the connection's key.
 *   - Any read/DDL on a file whose on-disk key ≠ the connection key throws
 *     "file is not a database" (SQLCipher's real behaviour, our fail-closed
 *     trigger).
 *   - `PRAGMA rekey = "x'<hex>'"` on a readable connection re-encrypts the
 *     file in place under the new key (the migration; SQLite3MultipleCiphers
 *     supports rekeying a plaintext DB — it has no `sqlcipher_export`).
 *
 * On-disk state is a JSON file: `{ key: <hex|null>, tables: {...} }`.
 *
 * NOT exported from any production entrypoint; consumed only by tests via
 * `__setSqlcipherDriverForTests`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { SqliteRunResult } from "./sqlite";

type DiskState = { key: string | null; tables: Record<string, Array<Record<string, unknown>>> };

function load(path: string): DiskState {
	if (path === ":memory:" || !existsSync(path)) return { key: null, tables: {} };
	return JSON.parse(readFileSync(path, "utf8")) as DiskState;
}

function save(path: string, state: DiskState): void {
	if (path === ":memory:") return;
	writeFileSync(path, JSON.stringify(state));
}

const NOT_A_DB = "file is not a database";

class FakeStmt {
	constructor(
		private readonly db: FakeSqlcipherDb,
		private readonly sql: string,
	) {}
	private guard(): void {
		this.db.assertUnlocked();
	}
	run(...params: unknown[]): SqliteRunResult {
		this.guard();
		return this.db.execRun(this.sql, params);
	}
	get(): unknown {
		this.guard();
		return this.db.execGet(this.sql);
	}
	all(): unknown[] {
		this.guard();
		return this.db.execAll(this.sql);
	}
}

export class FakeSqlcipherDb {
	private readonly path: string;
	private state: DiskState;
	private connKey: string | null = null;

	constructor(path: string) {
		this.path = path;
		this.state = load(path);
	}

	/** A file with an on-disk key is unreadable until the matching key is
	 *  set on the connection — SQLCipher's behaviour, our fail-closed gate. */
	assertUnlocked(): void {
		if (this.state.key !== null && this.state.key !== this.connKey) {
			throw new Error(NOT_A_DB);
		}
	}

	exec(sql: string): void {
		const trimmed = sql.trim();
		const keyMatch = trimmed.match(/^PRAGMA key\s*=\s*"x'([0-9a-f]*)'"$/i);
		if (keyMatch) {
			this.connKey = keyMatch[1] ?? "";
			return;
		}
		const rekeyMatch = trimmed.match(/^PRAGMA rekey\s*=\s*"x'([0-9a-f]*)'"$/i);
		if (rekeyMatch) {
			// Rekey requires the current contents be readable (real driver
			// can't rewrite what it can't decrypt).
			this.assertUnlocked();
			const next = rekeyMatch[1] ?? "";
			this.state.key = next === "" ? null : next;
			this.connKey = this.state.key;
			this.persist();
			return;
		}
		this.assertUnlocked();
		this.applyDdl(trimmed);
	}

	prepare(sql: string): FakeStmt {
		return new FakeStmt(this, sql);
	}

	/** `SqlcipherRawHandle.probe` — runs a statement and surfaces its error
	 *  (a locked file throws "file is not a database"). */
	probe(sql: string): unknown {
		this.assertUnlocked();
		return this.execGet(sql);
	}

	pragma(): unknown {
		return [];
	}

	transaction<T>(fn: () => T): () => T {
		return () => {
			const snapshot = structuredClone(this.state);
			try {
				const r = fn();
				this.persist();
				return r;
			} catch (error) {
				this.state = snapshot;
				throw error;
			}
		};
	}

	close(): void {
		this.persist();
	}

	private persist(): void {
		// A connection that cannot decrypt the on-disk file cannot write it
		// either (real SQLCipher). Without this guard a no-key classify probe
		// would rewrite an encrypted file as plaintext on close.
		if (this.state.key !== null && this.state.key !== this.connKey) return;
		save(this.path, { key: this.connKey, tables: this.state.tables });
	}

	private applyDdl(sql: string): void {
		const create = sql.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i);
		if (create) {
			const t = create[1] ?? "";
			if (!this.state.tables[t]) this.state.tables[t] = [];
			this.persist();
		}
	}

	execRun(sql: string, params: unknown[]): SqliteRunResult {
		const ins = sql.match(/INSERT INTO (\w+)\s*\(([^)]+)\)/i);
		if (ins) {
			const table = ins[1] ?? "";
			const cols = (ins[2] ?? "").split(",").map((c) => c.trim());
			const rows = this.state.tables[table] ?? [];
			this.state.tables[table] = rows;
			const row: Record<string, unknown> = {};
			cols.forEach((c, i) => {
				row[c] = params[i];
			});
			rows.push(row);
			this.persist();
			return { changes: 1, lastInsertRowid: rows.length };
		}
		return { changes: 0, lastInsertRowid: 0 };
	}

	execGet(sql: string): unknown {
		if (/count\(\*\)/i.test(sql) && /sqlite_master/i.test(sql)) {
			return { n: Object.keys(this.state.tables).length };
		}
		const m = sql.match(/FROM (\w+)/i);
		if (m) return this.state.tables[m[1] ?? ""]?.[0];
		return undefined;
	}

	execAll(sql: string): unknown[] {
		const m = sql.match(/FROM (\w+)/i);
		if (m) return [...(this.state.tables[m[1] ?? ""] ?? [])];
		return [];
	}
}
