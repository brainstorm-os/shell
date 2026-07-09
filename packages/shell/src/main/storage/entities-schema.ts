/**
 * `entities.db` schema — entities, links, property index, the change-log
 * that drives the FTS5 and vector indexing pipelines, and (v2) the
 * per-entity DEK wrap-table that backs G2 sync.
 *
 * Per §Schema (entities.db):
 *   - `entities` — canonical record per entity; properties as JSON.
 *   - `links` — typed edges between entities.
 *   - `change_log` — write-time append for indexing workers to consume.
 *
 * Property-level queries use `json_extract(properties, '$.field')` with
 * indexes materialized lazily for types whose schemas mark fields searchable.
 * Stage 3 lands the base tables; subscription-driven indexing and selective
 * property indexes arrive in Stage 9 (entities service / queries).
 *
 * Per §"Per-entity DEK", the
 * `entities` row carries the live `dek_id`; the wrapped DEK (sealed under
 * the vault master key) lives in the `entity_deks` table added in v2 (Stage
 * 10.1). Multi-row support is forward-allocated for the rotation path
 * (Stage 10.2 / OQ-27); 10.1 writes exactly one row per entity at create.
 */

import { COMPANY_TYPE, planCompanyMigration } from "../entities/company-migration";
import type { SqliteMigration } from "./migrations";
import { migrateLegacySelectValues } from "./select-value-migration";

export const ENTITIES_MIGRATIONS: SqliteMigration[] = [
	{
		version: 1,
		description: "entities.db v1 — entities + links + change_log",
		up: (db) => {
			db.exec(`
				CREATE TABLE entities (
					id            TEXT PRIMARY KEY,
					type          TEXT NOT NULL,
					space_id      TEXT,
					properties    TEXT NOT NULL,
					created_by    TEXT NOT NULL,
					created_at    INTEGER NOT NULL,
					updated_at    INTEGER NOT NULL,
					dek_id        TEXT,
					deleted_at    INTEGER
				);
				CREATE INDEX idx_entities_type ON entities(type) WHERE deleted_at IS NULL;
				CREATE INDEX idx_entities_updated ON entities(updated_at) WHERE deleted_at IS NULL;
				CREATE INDEX idx_entities_space ON entities(space_id) WHERE deleted_at IS NULL;

				CREATE TABLE links (
					id                 TEXT PRIMARY KEY,
					source_entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
					dest_entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
					link_type          TEXT NOT NULL,
					created_at         INTEGER NOT NULL,
					deleted_at         INTEGER
				);
				CREATE INDEX idx_links_source ON links(source_entity_id, link_type) WHERE deleted_at IS NULL;
				CREATE INDEX idx_links_dest ON links(dest_entity_id, link_type) WHERE deleted_at IS NULL;
				CREATE INDEX idx_links_type ON links(link_type) WHERE deleted_at IS NULL;

				CREATE TABLE change_log (
					seq            INTEGER PRIMARY KEY AUTOINCREMENT,
					entity_id      TEXT NOT NULL,
					change_kind    TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'delete')),
					change_version INTEGER NOT NULL,
					recorded_at    INTEGER NOT NULL
				);
				CREATE INDEX idx_change_log_entity ON change_log(entity_id);
			`);
		},
	},
	{
		version: 2,
		description: "entities.db v2 — entity_deks (per-entity wrapped DEKs, Stage 10.1)",
		up: (db) => {
			// Per §3.1 + §5 (10.1):
			// the DEK is XChaCha20-Poly1305 256-bit, sealed at-rest under the
			// vault master key. `sealed_dek_json` is the JSON-encoded
			// `SealedSecret` (`{v, nonceB64, ciphertextB64}`). `version` is
			// forward-allocated for the rotation path (Stage 10.2 / OQ-27);
			// 10.1 only writes version=1. Cascade on entity hard-delete so a
			// purged entity can't leak its wrap-row.
			db.exec(`
				CREATE TABLE entity_deks (
					dek_id          TEXT PRIMARY KEY,
					entity_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
					version         INTEGER NOT NULL DEFAULT 1,
					sealed_dek_json TEXT NOT NULL,
					created_at      INTEGER NOT NULL
				);
				CREATE INDEX idx_entity_deks_entity ON entity_deks(entity_id);
			`);
		},
	},
	{
		version: 3,
		description: "entities.db v3 — binary asset store (assets + asset_deks + asset_refs)",
		up: (db) => {
			// Encrypted binary-asset subsystem (favicon / cover / future
			// uploads). Per the asset-subsystem design: each asset blob lives
			// off-DB at `<vault>/data/assets/<prefix>/<asset_id>.enc`, sealed
			// under a fresh per-asset DEK (XChaCha20-Poly1305) that is itself
			// wrapped under the vault master key in `asset_deks` — exactly the
			// `entity_deks` shape, AAD-bound to the asset id via a DISTINCT
			// domain prefix (`brainstorm/asset-dek/v1:`).
			//
			// Per-asset RANDOM keys (not convergent content-addressing): two
			// byte-identical favicons produce two assets with two ciphertexts,
			// so the structurally-blind sync relay cannot learn plaintext
			// equality (which would fingerprint which sites a user bookmarked).
			// `content_hash` is a LOCAL-ONLY dedupe hint (plaintext sha256) and
			// never crosses the wire; the on-disk filename is the random
			// asset_id, never the content hash (OQ-236).
			//
			// `asset_refs` binds an asset to its owning entity (favicon/cover/
			// inline) with ON DELETE CASCADE, so deleting the owner drops the
			// ref and the GC sweep can reclaim a now-unreferenced asset
			// (§attachment GC).
			db.exec(`
				CREATE TABLE assets (
					asset_id      TEXT PRIMARY KEY,
					dek_id        TEXT NOT NULL,
					content_hash  TEXT NOT NULL,
					mime          TEXT NOT NULL,
					byte_len      INTEGER NOT NULL,
					kind          TEXT NOT NULL,
					origin_url    TEXT,
					created_at    INTEGER NOT NULL,
					bound_at      INTEGER
				);
				CREATE INDEX idx_assets_content ON assets(content_hash);
				CREATE INDEX idx_assets_unbound ON assets(created_at) WHERE bound_at IS NULL;

				CREATE TABLE asset_deks (
					dek_id          TEXT PRIMARY KEY,
					asset_id        TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
					version         INTEGER NOT NULL DEFAULT 1,
					sealed_dek_json TEXT NOT NULL,
					created_at      INTEGER NOT NULL
				);
				CREATE INDEX idx_asset_deks_asset ON asset_deks(asset_id);

				CREATE TABLE asset_refs (
					entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
					asset_id    TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
					role        TEXT NOT NULL,
					created_at  INTEGER NOT NULL,
					PRIMARY KEY (entity_id, asset_id, role)
				);
				CREATE INDEX idx_asset_refs_asset ON asset_refs(asset_id);
			`);
		},
	},
	{
		version: 4,
		description: "entities.db v4 — re-type journal entries to io.brainstorm.journal/Entry/v1",
		up: (db) => {
			// Journal entries used to share the Notes object type, so they
			// leaked into the Notes app's `{ type: Note/v1 }` list. They now
			// carry their own type. Re-type the existing rows by their stable
			// `journal-YYYY-MM-DD` id (GLOB pins the exact date shape so a user
			// note that merely starts with "journal-" is never caught); the
			// body / links are untouched, only the object type + owner change.
			db
				.prepare(
					`UPDATE entities
				 SET type = 'io.brainstorm.journal/Entry/v1', created_by = 'io.brainstorm.journal'
				 WHERE type = 'io.brainstorm.notes/Note/v1'
				   AND id GLOB 'journal-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
				)
				.run();
		},
	},
	{
		version: 5,
		description: "entities.db v5 — promote Person.company string to a Company/v1 entity ref",
		up: (db) => {
			// `Person.company` used to be free text, so two people at the same
			// employer were only joined by an inferred shared-attribute edge —
			// invisible and easily mistaken for a real link. Promote each
			// distinct company name to a `Company/v1` entity and re-point every
			// person at it, so the catalog-driven reference derivation draws an
			// honest `Person → Company` edge through one shared hub node. The
			// planner (`company-migration`) keeps the decision pure + tested;
			// this applies it. Idempotent: values already pointing at a Company
			// id are left alone.
			const persons = db
				.prepare(
					`SELECT id, json_extract(properties, '$.company') AS company, updated_at AS updatedAt
					 FROM entities
					 WHERE type = 'brainstorm/Person/v1' AND deleted_at IS NULL`,
				)
				.all() as Array<{ id: string; company: unknown; updatedAt: number }>;
			if (persons.length === 0) return;

			const existing = new Set(
				(
					db
						.prepare("SELECT id FROM entities WHERE type = ? AND deleted_at IS NULL")
						.all(COMPANY_TYPE) as Array<{ id: string }>
				).map((r) => r.id),
			);

			const plan = planCompanyMigration(persons, existing);
			if (plan.companies.length === 0 && plan.updates.length === 0) return;

			const now = Date.now();
			const insert = db.prepare(
				`INSERT OR IGNORE INTO entities
				 (id, type, space_id, properties, created_by, created_at, updated_at, dek_id, deleted_at)
				 VALUES (?, ?, NULL, ?, 'io.brainstorm.contacts', ?, ?, NULL, NULL)`,
			);
			for (const company of plan.companies) {
				insert.run(company.id, COMPANY_TYPE, JSON.stringify({ name: company.name }), now, now);
			}
			const update = db.prepare(
				`UPDATE entities SET properties = json_set(properties, '$.company', ?), updated_at = ?
				 WHERE id = ?`,
			);
			for (const u of plan.updates) update.run(u.companyId, now, u.personId);
		},
	},
	{
		version: 6,
		description: "entities.db v6 — rewrite legacy di-dict-task-* select values to the bare key",
		up: (db) => {
			// Select values store the option id; a system option's id is now its
			// semantic key. Old dev seeds built ids as `di-dict-task-status-done`,
			// so a select edited through the cell back then holds an id that no
			// longer matches the dictionary. Rewrite those to the key. The `LIKE`
			// pre-filter keeps this off the hot path for vaults that never had one.
			const rows = db
				.prepare(
					`SELECT id, properties FROM entities
					 WHERE deleted_at IS NULL AND properties LIKE '%di-dict-task-%'`,
				)
				.all() as Array<{ id: string; properties: string }>;
			if (rows.length === 0) return;
			const update = db.prepare("UPDATE entities SET properties = ? WHERE id = ?");
			for (const row of rows) {
				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(row.properties) as Record<string, unknown>;
				} catch {
					continue;
				}
				const result = migrateLegacySelectValues(parsed);
				if (result.changed) update.run(JSON.stringify(result.properties), row.id);
			}
		},
	},
	{
		version: 7,
		description: "entities.db v7 — asset_refs.rehomed_at marker (Asset-B1 DEK re-homing)",
		up: (db) => {
			// Asset-B1 — the open-time pass that re-homes a per-asset DEK from the
			// vault-master-key wrap (`asset_deks`) into the referencing entity's
			// Y.Doc (sealed under the entity DEK) stamps `rehomed_at` once a
			// (entity, asset) ref's DEK has been installed on the doc. NULL ⇒ not
			// yet re-homed; the pass enumerates only NULL rows so steady-state boot
			// is a single empty-result query (the schema is the idempotency marker,
			// exactly like the 10.x retro-wrap null-DEK drain). This is LOCAL
			// derived state — it never syncs and never crosses the wire.
			db.exec("ALTER TABLE asset_refs ADD COLUMN rehomed_at INTEGER");
		},
	},
	{
		version: 8,
		description: "entities.db v8 — pending_rotations (ROT-3a-ii deferred-rotation resume)",
		up: (db) => {
			// ROT-3a-ii (design 73, F-ROT-4) — the durable queue of entities whose
			// rotate-on-revoke minted a fresh DEK but couldn't finish the WIRE
			// delivery (the survivor inbox `WrapBootstrap` + full-state re-emit)
			// because there was no relay (offline revoke) or the emit threw. One
			// row per entity; the drain (on relay-connect + boot) re-runs the wire
			// delivery for each and deletes the row on success. `dek_version` is the
			// ordinal the mint produced — carried so the drain can assert it is
			// still current before re-emitting (a later rotation supersedes it and
			// the stale row is dropped). LOCAL derived state — never syncs, never
			// crosses the wire (the same posture as asset_refs.rehomed_at).
			db.exec(`
				CREATE TABLE pending_rotations (
					entity_id    TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
					dek_version  INTEGER NOT NULL,
					created_at   INTEGER NOT NULL
				);
			`);
		},
	},
];
