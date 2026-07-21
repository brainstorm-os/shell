/**
 * EntitiesRepository — CRUD + structured query on `entities.db`
 * (`entities` / `links` / `change_log`).
 *
 * Per the Stage 5 repository-pattern decision, all SQL for these tables
 * lives here; the entities service (Stage 9.3.1) is pure orchestration on
 * top. Properties are stored as a JSON blob; property-level predicates
 * compile to `json_extract(properties, '$.<key>')`. Property keys are
 * validated against a strict charset before being interpolated into a
 * JSON path (json paths cannot be bound parameters) — values are always
 * bound. `type` is an opaque reverse-DNS string, never dereferenced
 * (OQ-7 resolution).
 *
 * Soft-delete: `deleted_at` is stamped; reads filter `deleted_at IS NULL`.
 * Deleting an entity also soft-deletes its incident links. Every write
 * appends to `change_log` (drives the search/index pipeline + the
 * vault-entities staleness broadcast).
 */

import {
	type Comparand,
	type EntityQuery,
	LinkDirection,
	type LinkPredicate,
	type PropertyPredicate,
	isPropertyRef,
} from "@brainstorm-os/sdk-types";
import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";
import { EdgeMatch, type GraphPattern } from "../../entities/pattern";
import {
	type CompileOptions,
	type CompileResult,
	MULTI_HOP_CTE_ROW_LIMIT,
	compilePattern,
} from "../../entities/pattern-compiler";
import { AssetRefsRepository } from "./asset-refs-repo";

export type EntityRow = {
	id: string;
	type: string;
	spaceId: string | null;
	properties: Record<string, unknown>;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
};

/** A soft-deleted entity as surfaced by the shell-internal Bin (9.19):
 *  the live `EntityRow` shape plus the deletion timestamp the Bin sorts
 *  and ages by. */
export type DeletedEntityRow = EntityRow & { deletedAt: number };

export type EntityLink = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	createdAt: number;
};

/** A single solved binding of one `GraphPattern`: the entity bound to
 *  each subject (by subject name) + the link bound to each Required /
 *  Optional edge (by edge index; Optional edges that didn't bind and
 *  Forbidden edges are absent). */
export type PatternMatch = {
	subjects: Record<string, EntityRow>;
	edges: Record<number, EntityLink>;
};

/** The matched subgraph for a compiled pattern: deduped entity + link
 *  sets across every solved binding, plus the raw bindings (the Graph
 *  app's renderer derives per-subject colouring + per-match highlight
 *  from these). Shape is intentionally a superset of what the existing
 *  `vaultEntities.list()` snapshot exposes so the consumer surface is
 *  unchanged when a pattern is supplied. */
export type PatternQueryResult = {
	entities: EntityRow[];
	links: EntityLink[];
	matches: PatternMatch[];
};

/** Structured cost-cap rejection, surfaced verbatim to the Graph
 *  renderer (it shows a "Narrow the source" banner). Mirrors
 *  §Compilation. */
export type PatternCostError = {
	code: "pattern-too-expensive";
	estimatedRows: number;
	ceiling: number;
};

export type QueryPatternResult =
	| { ok: true; result: PatternQueryResult; estimatedRows: number }
	| { ok: false; compile: CompileResult & { ok: false } }
	| { ok: false; cost: PatternCostError };

export type QueryPatternOptions = CompileOptions & {
	/** Cost ceiling (estimated joined-row count). Defaults to
	 *  `GRAPH_PATTERN_COST_CEIL` env or 2,000,000 per the doc. Injected
	 *  in tests to exercise the guard deterministically. */
	costCeiling?: number;
};

/** Default estimated-row ceiling per
 *  §Compilation. Env-overridable so
 *  it can be tuned on real data without a rebuild. */
export const DEFAULT_PATTERN_COST_CEILING = ((): number => {
	const raw = Number(process.env.GRAPH_PATTERN_COST_CEIL);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2_000_000;
})();

export type CreateEntityInput = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdBy: string;
	spaceId?: string | null;
	now: number;
	/** Explicit `updated_at` for restore paths (IE-1 bundle import) that must
	 *  preserve a row's original mutation time distinct from its creation
	 *  time. Defaults to `now` (the normal create path, where the two are
	 *  equal). */
	updatedAt?: number;
	/** Per-entity DEK identifier (Stage 10.1). Stamped on the entity row
	 *  so the sync pipeline (Stage 10.3) knows which `entity_deks` row to
	 *  unwrap. `null` is the legacy / shell-internal path (kv-backfill,
	 *  shortcut-bindings singleton, root-folder bootstrap) — entities
	 *  created without a DEK row stay unencrypted; they get retro-wrapped
	 *  in a later iteration. The entities IPC service always passes a
	 *  real id minted by `EntityDekStore`. */
	dekId: string | null;
};

type DbEntityRow = {
	id: string;
	type: string;
	space_id: string | null;
	properties: string;
	created_by: string;
	created_at: number;
	updated_at: number;
};

type DbLinkRow = {
	id: string;
	source_entity_id: string;
	dest_entity_id: string;
	link_type: string;
	created_at: number;
};

const PROPERTY_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

class InvalidPropertyKeyError extends Error {
	constructor(key: string) {
		super(`invalid property key for query: ${JSON.stringify(key)}`);
		this.name = "Invalid";
	}
}

function jsonPath(key: string): string {
	if (!PROPERTY_KEY_RE.test(key)) throw new InvalidPropertyKeyError(key);
	return `$.${key}`;
}

/** Upper bound on the per-handle prepared-statement LRU. Fixed-SQL repos use a
 *  handful of distinct strings; only `query()`'s dynamic SQL can approach this,
 *  so the cap protects a long Database/Graph filtering session from unbounded
 *  native-handle retention without touching the hot fixed-SQL path. */
const STATEMENT_CACHE_LIMIT = 256;

export class EntitiesRepository {
	// Repos are created per-call (one per `stores.open("entities")`), so the
	// cache lifetime matches the underlying db handle. Caching matters: every
	// `db.prepare(...)` allocates a `sqlite3_stmt` that bun:sqlite's lazy GC
	// can hold for a long time. On a multi-thousand-row snapshot rebuild that
	// adds up to GB of native memory before any JS-side reference is dropped.
	private readonly statements = new Map<string, SqliteStatement>();
	private assetRefsRepo: AssetRefsRepository | null = null;

	constructor(private readonly db: SqliteDatabase) {}

	/** Asset-B4 — the `asset_refs` repo over this same `entities.db` handle, for
	 *  the implicit asset-ref bind writer (`entities-service.ts`). Lazily
	 *  constructed once so its prepared statements are reused across reconcile
	 *  calls in a session. */
	get assetRefs(): AssetRefsRepository {
		if (!this.assetRefsRepo) this.assetRefsRepo = new AssetRefsRepository(this.db);
		return this.assetRefsRepo;
	}

	/** Run `fn` inside a single SQLite transaction against `entities.db`.
	 *  Any throw inside `fn` rolls back every write. Used to keep the
	 *  Stage 10.1 entity-row + DEK-wrap-row writes atomic — see
	 *  `entities-service.ts` `case "create"`. */
	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn)();
	}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) {
			// Promote on hit so the LRU eviction below sheds genuinely cold SQL.
			this.statements.delete(sql);
			this.statements.set(sql, cached);
			return cached;
		}
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		// `query()` mints SQL keyed on dynamic shape (IN-clause arity, compiled
		// predicates, inlined `json_extract` order-by paths), so a long-lived
		// Database/Graph session with many filter+sort permutations would grow
		// this cache without bound. Cap it LRU — fixed-SQL repos never approach
		// the limit; the evicted statement's native handle is freed on GC once
		// the JS reference drops.
		if (this.statements.size > STATEMENT_CACHE_LIMIT) {
			const oldest = this.statements.keys().next().value;
			if (oldest !== undefined) this.statements.delete(oldest);
		}
		return prepared;
	}

	create(input: CreateEntityInput): EntityRow {
		// Normalize empty-string dekId to null — the schema doesn't reject
		// `""` and the loose contract would let a future caller silently
		// stamp a row with a FK target that can never match any
		// `entity_deks.dek_id`. Treat `""` exactly like the legacy `null`
		// path (shell-internal singletons that don't yet have a DEK row).
		const dekId = input.dekId === "" ? null : input.dekId;
		const updatedAt = input.updatedAt ?? input.now;
		this.stmt(
			"INSERT INTO entities (id, type, space_id, properties, created_by, created_at, updated_at, dek_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
		).run(
			input.id,
			input.type,
			input.spaceId ?? null,
			JSON.stringify(input.properties),
			input.createdBy,
			input.now,
			updatedAt,
			dekId,
		);
		this.recordChange(input.id, "create", 1, input.now);
		return {
			id: input.id,
			type: input.type,
			spaceId: input.spaceId ?? null,
			properties: input.properties,
			createdBy: input.createdBy,
			createdAt: input.now,
			updatedAt,
		};
	}

	/** Live (non-deleted) entity, or null. */
	get(id: string): EntityRow | null {
		const row = this.stmt(
			"SELECT id, type, space_id, properties, created_by, created_at, updated_at FROM entities WHERE id = ? AND deleted_at IS NULL",
		).get(id) as DbEntityRow | undefined;
		return row ? rowToEntity(row) : null;
	}

	/** Shallow-merge `patch` into the stored properties, bump `updated_at`,
	 *  append a change-log row. Returns the updated entity or null when the
	 *  id is missing / already deleted. */
	update(id: string, patch: Record<string, unknown>, now: number): EntityRow | null {
		const current = this.get(id);
		if (!current) return null;
		const properties = { ...current.properties, ...patch };
		this.stmt(
			"UPDATE entities SET properties = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
		).run(JSON.stringify(properties), now, id);
		this.recordChange(id, "update", this.nextVersion(id), now);
		return { ...current, properties, updatedAt: now };
	}

	/**
	 * Yield live (non-deleted) entity ids whose `dek_id` is NULL — the
	 * legacy/shell-internal singletons (root-folder bootstrap, kv-backfill,
	 * shortcut-bindings, dev seed) that were created before Stage 10.1 wrap
	 * minting was wired into the entities IPC service. Used by the one-shot
	 * retro-wrap pass that must run before the Stage 10.3 sync wire path
	 * (otherwise the wire path would either silently skip unencrypted rows
	 * or — worse — leak plaintext to the relay). The query is read-only and
	 * stable across concurrent writes: rows created with a real `dek_id`
	 * after this iteration ships are excluded by construction.
	 *
	 * Returns only ids (not full rows) — the orchestration above this layer
	 * mints a wrap per id and writes both stamp + wrap inside a single
	 * SQLite transaction, so a row's properties aren't needed here.
	 */
	listMissingDekIds(): string[] {
		const rows = this.stmt(
			"SELECT id FROM entities WHERE dek_id IS NULL AND deleted_at IS NULL ORDER BY created_at, id",
		).all() as Array<{ id: string }>;
		return rows.map((r) => r.id);
	}

	/** Count of live (non-deleted) entity rows. Stage 10.14 uses `0` as the
	 *  "empty vault" signal that makes cold restore-from-zero offerable. */
	count(): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM entities WHERE deleted_at IS NULL").get() as {
			n: number;
		};
		return row.n;
	}

	/**
	 * Live (non-deleted) entity ids whose `properties.<key>` equals `value`.
	 * Used by the seeder drain to reconcile its own output: a reseed stamps
	 * every projected entity with a seed-provenance marker, then deletes the
	 * marked ids that fell out of the latest snapshot (plan iterations that
	 * were renamed / renumbered / removed). Scoped to the marker so an entity
	 * created by hand in the app — never marked — is never returned, let alone
	 * deleted. The key is charset-validated (same rule as query paths); the
	 * value is bound.
	 */
	listIdsWithProperty(key: string, value: string): string[] {
		const path = jsonPath(key);
		const rows = this.stmt(
			`SELECT id FROM entities WHERE json_extract(properties, '${path}') = ? AND deleted_at IS NULL`,
		).all(value) as Array<{ id: string }>;
		return rows.map((r) => r.id);
	}

	/**
	 * Batched {@link listIdsWithProperty}: every live (id, value) pair whose
	 * `properties.<key>` equals any of `values`, in one scan per chunk instead
	 * of one full-table `json_extract` scan per value. The importers use this
	 * to resolve thousands of external-id dedupe keys up front (IE-5/6/7
	 * idempotent re-import) and then hit a Map in their per-entity loops.
	 * Chunked + NULL-padded like `linksFromMany` so the prepared-statement
	 * cache holds ONE entry; NULL never matches a real value. The key is
	 * charset-validated (same rule as query paths); values are always bound.
	 */
	listIdsWithPropertyIn(
		key: string,
		values: readonly string[],
	): Array<{ id: string; value: string }> {
		if (values.length === 0) return [];
		const path = jsonPath(key);
		const chunkSize = 500;
		const placeholders = new Array(chunkSize).fill("?").join(",");
		const sql = `SELECT id, json_extract(properties, '${path}') AS value FROM entities
		             WHERE json_extract(properties, '${path}') IN (${placeholders})
		               AND deleted_at IS NULL`;
		const out: Array<{ id: string; value: string }> = [];
		const padding = new Array<unknown>(chunkSize);
		for (let start = 0; start < values.length; start += chunkSize) {
			const chunk = values.slice(start, start + chunkSize);
			for (let i = 0; i < chunkSize; i += 1) padding[i] = i < chunk.length ? chunk[i] : null;
			const rows = this.stmt(sql).all(...padding) as Array<{ id: string; value: string }>;
			for (const row of rows) out.push(row);
		}
		return out;
	}

	/**
	 * Distinct `assetId` values referenced by a LIVE (non-deleted) entity —
	 * the reachable set the Files "Storage" view filters bound blobs against,
	 * so a soft-deleted (Bin) or purged upload stops counting toward vault
	 * disk. Uploads bind via `properties.assetId`; a blob with no live
	 * referrer is effectively orphaned and is hidden / collectible.
	 */
	listReferencedAssetIds(): string[] {
		const rows = this.stmt(
			"SELECT DISTINCT json_extract(properties, '$.assetId') AS assetId FROM entities WHERE deleted_at IS NULL AND json_extract(properties, '$.assetId') IS NOT NULL",
		).all() as Array<{ assetId: string }>;
		return rows.map((r) => r.assetId);
	}

	/**
	 * The live entity (id + type) that owns each referenced `assetId` — the
	 * reverse of `listReferencedAssetIds`, so the Files "Storage" view can
	 * open an upload blob in Preview. An asset is owned by a single File/v1
	 * entity; if two live entities point at the same blob the first row wins.
	 */
	listAssetOwners(): Array<{ assetId: string; id: string; type: string }> {
		return this.stmt(
			"SELECT id, type, json_extract(properties, '$.assetId') AS assetId FROM entities WHERE deleted_at IS NULL AND json_extract(properties, '$.assetId') IS NOT NULL",
		).all() as Array<{ assetId: string; id: string; type: string }>;
	}

	/**
	 * Stamp a `dek_id` onto a live entity row that doesn't yet carry one.
	 * **Idempotent** — the `dek_id IS NULL` guard makes a concurrent retry
	 * a no-op (returns false) rather than clobbering a real dekId. Caller
	 * MUST already have written the corresponding `entity_deks` row inside
	 * the same transaction (FK on `entity_deks.entity_id` requires the
	 * parent to exist; the stamp + the wrap are atomic together). Does NOT
	 * touch `updated_at` or the change log — retro-wrap is a structural
	 * encryption-at-rest migration, not a user-visible mutation.
	 */
	stampDekId(id: string, dekId: string): boolean {
		const result = this.stmt(
			"UPDATE entities SET dek_id = ? WHERE id = ? AND dek_id IS NULL AND deleted_at IS NULL",
		).run(dekId, id);
		return Number(result.changes) === 1;
	}

	/** Soft-delete the entity and its incident (source or dest) links. */
	softDelete(id: string, now: number): boolean {
		const result = this.stmt(
			"UPDATE entities SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
		).run(now, id);
		if (Number(result.changes) === 0) return false;
		this.stmt(
			"UPDATE links SET deleted_at = ? WHERE (source_entity_id = ? OR dest_entity_id = ?) AND deleted_at IS NULL",
		).run(now, id, id);
		this.recordChange(id, "delete", this.nextVersion(id), now);
		return true;
	}

	/**
	 * Soft-deleted entities, most-recently-deleted first — the shell-only
	 * Bin (9.19) listing. Read-path twin of `query` for the deleted side;
	 * the live `get`/`query` continue to exclude these.
	 */
	listDeleted(): DeletedEntityRow[] {
		const rows = this.stmt(
			"SELECT id, type, space_id, properties, created_by, created_at, updated_at, deleted_at FROM entities WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
		).all() as Array<DbEntityRow & { deleted_at: number }>;
		return rows.map((r) => ({ ...rowToEntity(r), deletedAt: r.deleted_at }));
	}

	/**
	 * Restore a soft-deleted entity (clear `deleted_at`) and re-link any of
	 * its incident links whose **other** endpoint is also live again — a
	 * link is never resurrected pointing into a still-deleted entity, so
	 * graph integrity is preserved across partial restores. Returns false
	 * when the id is missing or already live (idempotent). Records an
	 * `update` change so the index pipeline re-adds the now-live entity.
	 */
	restore(id: string, now: number): boolean {
		const result = this.stmt(
			"UPDATE entities SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
		).run(id);
		if (Number(result.changes) === 0) return false;
		this.stmt(
			`UPDATE links SET deleted_at = NULL
				 WHERE deleted_at IS NOT NULL
				   AND (source_entity_id = ? OR dest_entity_id = ?)
				   AND (SELECT deleted_at FROM entities WHERE id = links.source_entity_id) IS NULL
				   AND (SELECT deleted_at FROM entities WHERE id = links.dest_entity_id) IS NULL`,
		).run(id, id);
		this.recordChange(id, "update", this.nextVersion(id), now);
		return true;
	}

	/**
	 * Permanently purge a **soft-deleted** entity: the row, its incident
	 * links, and its change-log history. Refuses to touch a live entity
	 * (`deleted_at IS NULL`) so a Bin "delete forever" can never destroy
	 * something still in use. Idempotent — returns false when the id is
	 * absent or not in the Bin.
	 */
	hardDelete(id: string): boolean {
		const result = this.stmt("DELETE FROM entities WHERE id = ? AND deleted_at IS NOT NULL").run(id);
		if (Number(result.changes) === 0) return false;
		// Explicit, pragma-independent cleanup (the FK cascade only fires
		// when `foreign_keys` is on): incident links + the change-log tail.
		this.stmt("DELETE FROM links WHERE source_entity_id = ? OR dest_entity_id = ?").run(id, id);
		this.stmt("DELETE FROM change_log WHERE entity_id = ?").run(id);
		// Per-entity DEK rows (Stage 10.1) cascade via FK when `foreign_keys`
		// pragma is on; the explicit DELETE here mirrors the links + change_log
		// cleanup so a hard-delete is total regardless of pragma state.
		this.stmt("DELETE FROM entity_deks WHERE entity_id = ?").run(id);
		// ROT-3a-ii — the deferred-rotation mark (same pragma-independent posture).
		this.stmt("DELETE FROM pending_rotations WHERE entity_id = ?").run(id);
		return true;
	}

	query(q: EntityQuery): EntityRow[] {
		const where: string[] = ["e.deleted_at IS NULL"];
		const params: unknown[] = [];

		if (q.type !== undefined) {
			const types = Array.isArray(q.type) ? q.type : [q.type];
			if (types.length === 0) return [];
			where.push(`e.type IN (${types.map(() => "?").join(", ")})`);
			params.push(...types);
		}
		if (q.spaceId !== undefined) {
			const spaces = Array.isArray(q.spaceId) ? q.spaceId : [q.spaceId];
			if (spaces.length === 0) return [];
			where.push(`e.space_id IN (${spaces.map(() => "?").join(", ")})`);
			params.push(...spaces);
		}
		if (typeof q.text === "string" && q.text.trim() !== "") {
			where.push("lower(e.properties) LIKE ?");
			params.push(`%${q.text.trim().toLowerCase()}%`);
		}
		if (q.where) {
			const compiled = compilePredicate(q.where);
			where.push(compiled.sql);
			params.push(...compiled.params);
		}
		if (q.link) {
			const compiled = compileLinkPredicate(q.link);
			where.push(compiled.sql);
			params.push(...compiled.params);
		}

		let sql = `SELECT e.id, e.type, e.space_id, e.properties, e.created_by, e.created_at, e.updated_at FROM entities e WHERE ${where.join(" AND ")}`;

		if (q.orderBy && q.orderBy.length > 0) {
			const order = q.orderBy
				.map((o) => {
					const dir = o.direction === "desc" ? "DESC" : "ASC";
					if (o.property === "updatedAt") return `e.updated_at ${dir}`;
					if (o.property === "createdAt") return `e.created_at ${dir}`;
					return `json_extract(e.properties, '${jsonPath(o.property)}') ${dir}`;
				})
				.join(", ");
			sql += ` ORDER BY ${order}`;
		} else {
			sql += " ORDER BY e.updated_at DESC";
		}
		if (typeof q.limit === "number" && Number.isFinite(q.limit) && q.limit >= 0) {
			sql += " LIMIT ?";
			params.push(Math.floor(q.limit));
		}

		const rows = this.stmt(sql).all(...params) as DbEntityRow[];
		return rows.map(rowToEntity);
	}

	/**
	 * Live entity ids whose serialized property bag contains `targetId` —
	 * the candidate referrer set for the F-158 merge's ref rewrite. Entity
	 * ids are opaque unique strings, so a raw `instr` over the JSON blob is
	 * a safe superset filter (the pure `rewriteEntityRefs` walk upstream
	 * only rewrites exact value equality); `instr` with a bound needle also
	 * sidesteps LIKE-escaping. The target itself is excluded.
	 */
	listReferrerIds(targetId: string): string[] {
		const rows = this.stmt(
			"SELECT id FROM entities WHERE deleted_at IS NULL AND id != ? AND instr(properties, ?) > 0 ORDER BY created_at, id",
		).all(targetId, targetId) as Array<{ id: string }>;
		return rows.map((r) => r.id);
	}

	/**
	 * Repoint every LIVE link incident to `fromId` onto `toId` (the F-158
	 * merge's link rewrite). A link whose rewrite would self-loop
	 * (`toId → toId`), or that duplicates an existing live
	 * (source, dest, linkType) triple, is soft-deleted instead of moved —
	 * graph integrity over row preservation. Runs in one transaction;
	 * returns the number of rows touched (moved + collapsed).
	 */
	repointLinks(fromId: string, toId: string, now: number): number {
		return this.transaction(() => {
			const rows = this.stmt(
				"SELECT id, source_entity_id, dest_entity_id, link_type, created_at FROM links WHERE (source_entity_id = ? OR dest_entity_id = ?) AND deleted_at IS NULL",
			).all(fromId, fromId) as DbLinkRow[];
			let touched = 0;
			for (const row of rows) {
				const source = row.source_entity_id === fromId ? toId : row.source_entity_id;
				const dest = row.dest_entity_id === fromId ? toId : row.dest_entity_id;
				const duplicate = this.stmt(
					"SELECT id FROM links WHERE source_entity_id = ? AND dest_entity_id = ? AND link_type = ? AND deleted_at IS NULL AND id != ? LIMIT 1",
				).get(source, dest, row.link_type, row.id) as { id: string } | undefined;
				if (source === dest || duplicate) {
					this.stmt("UPDATE links SET deleted_at = ? WHERE id = ?").run(now, row.id);
				} else {
					this.stmt("UPDATE links SET source_entity_id = ?, dest_entity_id = ? WHERE id = ?").run(
						source,
						dest,
						row.id,
					);
				}
				touched += 1;
			}
			return touched;
		});
	}

	putLink(link: EntityLink): void {
		this.stmt(
			"INSERT OR REPLACE INTO links (id, source_entity_id, dest_entity_id, link_type, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)",
		).run(link.id, link.sourceEntityId, link.destEntityId, link.linkType, link.createdAt);
	}

	deleteLink(id: string, now: number): boolean {
		const result = this.stmt(
			"UPDATE links SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
		).run(now, id);
		return Number(result.changes) > 0;
	}

	/** Live outgoing links for an entity. */
	linksFrom(entityId: string): EntityLink[] {
		const rows = this.stmt(
			"SELECT id, source_entity_id, dest_entity_id, link_type, created_at FROM links WHERE source_entity_id = ? AND deleted_at IS NULL ORDER BY created_at",
		).all(entityId) as DbLinkRow[];
		return rows.map(rowToLink);
	}

	/**
	 * Live outgoing links for many entities in one query. Replaces the
	 * caller-side N+1 loop in `vault-entities-service.collectSharedEntities`
	 * (snapshot a thousand-row vault → one query instead of a thousand).
	 *
	 * Batched in chunks below SQLite's compile-time parameter ceiling
	 * (`SQLITE_MAX_VARIABLE_NUMBER`; defaults vary by build — 999 on older
	 * builds, 32766 on newer). 500 leaves plenty of headroom on every
	 * supported driver. An empty input is an empty result (no query run).
	 */
	linksFromMany(entityIds: readonly string[]): EntityLink[] {
		if (entityIds.length === 0) return [];
		const chunkSize = 500;
		// Always pad to the full chunk shape with NULL sentinels so the SQL
		// text is identical for every call — the prepared-statement cache
		// stores one entry instead of one per partial chunk size. NULL never
		// matches a real entity id, so the padding never broadens results.
		const placeholders = new Array(chunkSize).fill("?").join(",");
		const sql = `SELECT id, source_entity_id, dest_entity_id, link_type, created_at
		             FROM links
		             WHERE source_entity_id IN (${placeholders})
		               AND deleted_at IS NULL
		             ORDER BY source_entity_id, created_at`;
		const out: EntityLink[] = [];
		const padding = new Array<unknown>(chunkSize);
		for (let start = 0; start < entityIds.length; start += chunkSize) {
			const chunk = entityIds.slice(start, start + chunkSize);
			for (let i = 0; i < chunkSize; i += 1) padding[i] = i < chunk.length ? chunk[i] : null;
			const rows = this.stmt(sql).all(...padding) as DbLinkRow[];
			for (const row of rows) out.push(rowToLink(row));
		}
		return out;
	}

	/**
	 * Live entity ids whose type is in `types` — the `ListSource` `byType`
	 * fast path (rides `idx_entities_type`). Chunked + NULL-padded like
	 * `linksFromMany` so the prepared-statement cache holds ONE entry.
	 */
	idsByTypes(types: readonly string[]): string[] {
		if (types.length === 0) return [];
		const chunkSize = 64;
		const placeholders = new Array(chunkSize).fill("?").join(",");
		const sql = `SELECT id FROM entities WHERE type IN (${placeholders}) AND deleted_at IS NULL`;
		const out: string[] = [];
		const padding = new Array<unknown>(chunkSize);
		for (let start = 0; start < types.length; start += chunkSize) {
			const chunk = types.slice(start, start + chunkSize);
			for (let i = 0; i < chunkSize; i += 1) padding[i] = i < chunk.length ? chunk[i] : null;
			const rows = this.stmt(sql).all(...padding) as Array<{ id: string }>;
			for (const row of rows) out.push(row.id);
		}
		return out;
	}

	/**
	 * Live ids reachable over `linkType` links from any of `anchors` — the
	 * `ListSource` `byLink` fast path. `Out` returns destinations of links
	 * whose source is an anchor (`idx_links_source`); `In` returns sources
	 * of links whose dest is an anchor (`idx_links_dest`). Implicit OR
	 * across anchors, mirroring the SDK evaluator.
	 */
	idsByLink(anchors: readonly string[], linkType: string, direction: LinkDirection): string[] {
		if (anchors.length === 0) return [];
		const chunkSize = 128;
		const anchorCol = direction === LinkDirection.Out ? "source_entity_id" : "dest_entity_id";
		const resultCol = direction === LinkDirection.Out ? "dest_entity_id" : "source_entity_id";
		const placeholders = new Array(chunkSize).fill("?").join(",");
		const sql = `SELECT DISTINCT ${resultCol} AS id FROM links
		             WHERE link_type = ? AND ${anchorCol} IN (${placeholders}) AND deleted_at IS NULL`;
		const out: string[] = [];
		const padding = new Array<unknown>(chunkSize);
		for (let start = 0; start < anchors.length; start += chunkSize) {
			const chunk = anchors.slice(start, start + chunkSize);
			for (let i = 0; i < chunkSize; i += 1) padding[i] = i < chunk.length ? chunk[i] : null;
			const rows = this.stmt(sql).all(linkType, ...padding) as Array<{ id: string }>;
			for (const row of rows) out.push(row.id);
		}
		return out;
	}

	/**
	 * Compile a `GraphPattern` to a single SQL JOIN and execute it,
	 * returning the matched subgraph. This is the only place the compiled
	 * pattern SQL is `prepare()`d / run — feature code (the entities
	 * service) calls this typed method and never sees SQL (Stage 5
	 * repository-pattern rule).
	 *
	 * Cost-cap guard (§Compilation):
	 * before executing, a rough joined-row estimate is computed as the
	 * product of each subject's live candidate count (a `COUNT(*)` over
	 * `entities` constrained by the subject's type set), multiplied up by
	 * a per-edge fan-out factor for non-Forbidden edges and discounted by
	 * the EXPLAIN QUERY PLAN's use of an index per join. If the estimate
	 * exceeds the ceiling the query is rejected with a structured
	 * `pattern-too-expensive` error (the renderer shows a "Narrow the
	 * source" banner) — it is never executed, so a pathological pattern
	 * can't pin the main process.
	 */
	queryPattern(pattern: GraphPattern, options: QueryPatternOptions = {}): QueryPatternResult {
		const compiled = compilePattern(pattern, options);
		if (!compiled.ok) return { ok: false, compile: compiled };

		const ceiling = options.costCeiling ?? DEFAULT_PATTERN_COST_CEILING;
		const estimatedRows = this.estimatePatternCost(pattern, compiled.sql, compiled.params);
		if (estimatedRows > ceiling) {
			return {
				ok: false,
				cost: { code: "pattern-too-expensive", estimatedRows, ceiling },
			};
		}

		const rows = this.stmt(compiled.sql).all(...compiled.params) as Array<Record<string, unknown>>;
		return {
			ok: true,
			estimatedRows,
			result: decodePatternRows(rows, pattern, compiled.rowShape),
		};
	}

	/**
	 * Rough joined-row estimate. SQLite's `EXPLAIN QUERY PLAN` exposes no
	 * numeric row counts (only a `detail` string), so the estimate is
	 * structural: per-subject live candidate count (constrained by the
	 * subject's type set) multiplied across subjects, then discounted when
	 * the planner reports an index SEARCH (vs a full SCAN) for that join.
	 * Deterministic + testable, and conservative (it never under-counts a
	 * full-scan join), which is what the guard needs.
	 *
	 * Multi-hop edges (Stage 9.13.4) compile to a recursive CTE that seeds
	 * from the ENTIRE links table for the edge's link types — an optimization
	 * fence, so the subject predicates never push down into it. The subject
	 * product alone is therefore blind to the CTE's own row explosion: a
	 * pattern with tiny subject sets but a dense link graph would pass this
	 * preflight then blow up on execution. Each non-Optional multi-hop edge
	 * adds a breadth term — its live link-candidate count times `maxHops`,
	 * additive to the joined-row product because the intermediate materializes
	 * independently of the subject join — capped at the same in-CTE LIMIT the
	 * compiler enforces, so the estimate and the real ceiling agree.
	 */
	private estimatePatternCost(
		pattern: GraphPattern,
		sql: string,
		params: readonly unknown[],
	): number {
		let estimate = 1;
		for (const subject of Object.values(pattern.subjects)) {
			estimate *= this.subjectCandidateCount(subject.types);
			if (estimate === 0) return 0;
			if (estimate > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
		}
		for (const edge of pattern.edges) {
			const [, maxHops] = edge.hops;
			if (maxHops <= 1 || edge.match === EdgeMatch.Optional) continue;
			const breadth = this.linkCandidateCount(edge.linkTypes) * maxHops;
			estimate += Math.min(breadth, MULTI_HOP_CTE_ROW_LIMIT);
			if (estimate > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
		}
		let scanPenalty = 1;
		try {
			const plan = this.stmt(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
				detail?: unknown;
			}>;
			for (const step of plan) {
				const detail = typeof step.detail === "string" ? step.detail : "";
				// A full SCAN of entities/links (no usable index) multiplies
				// the real cost; reflect that so the guard fires earlier on
				// unindexable patterns. An index SEARCH leaves the estimate.
				if (/^SCAN (entities|links)\b/.test(detail)) scanPenalty *= 4;
			}
		} catch {
			// EXPLAIN unsupported / failed — fall back to the structural
			// product alone rather than letting the query through ungated.
		}
		const total = estimate * scanPenalty;
		return total > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Math.ceil(total);
	}

	private subjectCandidateCount(types: readonly string[]): number {
		if (types.length === 0) {
			const row = this.db
				.prepare("SELECT COUNT(*) AS c FROM entities WHERE deleted_at IS NULL")
				.get() as { c: number } | undefined;
			return row?.c ?? 0;
		}
		const placeholders = types.map(() => "?").join(", ");
		const row = this.stmt(
			`SELECT COUNT(*) AS c FROM entities WHERE deleted_at IS NULL AND type IN (${placeholders})`,
		).get(...types) as { c: number } | undefined;
		return row?.c ?? 0;
	}

	/** Live links of the given link types — the seed breadth of a multi-hop
	 *  edge's recursive CTE, which the structural subject product can't see. */
	private linkCandidateCount(linkTypes: readonly string[]): number {
		if (linkTypes.length === 0) return 0;
		const placeholders = linkTypes.map(() => "?").join(", ");
		const row = this.stmt(
			`SELECT COUNT(*) AS c FROM links WHERE deleted_at IS NULL AND link_type IN (${placeholders})`,
		).get(...linkTypes) as { c: number } | undefined;
		return row?.c ?? 0;
	}

	private nextVersion(entityId: string): number {
		const row = this.stmt(
			"SELECT COALESCE(MAX(change_version), 0) AS v FROM change_log WHERE entity_id = ?",
		).get(entityId) as { v: number } | undefined;
		return (row?.v ?? 0) + 1;
	}

	private recordChange(
		entityId: string,
		kind: "create" | "update" | "delete",
		version: number,
		now: number,
	): void {
		this.stmt(
			"INSERT INTO change_log (entity_id, change_kind, change_version, recorded_at) VALUES (?, ?, ?, ?)",
		).run(entityId, kind, version, now);
	}
}

function rowToEntity(row: DbEntityRow): EntityRow {
	let properties: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(row.properties) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			properties = parsed as Record<string, unknown>;
		}
	} catch {
		// Corrupt row — treat as empty rather than failing the whole query.
	}
	return {
		id: row.id,
		type: row.type,
		spaceId: row.space_id,
		properties,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function rowToLink(row: DbLinkRow): EntityLink {
	return {
		id: row.id,
		sourceEntityId: row.source_entity_id,
		destEntityId: row.dest_entity_id,
		linkType: row.link_type,
		createdAt: row.created_at,
	};
}

function parseProperties(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string") return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Corrupt blob — empty rather than fail the whole pattern result.
	}
	return {};
}

/**
 * Fold the flat JOIN result-set (one row per solved binding, columns
 * prefixed per the compiler's `RowShape`) into the deduped subgraph the
 * Graph renderer consumes plus the raw per-binding matches. Entities are
 * deduped by id (the same entity binds many rows); links likewise.
 */
function decodePatternRows(
	rows: ReadonlyArray<Record<string, unknown>>,
	pattern: GraphPattern,
	rowShape: { subjects: Record<string, string>; edges: Record<number, string | null> },
): PatternQueryResult {
	const entities = new Map<string, EntityRow>();
	const links = new Map<string, EntityLink>();
	const matches: PatternMatch[] = [];

	for (const row of rows) {
		const matchSubjects: Record<string, EntityRow> = {};
		for (const [subjectName, alias] of Object.entries(rowShape.subjects)) {
			const id = row[`${alias}_id`];
			if (typeof id !== "string" || id === "") continue;
			const entity: EntityRow = {
				id,
				type: String(row[`${alias}_type`] ?? ""),
				spaceId: null,
				properties: parseProperties(row[`${alias}_props`]),
				createdBy: String(row[`${alias}_createdby`] ?? ""),
				createdAt: Number(row[`${alias}_created`] ?? 0),
				updatedAt: Number(row[`${alias}_updated`] ?? 0),
			};
			matchSubjects[subjectName] = entity;
			if (!entities.has(id)) entities.set(id, entity);
		}

		const matchEdges: Record<number, EntityLink> = {};
		for (let i = 0; i < pattern.edges.length; i += 1) {
			const col = rowShape.edges[i];
			if (!col) continue; // Forbidden edge — no row column.
			const linkAlias = col.replace(/_id$/, "");
			const linkId = row[`${linkAlias}_id`];
			if (typeof linkId !== "string" || linkId === "") continue; // unbound Optional
			const link: EntityLink = {
				id: linkId,
				sourceEntityId: String(row[`${linkAlias}_src`] ?? ""),
				destEntityId: String(row[`${linkAlias}_dst`] ?? ""),
				linkType: String(row[`${linkAlias}_ltype`] ?? ""),
				createdAt: Number(row[`${linkAlias}_lcreated`] ?? 0),
			};
			matchEdges[i] = link;
			if (!links.has(linkId)) links.set(linkId, link);
		}

		matches.push({ subjects: matchSubjects, edges: matchEdges });
	}

	return {
		entities: [...entities.values()],
		links: [...links.values()],
		matches,
	};
}

type Compiled = { sql: string; params: unknown[] };

function compilePredicate(pred: PropertyPredicate): Compiled {
	if ("$and" in pred) {
		const parts = pred.$and.map(compilePredicate);
		return {
			sql: `(${parts.map((p) => p.sql).join(" AND ")})`,
			params: parts.flatMap((p) => p.params),
		};
	}
	if ("$or" in pred) {
		const parts = pred.$or.map(compilePredicate);
		return {
			sql: `(${parts.map((p) => p.sql).join(" OR ")})`,
			params: parts.flatMap((p) => p.params),
		};
	}
	if ("$eq" in pred) {
		const entries = Object.entries(pred.$eq);
		if (entries.length === 0) return { sql: "1 = 1", params: [] };
		const clauses: string[] = [];
		const params: unknown[] = [];
		for (const [k, rhs] of entries) {
			const left = `json_extract(e.properties, '${jsonPath(k)}')`;
			if (isPropertyRef(rhs)) {
				if ("$now" in rhs) {
					clauses.push(`${left} = ?`);
					params.push(Date.now());
				} else {
					clauses.push(`${left} = json_extract(e.properties, '${jsonPath(rhs.$prop)}')`);
				}
			} else {
				clauses.push(`${left} = ?`);
				params.push(rhs);
			}
		}
		return { sql: `(${clauses.join(" AND ")})`, params };
	}
	if ("$contains" in pred) {
		return conjunction(
			pred.$contains,
			(path) => `lower(json_extract(e.properties, '${path}')) LIKE ?`,
			(v) => `%${String(v).toLowerCase()}%`,
		);
	}
	if ("$gt" in pred) return compileComparison(pred.$gt, ">");
	if ("$lt" in pred) return compileComparison(pred.$lt, "<");
	if ("$exists" in pred) {
		const keys = Object.keys(pred.$exists);
		return {
			sql: `(${keys.map((k) => `json_extract(e.properties, '${jsonPath(k)}') IS NOT NULL`).join(" AND ")})`,
			params: [],
		};
	}
	// Unknown predicate shape — match nothing rather than everything.
	return { sql: "0 = 1", params: [] };
}

/** A comparison's left/right operand, unwrapping a property-ui `DateValue`
 *  `{at}` to its ms via COALESCE (falling back to the bare cell) so date cells
 *  order numerically — mirrors the evaluator's `asComparable` (9.12.21). */
function jsonAtOrSelf(key: string): string {
	const p = jsonPath(key);
	return `COALESCE(json_extract(e.properties, '${p}.at'), json_extract(e.properties, '${p}'))`;
}

/** Compile an ordering op (`$gt`/`$lt`) whose right-hand side may be a literal,
 *  the clock (`$now`), or another property (`$prop`) — see `Comparand`. */
function compileComparison(obj: Record<string, Comparand>, op: ">" | "<"): Compiled {
	const entries = Object.entries(obj);
	if (entries.length === 0) return { sql: "1 = 1", params: [] };
	const clauses: string[] = [];
	const params: unknown[] = [];
	for (const [k, rhs] of entries) {
		let right: string;
		if (isPropertyRef(rhs)) {
			if ("$now" in rhs) {
				right = "?";
				params.push(Date.now());
			} else {
				right = `CAST(${jsonAtOrSelf(rhs.$prop)} AS REAL)`;
			}
		} else {
			right = "?";
			params.push(rhs);
		}
		clauses.push(`CAST(${jsonAtOrSelf(k)} AS REAL) ${op} ${right}`);
	}
	return { sql: `(${clauses.join(" AND ")})`, params };
}

function conjunction(
	obj: Record<string, unknown>,
	clause: (path: string) => string,
	transform: (v: unknown) => unknown = (v) => v,
): Compiled {
	const keys = Object.keys(obj);
	if (keys.length === 0) return { sql: "1 = 1", params: [] };
	return {
		sql: `(${keys.map((k) => clause(jsonPath(k))).join(" AND ")})`,
		params: keys.map((k) => transform(obj[k])),
	};
}

function compileLinkPredicate(link: LinkPredicate): Compiled {
	const conds: string[] = ["l.deleted_at IS NULL", "l.source_entity_id = e.id"];
	const params: unknown[] = [];
	if (link.type !== undefined) {
		conds.push("l.link_type = ?");
		params.push(link.type);
	}
	if (link.source !== undefined) {
		conds.push("l.source_entity_id = ?");
		params.push(link.source);
	}
	if (link.dest !== undefined) {
		conds.push("l.dest_entity_id = ?");
		params.push(link.dest);
	}
	return {
		sql: `EXISTS (SELECT 1 FROM links l WHERE ${conds.join(" AND ")})`,
		params,
	};
}
