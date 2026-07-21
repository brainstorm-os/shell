/**
 * Shared import engine (IE-2) — vocabulary.
 *
 * Realises [ §The import flow + §Parse/Map
 * split]: the pluggable **Source → Parse → Map → Project → Dedupe → Write**
 * pipeline every migration importer builds on. This module owns the types the
 * stages exchange; the stages themselves are separate, mostly-pure files so
 * the heavy/shared parts (Map/Project/Dedupe) stay reusable and the per-format
 * Parse adapters fold in at IE-4.
 *
 * The keystone is correctness of the *mapping model*: a source column maps to
 * a vault property with an inferred (user-overridable) ValueType, values are
 * coerced into the typed shape, and re-import is **idempotent** — every drafted
 * entity carries a flat external-id marker so a second run of the same source
 * updates rather than duplicates.
 */

import type { ValueType } from "@brainstorm-os/sdk-types";

/** Format of a parsed source. The per-format Parse adapter is selected by
 *  this discriminator (CSV / Markdown / HTML adapters land at IE-4). */
export enum ImportFormat {
	Json = "json",
	Jsonl = "jsonl",
	Csv = "csv",
	Markdown = "markdown",
	Html = "html",
}

/** A single normalized source row — the IR the Parse stage emits, decoupled
 *  from any source format. `externalId` is the source's stable id for this row
 *  when one is identifiable (drives idempotent dedupe). */
export type ImportRecord = {
	readonly externalId: string | null;
	readonly fields: Record<string, unknown>;
};

/** A normalized table (named columns + rows) — the Parse → Map handoff. */
export type ParsedTable = {
	readonly name: string;
	readonly columns: readonly string[];
	readonly records: readonly ImportRecord[];
};

/** One column → property binding in a mapping plan. */
export type ColumnMapping = {
	readonly column: string;
	readonly property: string;
	readonly valueType: ValueType;
	readonly include: boolean;
};

/** The Map stage's output: how a source table projects onto a vault type. */
export type MappingPlan = {
	readonly source: string;
	readonly targetType: string;
	readonly columns: readonly ColumnMapping[];
	/** Which column holds the source's stable id, or null (no dedupe key). */
	readonly dedupeColumn: string | null;
};

/** A projected entity ready for the Write stage. */
export type EntityDraft = {
	readonly externalId: string | null;
	readonly type: string;
	readonly properties: Record<string, unknown>;
};

/** The non-destructive scan the import wizard (IE-3) shows before committing
 *  (doc 45 §The import flow step 5). */
export type ImportPlan = {
	readonly total: number;
	readonly willCreate: number;
	readonly willUpdate: number;
	readonly byType: Readonly<Record<string, number>>;
	readonly warnings: readonly string[];
};

/** One failure row surfaced by the wizard's done state (F-395). `reason` is
 *  the always-present human-readable fallback; when the failure is a known
 *  shell-owned condition, `reasonKey`/`reasonArgs` name a renderer i18n
 *  message so the explanation localizes (the renderer falls back to `reason`
 *  for keys it doesn't know). */
export type ImportFailure = {
	readonly externalId: string | null;
	readonly reason: string;
	readonly reasonKey?: string;
	readonly reasonArgs?: Readonly<Record<string, string | number>>;
};

export type ImportRunReport = {
	readonly created: number;
	readonly updated: number;
	/** Drafts not committed because the run was cancelled (`signal` aborted). */
	readonly skipped: number;
	readonly failed: ReadonlyArray<ImportFailure>;
	/** True when an abort cut the run short (some drafts were `skipped`). */
	readonly cancelled?: boolean;
};

/** Streaming controls for a run (doc 45 §Streaming): progress ticks + cancel. */
export type ImportRunOptions = {
	/** Called as the run advances (`done` of `total` drafts committed). */
	readonly onProgress?: (done: number, total: number) => void;
	/** Abort to stop the run between drafts; remaining drafts become `skipped`. */
	readonly signal?: AbortSignal;
};

/** The privileged write surface the engine drives (bound to a vault session in
 *  `vault-import-engine.ts`). Kept abstract so the pipeline is testable without
 *  a vault and so the same engine can target a worker batch later. */
export type ImportWriteDeps = {
	/** Resolve an existing entity by its namespaced external key, or null. */
	readonly findByExternalKey: (externalKey: string) => string | null;
	readonly create: (draft: EntityDraft, externalKey: string | null, now: number) => void;
	readonly update: (id: string, properties: Record<string, unknown>, now: number) => void;
};

/** Flat, indexed marker property every imported entity carries for the
 *  upsert-on-external-id lookup (value = `<source>:<externalId>`). Mirrors the
 *  connector framework's `connectorExternalId`, kept bare (not enveloped) so
 *  the `listIdsWithProperty` lookup compiles to a direct `json_extract` match.
 *  Distinct from the connector marker because import is one-shot, not a
 *  continuous sync cursor. */
export const IMPORT_EXTERNAL_ID_PROP = "importExternalId";

/** Content hash (FNV-1a hex) of the LAST successfully planted body state for
 *  an imported entity. Re-imports compare against it to skip re-planting an
 *  unchanged body (and to know a changed one must REPLACE, not append). */
export const IMPORT_BODY_HASH_PROP = "importBodyHash";

/** Compose the namespaced external key stored in {@link IMPORT_EXTERNAL_ID_PROP}. */
export function externalKeyOf(source: string, externalId: string): string {
	return `${source}:${externalId}`;
}
