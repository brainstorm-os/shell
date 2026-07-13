/**
 * Runtime-agnostic SQLite driver.
 *
 * Per OQ-34 (Stage 3 interim → Stage 3b), the storage layer uses page-level
 * encryption via a SQLCipher-compatible backend. Three backing drivers,
 * picked at runtime:
 *
 *   - SQLCipher driver (`better-sqlite3-multiple-ciphers`) — the production
 *     encrypted path. Synchronous, drop-in for `better-sqlite3`, SQLCipher
 *     built in. Selected first when it resolves. This is the Stage 3b swap.
 *   - `better-sqlite3` — the legacy unencrypted Electron path. Used only if
 *     the SQLCipher driver is NOT installed/buildable in this environment
 *     (see the driver-availability gate below).
 *   - `bun:sqlite` — tests only (Bun runtime; no encryption support).
 *
 * Stage 3b activation is gated on the SQLCipher driver actually resolving
 * (`isSqlcipherAvailable()`). The HKDF per-DB key derivation, the
 * `PRAGMA key` wiring, the fail-closed verification and the plaintext →
 * encrypted migration are all real and fully tested regardless; the gate
 * only chooses whether a real on-disk file is encrypted. When the env that
 * blocks the native build is fixed (the dev box's Python 3.14 / libexpat
 * `pyexpat` ABI mismatch — system-level, see OQ-34), the driver resolves
 * and the encrypted path turns on with no code change.
 *
 * Both wrapped drivers expose the same minimal surface:
 *   - `prepare(sql).run(...params) | .get(...params) | .all(...params)`
 *   - `exec(sql)` / `close()` / `transaction(fn)`
 *   - `pragma(sql)` — issues a `PRAGMA <sql>` and returns the first row.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyToHex } from "./at-rest-key";
import {
	AtRestState,
	type RawOpener,
	type SqlcipherRawHandle,
	classifyAtRest,
	migratePlaintextToEncrypted,
} from "./at-rest-migration";

export type SqliteRunResult = {
	changes: number;
	lastInsertRowid: number | bigint;
};

export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	pragma(sql: string): unknown;
	transaction<T>(fn: () => T): () => T;
	close(): void;
	/** True while the underlying connection is open. A handle whose
	 *  connection was closed out-of-band (e.g. a session teardown that the
	 *  owning cache didn't observe) reports false, so callers can detect and
	 *  reopen a dead handle instead of throwing "database connection is not
	 *  open" on first use. */
	isOpen(): boolean;
	/**
	 * Load the `sqlite-vec` loadable extension onto this connection so vec0
	 * virtual tables work. Returns `true` on success, `false` (degrade,
	 * never throw) when the extension can't be loaded — which is the case
	 * under `bun:sqlite` (the test runtime, whose sqlite build rejects
	 * dynamic extension loading) and on any platform missing the prebuilt
	 * binary. Optional so non-search code is unaffected; the vector search
	 * path treats a `false`/absent result as "vector index unavailable this
	 * session" and falls back to lexical-only.
	 */
	loadVecExtension?(): boolean;
}

export type OpenOptions = {
	/** When true (default), enable WAL mode and FOREIGN KEYS on open. */
	tunePragmas?: boolean;
	/**
	 * Raw 32-byte at-rest key (lowercase hex, no `0x`). When set AND the
	 * SQLCipher driver is active, `PRAGMA key` is issued immediately after
	 * open and a fail-closed read probe is run. A plaintext legacy file is
	 * transparently migrated to encrypted before the keyed open. When the
	 * SQLCipher driver is NOT active this is accepted but inert (the file
	 * stays plaintext) — Stage 3b is gated on the driver, never silently
	 * dropping the data.
	 */
	encryptionKeyHex?: string;
};

/**
 * Thrown when an encrypted at-rest DB can't be opened because the session's
 * key is wrong or missing. Typed (not a bare `Error`) so callers detect it
 * without string-matching the message — `DataStores` negative-caches it so a
 * wrong-key vault doesn't re-run SQLCipher's (deliberately expensive) KDF on
 * the main thread for every subsequent open, which otherwise stacks up into a
 * visible shell freeze on any burst of DB-backed IPC (capability checks,
 * `apps:list-installed`, entity/search reads). The message text is unchanged
 * from the prior bare throw so existing log lines stay identical.
 */
export class AtRestKeyError extends Error {
	constructor(pathTail: string, options?: { cause?: unknown }) {
		super(
			`sqlite: failed to open encrypted database (wrong or missing at-rest key): ${pathTail}`,
			options,
		);
		this.name = "AtRestKeyError";
	}
}

type DriverName = "sqlcipher" | "bun" | "node";

type Driver = {
	name: DriverName;
	encrypts: boolean;
	open: (path: string) => SqliteDatabase;
	/** Un-wrapped handle used by the at-rest migration (probe + ATTACH).
	 *  Only the SQLCipher driver provides it; others throw if asked. */
	openRaw?: RawOpener;
};

let cachedDriver: Driver | null = null;
let sqlcipherProbed = false;
let sqlcipherCtor: (new (path: string) => BetterDb) | null = null;

/**
 * Resolve the SQLCipher driver ONCE. `better-sqlite3-multiple-ciphers` is a
 * binary-compatible superset of `better-sqlite3` (same constructor, same
 * sync API) with SQLCipher compiled in. If it is not installed/buildable in
 * this environment the dynamic import throws and we record "unavailable" —
 * this is the Stage 3b driver-availability gate.
 */
async function probeSqlcipher(): Promise<void> {
	if (sqlcipherProbed) return;
	sqlcipherProbed = true;
	const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
	// `bun:sqlite` cannot load a better-sqlite3-shaped native addon, so the
	// SQLCipher driver is a non-starter under Bun (tests). Logic below is
	// exercised through the injectable test driver instead.
	if (hasBun) return;
	try {
		const specifier = "better-sqlite3-multiple-ciphers";
		const mod = (await import(/* @vite-ignore */ specifier)) as {
			default: new (path: string) => BetterDb;
		};
		sqlcipherCtor = mod.default;
	} catch {
		sqlcipherCtor = null;
	}
}

/** True once the SQLCipher driver has resolved. Drives the Stage 3b gate
 *  and is asserted by tests / observability. Call after the first `open()`
 *  (or `ensureDriverProbed()`). */
export function isSqlcipherAvailable(): boolean {
	return sqlcipherCtor !== null;
}

/** Force the one-time driver probe without opening a DB. Lets callers /
 *  tests query `isSqlcipherAvailable()` deterministically. */
export async function ensureDriverProbed(): Promise<void> {
	await probeSqlcipher();
}

/**
 * Test seam: inject a synchronous SQLCipher-shaped driver so the
 * encryption/migration/fail-closed paths are exercised under Bun where no
 * native SQLCipher addon exists. Production never calls this. Pass `null`
 * to clear and re-probe (test isolation).
 */
export function __setSqlcipherDriverForTests(ctor: (new (path: string) => BetterDb) | null): void {
	sqlcipherCtor = ctor;
	sqlcipherProbed = ctor !== null;
	cachedDriver = null;
}

/**
 * Stage 3b driver-availability gate. `await import("better-sqlite3-multiple-
 * ciphers")` only resolves the package's JavaScript, and even constructing a
 * DB only proves the native addon *loads* — neither proves the driver
 * actually supports the SQL the encryption path depends on. Two real outages
 * came through this gap:
 *
 *   1. addon never built for this ABI → every open threw "Could not locate
 *      the bindings file" (OQ-34 dev-box Python failure);
 *   2. addon loaded fine but the driver is SQLite3MultipleCiphers, which has
 *      no `sqlcipher_export()` → the migration threw "no such function".
 *
 * Both escaped through every DB-backed IPC handler (`apps:list-installed`,
 * `apps:launch`, …). So the gate runs the *production migration itself* once,
 * against the real driver, on a throwaway plaintext file: open plaintext →
 * `migratePlaintextToEncrypted` (PRAGMA rekey + its own fail-closed verify) →
 * confirm the encrypted file is readable *with* the key. If any step throws
 * or the contract doesn't hold, the SQLCipher driver is treated as
 * unavailable and we fall back to the legacy unencrypted driver — a loud,
 * graceful degradation instead of bricking every vault open.
 *
 * NOTE (discipline): the at-rest path must use only portable PRAGMA-level SQL
 * (`PRAGMA key` / `PRAGMA rekey`) — never driver-proprietary functions like
 * `sqlcipher_export`. This probe is what enforces that invariant against the
 * real driver, since the test suite can only exercise the injectable fake
 * (`better-sqlite3-multiple-ciphers` cannot load under Bun/vitest).
 */
async function sqlcipherContractHolds(ctor: new (path: string) => BetterDb): Promise<boolean> {
	let dir: string | null = null;
	try {
		dir = mkdtempSync(join(tmpdir(), "bs-sqlcipher-probe-"));
		const dbPath = join(dir, "probe.db");
		const rawOpen: RawOpener = (p) => rawBetter(new ctor(p));

		// Materialise a plaintext DB shaped like a pre-3b legacy vault.
		{
			const h = rawOpen(dbPath);
			h.exec("CREATE TABLE t (x TEXT)");
			h.exec("INSERT INTO t (x) VALUES ('probe')");
			h.close();
		}
		// Run the exact production migration with a throwaway key. This
		// internally fail-closed-verifies the file is genuinely encrypted.
		const key = new Uint8Array(randomBytes(32));
		await migratePlaintextToEncrypted(dbPath, key, rawOpen);
		// And confirm it reopens readable WITH the key (no proprietary SQL).
		const keyed = new ctor(dbPath);
		try {
			keyed.exec(`PRAGMA key = "x'${keyToHex(key)}'"`);
			keyed.prepare("SELECT count(*) AS n FROM t").get();
		} finally {
			keyed.close();
		}
		return true;
	} catch {
		return false;
	} finally {
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort temp cleanup */
			}
		}
	}
}

async function resolveDriver(): Promise<Driver> {
	if (cachedDriver) return cachedDriver;
	await probeSqlcipher();

	if (sqlcipherCtor) {
		if (await sqlcipherContractHolds(sqlcipherCtor)) {
			const ctor = sqlcipherCtor;
			cachedDriver = {
				name: "sqlcipher",
				encrypts: true,
				open: (path: string) => wrapBetter(new ctor(path)),
				openRaw: (path: string) => rawBetter(new ctor(path)),
			};
			return cachedDriver;
		}
		// The driver resolved but failed the at-rest contract probe (addon
		// won't load for this ABI — OQ-34 — or lacks the SQL the encryption
		// path needs). Make the Stage 3b gate honest and fall through to the
		// legacy unencrypted driver instead of throwing on every DB open.
		console.warn(
			"[brainstorm] SQLCipher driver present but failed the at-rest contract probe; falling back to unencrypted better-sqlite3 (Stage 3b inactive — OQ-34).",
		);
		sqlcipherCtor = null;
	}

	const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
	if (hasBun) {
		const specifier = "bun:sqlite";
		const mod = (await import(/* @vite-ignore */ specifier)) as {
			Database: new (path: string) => BunDb;
		};
		cachedDriver = {
			name: "bun",
			encrypts: false,
			open: (path: string) => wrapBun(new mod.Database(path)),
		};
		return cachedDriver;
	}

	const mod = (await import("better-sqlite3")) as {
		default: new (path: string) => BetterDb;
	};
	cachedDriver = {
		name: "node",
		encrypts: false,
		open: (path: string) => wrapBetter(new mod.default(path)),
	};
	return cachedDriver;
}

/** The active driver name after the first `open()` call. Useful for tests
 *  / observability. Returns null before any database has been opened. */
export function getDriverName(): DriverName | null {
	return cachedDriver?.name ?? null;
}

export async function open(path: string, options: OpenOptions = {}): Promise<SqliteDatabase> {
	const driver = await resolveDriver();
	const keyHex = options.encryptionKeyHex;

	if (driver.encrypts && driver.openRaw && path !== ":memory:") {
		if (keyHex) {
			await migrateAndVerifyEncrypted(path, keyHex, driver.openRaw);
		} else if (classifyAtRest(path, driver.openRaw) === AtRestState.Encrypted) {
			// An encrypted file opened with no key — fail closed loudly
			// rather than letting the raw driver error surface, and never
			// fall back to a plaintext read.
			throw new AtRestKeyError(pathTail(path));
		}
	}

	const db = driver.open(path);

	if (driver.encrypts && keyHex) {
		// PRAGMA key MUST be the first statement on the connection, before
		// any other access, or SQLCipher treats the DB as plaintext.
		db.exec(`PRAGMA key = "x'${keyHex}'"`);
		assertReadable(db, path);
	}

	if (options.tunePragmas !== false) {
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA synchronous = NORMAL");
		// Wait-and-retry rather than throw `SQLITE_BUSY: database is locked` when a
		// write contends with an in-flight WAL checkpoint or a burst of concurrent
		// entity writes (seen under rapid create/persist). 5s is comfortably above
		// any real contention window and well under any IPC timeout.
		db.exec("PRAGMA busy_timeout = 5000");
	}
	return db;
}

/**
 * Bench / integration seam: open via `better-sqlite3` with `sqlite-vec`
 * loaded, bypassing the Bun test driver (whose sqlite build rejects dynamic
 * extension loading). Returns `null` when the native driver or the vec
 * extension can't load — callers skip rather than fail. Mirrors the
 * production Electron path (`wrapBetter` + `loadVecExtension`).
 */
export async function openWithVecExtension(path: string): Promise<SqliteDatabase | null> {
	try {
		const mod = (await import("better-sqlite3")) as {
			default: new (path: string) => BetterDb;
		};
		const raw = new mod.default(path);
		const db = wrapBetter(raw);
		if (!db.loadVecExtension?.()) {
			db.close();
			return null;
		}
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		return db;
	} catch {
		return null;
	}
}

/**
 * Before opening keyed: if the file is a legacy plaintext DB, rekey it to
 * encrypted in place (atomic, idempotent). If it is already encrypted,
 * nothing happens. Absent files are created keyed by the open below.
 */
async function migrateAndVerifyEncrypted(
	path: string,
	keyHex: string,
	openRaw: RawOpener,
): Promise<void> {
	const rawKey = hexToBytes(keyHex);
	try {
		await migratePlaintextToEncrypted(path, rawKey, openRaw);
	} finally {
		rawKey.fill(0);
	}
}

/**
 * Fail-closed proof: a correctly-keyed connection can read `sqlite_master`.
 * A wrong/absent key makes this throw ("file is not a database"), which we
 * surface — never a silent plaintext fallback.
 */
function assertReadable(db: SqliteDatabase, path: string): void {
	try {
		db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
	} catch (error) {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		throw new AtRestKeyError(pathTail(path), { cause: error });
	}
}

function pathTail(path: string): string {
	const i = path.lastIndexOf("/");
	return i >= 0 ? path.slice(i + 1) : path;
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Driver shapes (just enough surface that we wrap below).
// ---------------------------------------------------------------------------

type BunDb = {
	exec(sql: string, ...params: unknown[]): void;
	prepare(sql: string): BunStmt;
	query(sql: string): BunStmt;
	close(): void;
	transaction<T>(fn: () => T): () => T;
};

type BunStmt = {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	finalize(): void;
};

type BetterDb = {
	exec(sql: string): void;
	prepare(sql: string): BetterStmt;
	pragma(sql: string, options?: unknown): unknown;
	close(): void;
	transaction<T>(fn: () => T): () => T;
	/** better-sqlite3 exposes a live `open` boolean on the connection. */
	open: boolean;
};

type BetterStmt = {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
};

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

function wrapBun(db: BunDb): SqliteDatabase {
	// bun:sqlite exposes no `open` flag — track it in the wrapper closure.
	let open = true;
	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => wrapBunStmt(db.prepare(sql)),
		pragma: (sql) => db.prepare(`PRAGMA ${sql}`).all(),
		transaction: (fn) => db.transaction(fn),
		close: () => {
			open = false;
			db.close();
		},
		isOpen: () => open,
	};
}

function wrapBunStmt(stmt: BunStmt): SqliteStatement {
	return {
		run: (...p) => stmt.run(...p),
		get: (...p) => stmt.get(...p) ?? undefined,
		all: (...p) => stmt.all(...p),
	};
}

const nodeRequire = createRequire(import.meta.url);

function wrapBetter(db: BetterDb): SqliteDatabase {
	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => wrapBetterStmt(db.prepare(sql)),
		pragma: (sql) => db.pragma(sql),
		transaction: (fn) => db.transaction(fn),
		close: () => db.close(),
		isOpen: () => db.open,
		loadVecExtension: () => {
			try {
				// `sqlite-vec`'s `load()` resolves the right prebuilt binary for
				// this platform/ABI and calls better-sqlite3's `loadExtension`.
				// Required lazily so the package is only resolved on the node /
				// Electron path that can actually use it.
				const sqliteVec = nodeRequire("sqlite-vec") as { load(handle: unknown): void };
				sqliteVec.load(db);
				return true;
			} catch {
				return false;
			}
		},
	};
}

function wrapBetterStmt(stmt: BetterStmt): SqliteStatement {
	return {
		run: (...p) => stmt.run(...p),
		get: (...p) => stmt.get(...p) ?? undefined,
		all: (...p) => stmt.all(...p),
	};
}

/** Un-wrapped handle for the at-rest migration. `probe` runs a statement
 *  and surfaces its error (so "file is not a database" propagates → the
 *  classifier reads it as encrypted). */
function rawBetter(db: BetterDb): SqlcipherRawHandle {
	return {
		exec: (sql) => db.exec(sql),
		probe: (sql) => db.prepare(sql).get(),
		close: () => db.close(),
	};
}

export { AtRestState, classifyAtRest };
