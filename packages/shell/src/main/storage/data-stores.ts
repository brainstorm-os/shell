/**
 * Stage 3.1+3.2 — the four primary SQLite databases for a vault.
 *
 * Layout per §Database layout:
 *
 *   <vault>/data/
 *     ├── ledger.db      (capability ledger)
 *     ├── registry.db    (installed apps + openers + blocks + types + widgets)
 *     ├── entities.db    (entities + links + change log)
 *     └── search.db      (FTS5 indexes)
 *
 * Per-DB encryption (Stage 3b) derives a distinct AES-256 key from the vault
 * master key via HKDF with a per-DB info string. Stage 3 lands the
 * infrastructure (open + migrate + close); the `PRAGMA key` integration
 * arrives with the SQLCipher-capable driver swap.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	AtRestKeyError,
	type OpenOptions,
	type SqliteDatabase,
	open as openSqlite,
} from "@brainstorm-os/sqlite";
import { AtRestDb, deriveAtRestKey, keyToHex, zeroKey } from "@brainstorm-os/sqlite/at-rest-key";
import { ACCOUNT_MIGRATIONS } from "./account-schema";
import { COOKIES_MIGRATIONS } from "./cookies-schema";
import { ENTITIES_MIGRATIONS } from "./entities-schema";
import { LEDGER_MIGRATIONS } from "./ledger-schema";
import { applyMigrations } from "./migrations";
import {
	CorruptionRecovery,
	VaultCorruptionError,
	isCorruptionError,
	recoveryForCorruptDb,
} from "./recovery-plan";
import { REGISTRY_MIGRATIONS } from "./registry-schema";
import { SEARCH_MIGRATIONS } from "./search-schema";
import { SETTINGS_MIGRATIONS } from "./settings-schema";

export type DataStoreKind =
	| "ledger"
	| "registry"
	| "entities"
	| "search"
	| "settings"
	| "cookies"
	| "account";

const FILENAMES: Record<DataStoreKind, string> = {
	ledger: "ledger.db",
	registry: "registry.db",
	entities: "entities.db",
	search: "search.db",
	settings: "settings.db",
	cookies: "cookies.db",
	account: "account.db",
};

/**
 * Move a corrupt domain DB (+ its WAL/SHM/journal sidecars) aside so a fresh,
 * empty DB is created in its place on the next `open()` — the mutating half of
 * the 12.8 "Corrupted SQLite file" recovery (doc 28), invoked ONLY after the
 * user confirms (the policy is "prompt before mutating"). We ARCHIVE (rename to
 * `<file>.corrupt-<ts>`) rather than delete, so a corrupt ledger/registry stays
 * on disk for a manual / forensic restore — "never silently overwrite". For
 * `entities`, the empty DB is repopulated from the KV/Yjs sources by the
 * session-open backfill; for `ledger`/`registry` it starts fresh. Best-effort
 * per sidecar (a missing WAL is fine). Returns the archived main-DB path.
 */
export async function archiveCorruptDb(
	vaultPath: string,
	kind: DataStoreKind,
	now: number = Date.now(),
	dataDir: string = join(vaultPath, "data"),
): Promise<string> {
	const path = join(dataDir, FILENAMES[kind]);
	const suffix = `.corrupt-${now}`;
	for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
		await rename(file, `${file}${suffix}`).catch(() => undefined);
	}
	return `${path}${suffix}`;
}

const AT_REST_DB: Record<DataStoreKind, AtRestDb> = {
	ledger: AtRestDb.Ledger,
	registry: AtRestDb.Registry,
	entities: AtRestDb.Entities,
	search: AtRestDb.Search,
	settings: AtRestDb.Settings,
	cookies: AtRestDb.Cookies,
	account: AtRestDb.Account,
};

const MIGRATIONS = {
	ledger: LEDGER_MIGRATIONS,
	registry: REGISTRY_MIGRATIONS,
	entities: ENTITIES_MIGRATIONS,
	search: SEARCH_MIGRATIONS,
	settings: SETTINGS_MIGRATIONS,
	cookies: COOKIES_MIGRATIONS,
	account: ACCOUNT_MIGRATIONS,
} as const;

export type DataStoresOptions = {
	/** Override the data directory inside the vault — used by tests. */
	dataDir?: string;
	openOptions?: OpenOptions;
	/**
	 * The vault's 32-byte master key. Each DB's at-rest key is derived from
	 * it via HKDF with a per-DB info string. The buffer is NOT retained —
	 * `DataStores` keeps a defensive copy that is zeroed on `close()`, and
	 * each derived per-DB key is zeroed immediately after `PRAGMA key`. When
	 * absent the DBs open unencrypted (legacy / pre-Stage-3b vaults and the
	 * SQLCipher-driver-unavailable gate).
	 */
	masterKey?: Uint8Array;
};

export class DataStores {
	private readonly vaultPath: string;
	private readonly dataDir: string;
	private readonly openOptions?: OpenOptions;
	private readonly masterKey: Uint8Array | null;
	private readonly opened = new Map<DataStoreKind, SqliteDatabase>();
	/**
	 * In-flight opens, keyed by kind. `open()` checks the resolved `opened`
	 * cache synchronously but then `await`s the (async) driver open + migrate —
	 * so two concurrent `open(kind)` callers BOTH miss the cache and each open a
	 * SEPARATE SQLite connection. The cache then keeps only the last; the first
	 * leaks as a *second live writer* on the same file. Under WAL that's a
	 * writer↔writer reserved-lock deadlock returning `SQLITE_BUSY: database is
	 * locked` immediately (busy_timeout can't help) — the F-278 lock that fires
	 * even on a single create, because boot fans out concurrent entities opens
	 * (search reindex + vault-entities listing + restore materialization).
	 * Memoizing the in-flight promise collapses the stampede onto one connection.
	 */
	private readonly opening = new Map<DataStoreKind, Promise<SqliteDatabase>>();
	/**
	 * Negative cache for a wrong/missing at-rest key. The session's master key
	 * is fixed for a `DataStores` instance, so once a DB fails to decrypt the
	 * answer can't change until the vault is re-keyed (which builds a NEW
	 * session → new `DataStores`). Re-attempting the open re-runs SQLCipher's
	 * intentionally-expensive KDF synchronously on the main thread; a burst of
	 * DB-backed IPC against a wrong-key vault then stacks those into a visible
	 * shell freeze. Caching the failure makes the retry fail fast, fail-closed.
	 */
	private readonly atRestKeyFailures = new Map<DataStoreKind, AtRestKeyError>();
	private closed = false;

	constructor(vaultPath: string, options: DataStoresOptions = {}) {
		this.vaultPath = vaultPath;
		this.dataDir = options.dataDir ?? join(vaultPath, "data");
		if (options.openOptions !== undefined) {
			this.openOptions = options.openOptions;
		}
		// Defensive copy: the caller (VaultSession) zeroes its master key on
		// dispose; we must not alias a buffer that gets zeroed underneath us.
		this.masterKey = options.masterKey ? new Uint8Array(options.masterKey) : null;
	}

	/**
	 * Open (or create) the database for `kind`, run any pending migrations,
	 * and return the handle. Subsequent calls return the cached handle.
	 */
	async open(kind: DataStoreKind): Promise<SqliteDatabase> {
		if (this.closed) {
			throw new Error("DataStores: cannot open() after close()");
		}
		const keyFailure = this.atRestKeyFailures.get(kind);
		if (keyFailure) throw keyFailure;
		const cached = this.opened.get(kind);
		if (cached) {
			if (cached.isOpen()) return cached;
			// The cached connection was closed out-of-band (a session teardown
			// the cache didn't observe). Returning it hands the caller a dead
			// handle that throws "database connection is not open" on first use
			// — which silently broke the dev auto-seeder mid-boot, leaving the
			// app bundles un-reinstalled. We aren't `close()`d, so the master
			// key is still live: drop the corpse and reopen below.
			this.opened.delete(kind);
		}

		// Collapse concurrent opens onto one connection (see `opening` above) —
		// without this, a boot fan-out of `open("entities")` opens N connections
		// and leaks N-1 live writers, deadlocking WAL writes (F-278).
		const inFlight = this.opening.get(kind);
		if (inFlight) return inFlight;

		const opening = (async () => {
			await mkdir(this.dataDir, { recursive: true });
			const path = join(this.dataDir, FILENAMES[kind]);
			try {
				const db = await this.openMigratedOrRecover(kind, path);
				this.opened.set(kind, db);
				return db;
			} catch (error) {
				// A wrong/missing key is deterministic for this session — cache it so
				// the next open fails fast instead of re-deriving the KDF. Corruption
				// (VaultCorruptionError) is deliberately NOT cached: the user can
				// confirm a recovery that archives the file and a retry must succeed.
				if (error instanceof AtRestKeyError) this.atRestKeyFailures.set(kind, error);
				throw error;
			} finally {
				this.opening.delete(kind);
			}
		})();
		this.opening.set(kind, opening);
		return opening;
	}

	/**
	 * Open + migrate, recovering from a corrupt file per the recovery policy
	 * (12.8, doc 28 §Recovery "Corrupted SQLite file"). A non-corruption error
	 * (migration bug, permissions) propagates unchanged.
	 */
	private async openMigratedOrRecover(kind: DataStoreKind, path: string): Promise<SqliteDatabase> {
		try {
			return await this.openAndMigrate(kind, path);
		} catch (error) {
			if (!isCorruptionError(error)) throw error;
			const recovery = recoveryForCorruptDb(kind);
			if (recovery === CorruptionRecovery.RebuildDerived) {
				// search.db is a derived FTS index — drop the malformed file(s)
				// and recreate empty; content re-indexes lazily from its sources.
				await this.removeDbFiles(path);
				return this.openAndMigrate(kind, path);
			}
			// Authoritative / source-recoverable DBs are never auto-destroyed —
			// the caller prompts (restore from backup, re-init, or a
			// confirmed rebuild-from-Yjs). Honors "prompt before mutating".
			throw new VaultCorruptionError(kind, recovery, error);
		}
	}

	private async openAndMigrate(kind: DataStoreKind, path: string): Promise<SqliteDatabase> {
		const db = await openSqlite(path, this.openOptionsFor(kind));
		try {
			await applyMigrations(db, MIGRATIONS[kind]);
		} catch (error) {
			db.close();
			throw error;
		}
		return db;
	}

	/** Delete a domain DB's file and its WAL sidecars (best-effort). */
	private async removeDbFiles(path: string): Promise<void> {
		for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
			await rm(file, { force: true });
		}
	}

	/**
	 * Build the per-DB open options: copy the caller's `openOptions` and,
	 * when a master key is present, inject the HKDF-derived per-DB at-rest
	 * key as hex. The derived key is zeroed before this returns — only the
	 * hex string transits into `open()`, which itself never logs it.
	 */
	private openOptionsFor(kind: DataStoreKind): OpenOptions {
		const base: OpenOptions = { ...this.openOptions };
		if (!this.masterKey) return base;
		const derived = deriveAtRestKey(this.masterKey, AT_REST_DB[kind]);
		try {
			base.encryptionKeyHex = keyToHex(derived);
		} finally {
			zeroKey(derived);
		}
		return base;
	}

	/** Already-opened handle, if any. Doesn't open lazily. */
	get(kind: DataStoreKind): SqliteDatabase | undefined {
		return this.opened.get(kind);
	}

	pathFor(kind: DataStoreKind): string {
		return join(this.dataDir, FILENAMES[kind]);
	}

	/** Close every opened DB. Idempotent. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const [, db] of this.opened) {
			try {
				db.close();
			} catch (error) {
				console.warn("[brainstorm] DB close failed:", error);
			}
		}
		this.opened.clear();
		if (this.masterKey) zeroKey(this.masterKey);
	}
}
