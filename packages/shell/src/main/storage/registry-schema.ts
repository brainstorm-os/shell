/**
 * `registry.db` schema — installed apps and their registrations.
 *
 * Per §Manifest, §Install,
 * and §Persistence layout. Each installed
 * app contributes registrations across openers (entity-type / MIME →
 * handler), blocks, custom Lexical node types, and widgets.
 *
 * Stage 3 only lands the tables. App install (which populates them) is
 * Stage 5.
 */

import type { SqliteMigration } from "./migrations";

export const REGISTRY_MIGRATIONS: SqliteMigration[] = [
	{
		version: 1,
		description: "registry.db v1 — apps + openers + blocks + entity types + custom nodes + widgets",
		up: (db) => {
			db.exec(`
				CREATE TABLE apps (
					id              TEXT PRIMARY KEY,         -- reverse-DNS, e.g. io.example.text-editor
					version         TEXT NOT NULL,            -- semver
					sdk             TEXT NOT NULL,            -- SDK API version pin
					manifest_path   TEXT NOT NULL,            -- absolute path to manifest.json
					bundle_dir      TEXT NOT NULL,            -- absolute path to bundle dir
					bundle_sha256   TEXT NOT NULL,            -- hex sha256 of bundle for integrity
					installed_at    INTEGER NOT NULL,
					updated_at      INTEGER NOT NULL,
					uninstalled_at  INTEGER
				);
				CREATE INDEX idx_apps_active ON apps(id) WHERE uninstalled_at IS NULL;

				CREATE TABLE openers (
					app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
					target_kind     TEXT NOT NULL CHECK (target_kind IN ('entity_type', 'mime')),
					target          TEXT NOT NULL,         -- the entity-type URL or MIME pattern, depending on target_kind
					kind            TEXT NOT NULL CHECK (kind IN ('primary', 'secondary')),
					PRIMARY KEY (app_id, target_kind, target)
				);
				CREATE INDEX idx_openers_target ON openers(target_kind, target);

				CREATE TABLE blocks (
					id              TEXT PRIMARY KEY,         -- <app-id>/<block-name>
					app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
					name            TEXT NOT NULL,
					registered_at   INTEGER NOT NULL
				);
				CREATE INDEX idx_blocks_app ON blocks(app_id);

				CREATE TABLE entity_types (
					id              TEXT PRIMARY KEY,         -- type URL e.g. io.example/Note/v1
					introduced_by   TEXT NOT NULL REFERENCES apps(id),
					schema_url      TEXT NOT NULL,            -- canonical BP-style URL
					schema_inline   TEXT,                     -- optional inlined JSON Schema (per OQ-2 hybrid)
					registered_at   INTEGER NOT NULL,
					orphaned        INTEGER NOT NULL DEFAULT 0 -- 1 when the introducing app is uninstalled (OQ-3)
				);

				CREATE TABLE custom_node_types (
					id              TEXT PRIMARY KEY,         -- <app-id>/<node-name>
					app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
					name            TEXT NOT NULL,
					serialize_url   TEXT NOT NULL,            -- wire-format id
					registered_at   INTEGER NOT NULL
				);

				CREATE TABLE widgets (
					id              TEXT NOT NULL,            -- per-app widget id
					app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
					name            TEXT NOT NULL,
					size            TEXT NOT NULL CHECK (size IN ('small', 'medium', 'large')),
					registered_at   INTEGER NOT NULL,
					PRIMARY KEY (app_id, id)
				);
			`);
		},
	},
	{
		version: 2,
		description: "registry.db v2 — intent handlers (Stage 7.5)",
		up: (db) => {
			db.exec(`
				CREATE TABLE intents (
					app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
					verb            TEXT NOT NULL,
					entity_type     TEXT,
					mime            TEXT,
					format          TEXT,
					kind            TEXT,
					block_id        TEXT,
					label           TEXT,
					priority        TEXT NOT NULL DEFAULT 'secondary' CHECK (priority IN ('primary', 'secondary')),
					registered_at   INTEGER NOT NULL
				);
				CREATE INDEX idx_intents_verb_app ON intents(verb, app_id);
				CREATE INDEX idx_intents_entity_type ON intents(entity_type) WHERE entity_type IS NOT NULL;
				CREATE INDEX idx_intents_format ON intents(format) WHERE format IS NOT NULL;
				CREATE INDEX idx_intents_app ON intents(app_id);
			`);
		},
	},
	{
		version: 3,
		description: "registry.db v3 — openers.target_kind += scheme|extension (OpenRes-1a, doc 57)",
		up: (db) => {
			// SQLite can't ALTER a CHECK constraint, so rebuild the table with
			// the widened domain and copy rows across. `entity_type`/`mime`
			// rows are preserved byte-for-byte; the index is recreated.
			db.exec(`
				CREATE TABLE openers_v3 (
					app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
					target_kind     TEXT NOT NULL CHECK (target_kind IN ('entity_type', 'mime', 'scheme', 'extension')),
					target          TEXT NOT NULL,
					kind            TEXT NOT NULL CHECK (kind IN ('primary', 'secondary')),
					PRIMARY KEY (app_id, target_kind, target)
				);
				INSERT INTO openers_v3 (app_id, target_kind, target, kind)
					SELECT app_id, target_kind, target, kind FROM openers;
				DROP TABLE openers;
				ALTER TABLE openers_v3 RENAME TO openers;
				CREATE INDEX idx_openers_target ON openers(target_kind, target);
			`);
		},
	},
	{
		version: 4,
		description: "registry.db v4 — automations scheduler fire schedule (11b.2)",
		up: (db) => {
			// One row per registered time trigger: the workflows it drives, the
			// structured `TimeTriggerConfig`, and the next fire instant. This is
			// what lets the `SchedulerService` survive a shell restart — it
			// hydrates the in-memory heap from here on boot. `workflow_ids` and
			// `config` are JSON (the durable shape of `PersistedFire`); a NULL
			// `next_fire_at` is a spent/dormant trigger that stays registered.
			db.exec(`
				CREATE TABLE scheduler_fires (
					trigger_id     TEXT PRIMARY KEY,
					workflow_ids   TEXT NOT NULL,    -- JSON array of workflow id strings
					config         TEXT NOT NULL,    -- JSON TimeTriggerConfig
					next_fire_at   INTEGER           -- epoch ms; NULL = dormant
				);
				CREATE INDEX idx_scheduler_fires_next ON scheduler_fires(next_fire_at)
					WHERE next_fire_at IS NOT NULL;
			`);
		},
	},
	{
		version: 5,
		description: "registry.db v5 — block bundle source (live BP block mount)",
		up: (db) => {
			// The app-contributed BP block bundle (a self-contained IIFE string
			// the host inlines into the sandboxed block frame's srcdoc). NULL =
			// no bundle shipped → the embed stays a fallback card. Stored on the
			// block row so `blocks.source(blockId)` is a single keyed read; the
			// installer writes it from the app's built `dist/blocks/<name>.js`.
			db.exec("ALTER TABLE blocks ADD COLUMN source TEXT");
		},
	},
	{
		version: 6,
		description: "registry.db v6 — block entity-type mapping (embed picks the live block)",
		up: (db) => {
			// JSON array of entity-type ids this block renders. When an entity of
			// one of these types is embedded, the host resolves THIS block id
			// instead of the generic shell card. NULL / "[]" = explicit-blockId
			// only. JSON (not a junction table) keeps the per-app wholesale
			// replace on install a single-row write, matching the rest of blocks.
			db.exec("ALTER TABLE blocks ADD COLUMN entity_types TEXT");
		},
	},
	{
		version: 7,
		description: "registry.db v7 — manifest-signature verification result (13.2)",
		up: (db) => {
			// The advisory outcome of checking the app manifest's optional
			// Ed25519 signature at install/update (`AppSignatureStatus`):
			// 'unsigned' (the v1 default — no signature shipped), 'verified',
			// 'untrusted' (signed by an unknown key), or 'invalid' (signature
			// check failed). v1 records but does NOT enforce — `shouldBlockInstall`
			// is the one-flag enforcement chokepoint. `signature_key_id` is the
			// signer's key id when a signature was present (NULL otherwise).
			// Pre-existing rows default to 'unsigned' (they predate signing).
			db.exec("ALTER TABLE apps ADD COLUMN signature_status TEXT NOT NULL DEFAULT 'unsigned'");
			db.exec("ALTER TABLE apps ADD COLUMN signature_key_id TEXT");
		},
	},
	{
		version: 8,
		description:
			"registry.db v8 — intent presentation metadata for the action surface (doc 63 / AS-3)",
		up: (db) => {
			// A contributed action carries presentation metadata so a host can
			// render it without knowing the contributor (doc 63 §Contributor side):
			// `icon` is a shell IconName string the host paints; `group` is the
			// declared grouping bucket. `label`/`priority` already existed. Both
			// NULL for the existing open/quick-look rows (they never surface as
			// contributed actions — `open` stays on the open-resolution path).
			db.exec("ALTER TABLE intents ADD COLUMN icon TEXT");
			db.exec("ALTER TABLE intents ADD COLUMN action_group TEXT");
		},
	},
	{
		version: 9,
		description:
			"registry.db v9 — install provenance (doc 59 / 14.29): where an app came from + how it updates",
		up: (db) => {
			// Per §Registry schema
			// changes. `install_source` is the `InstallOrigin` enum (where the
			// app came from); `catalog_id` is the catalog it's tracked against
			// (NULL for sideload/local-file/dev); `channel` is the per-app update
			// channel (`UpdateChannel`, default 'stable'); `publisher_key` is the
			// Ed25519 TOFU anchor for future updates (distinct from 13.2's
			// `signature_key_id` = "who signed this bundle"); `catalog_version` is
			// the catalog version this install corresponds to.
			//
			// Pre-existing rows predate the catalog — every install to date is the
			// first-party seeder — so they backfill to `bootstrap-cache` against
			// the official catalog (the column defaults do install_source/channel;
			// the UPDATE sets catalog_id for the already-present rows).
			db.exec("ALTER TABLE apps ADD COLUMN install_source TEXT NOT NULL DEFAULT 'bootstrap-cache'");
			db.exec("ALTER TABLE apps ADD COLUMN catalog_id TEXT");
			db.exec("ALTER TABLE apps ADD COLUMN channel TEXT NOT NULL DEFAULT 'stable'");
			db.exec("ALTER TABLE apps ADD COLUMN publisher_key TEXT");
			db.exec("ALTER TABLE apps ADD COLUMN catalog_version TEXT");
			db.exec(
				"UPDATE apps SET catalog_id = 'brainstorm-official' WHERE install_source = 'bootstrap-cache'",
			);
		},
	},
	{
		version: 10,
		description: "registry.db v10 — scheduler_meta kv (0.3.1 missed-fire lastRun watermark)",
		up: (db) => {
			// ROT/9.14.9b follow-up (0.3.1) — a tiny key/value store alongside
			// scheduler_fires. Holds `last_run` (epoch ms): the last instant the
			// automations scheduler was known to be running. On next launch a
			// one-shot item-alert (task/event reminder) that came due in the closed
			// gap `(last_run, now]` fires once as catch-up. LOCAL derived state —
			// never syncs.
			db.exec(`
				CREATE TABLE scheduler_meta (
					key   TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
			`);
		},
	},
	{
		version: 11,
		description: "registry.db v11 — file_watch_grants (11b.10 FileWatch persistent file grants)",
		up: (db) => {
			// 11b.10 — persistent file-access grants for FileWatch triggers. File
			// HANDLES are session-only by design (re-granted each vault open as the
			// audit trail), but an unattended FileWatch trigger must keep firing
			// after a reopen — so the user's explicit file pick persists here as an
			// opaque `watch_id → (app, path, mode)`. The PATH is shell-internal
			// only (never returned to an app; the app holds the opaque watch_id).
			// On vault open the automations wiring resolves each watch_id and
			// re-mints a live session handle. Revocable in Settings. LOCAL — never
			// syncs (paths are device-specific).
			db.exec(`
				CREATE TABLE file_watch_grants (
					watch_id   TEXT PRIMARY KEY,
					app_id     TEXT NOT NULL,
					path       TEXT NOT NULL,
					mode       TEXT NOT NULL,
					created_at INTEGER NOT NULL
				);
			`);
			// Idempotent mint: re-granting the same (app, path, mode) returns the
			// existing watch_id instead of growing the table unbounded.
			db.exec(
				"CREATE UNIQUE INDEX idx_file_watch_grants_grant ON file_watch_grants (app_id, path, mode);",
			);
		},
	},
];
