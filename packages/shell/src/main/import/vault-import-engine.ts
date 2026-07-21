/**
 * Vault binding for the import engine (IE-2).
 *
 * Wires the abstract {@link ImportWriteDeps} to a live vault session's
 * `EntitiesRepository`: creates go through the same privileged create path the
 * seeder + bundle restore use, and idempotent upsert is keyed on the flat
 * {@link IMPORT_EXTERNAL_ID_PROP} marker via `listIdsWithProperty` — so a second
 * import of the same source updates the existing rows rather than duplicating
 * them (doc 45 §The import flow: "idempotent on a provenance/external-id key").
 *
 * Streaming the write through a utility worker + the progress host service is a
 * later rung (doc 45 §Streaming); for now the batch runs in-process, which is
 * the reproducible surface the §The import flow dry-run/run contract needs.
 */

import type { ValueType } from "@brainstorm-os/sdk-types";
import { ulid } from "ulid";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import { planImport, runImport } from "./import-engine";
import { inferMapping } from "./import-map";
import { parseTable } from "./import-parse";
import { projectRecord } from "./import-project";
import {
	type EntityDraft,
	IMPORT_EXTERNAL_ID_PROP,
	type ImportFormat,
	type ImportPlan,
	type ImportRunOptions,
	type ImportRunReport,
	type ImportWriteDeps,
	type MappingPlan,
} from "./import-types";

export type ImportRecordsOptions = {
	readonly format: ImportFormat;
	/** Vault entity type the source rows map onto (e.g. `brainstorm/Note/v1`). */
	readonly targetType: string;
	/** Stable source id namespacing the dedupe key (e.g. `json:notion-2026`). */
	readonly source: string;
	readonly now: number;
	/** Identity recorded as `createdBy` on imported entities. */
	readonly importedBy: string;
	/** A user-edited mapping (IE-3); inferred from the table when omitted. */
	readonly mapping?: MappingPlan;
	/** The target type's existing PropertyDefs (key → ValueType). When present,
	 *  inference adopts a known property's declared type instead of re-guessing
	 *  (IE-2 map-onto-existing-type). Ignored when `mapping` is supplied. */
	readonly knownProps?: ReadonlyMap<string, ValueType>;
};

function makeWriteDeps(
	repo: EntitiesRepository,
	importedBy: string,
	expectedType: string,
): ImportWriteDeps {
	return {
		// The external-id marker is flat (indexed across ALL types), so a dedupe
		// match could land on a row of a DIFFERENT type than this import targets —
		// e.g. an app that stamped `<app>::S:1` on a Note/v1 under a since-narrowed
		// grant, then re-imports source S into Task/v1. Upserting that match would
		// overwrite the Note (a cross-type write the per-type cap forbids — the
		// entities service re-checks the fetched row's type on update; this path
		// must too). Only treat a same-type match as the dedupe target; a
		// foreign-type match reads as "not found" → a fresh row of the right type.
		findByExternalKey: (key) =>
			repo
				.listIdsWithProperty(IMPORT_EXTERNAL_ID_PROP, key)
				.find((id) => repo.get(id)?.type === expectedType) ?? null,
		create: (draft, externalKey, now) => {
			repo.create({
				id: `ent_${ulid()}`,
				type: draft.type,
				properties:
					externalKey === null
						? draft.properties
						: { ...draft.properties, [IMPORT_EXTERNAL_ID_PROP]: externalKey },
				createdBy: importedBy,
				now,
				dekId: null,
			});
		},
		update: (id, properties, now) => {
			repo.update(id, properties, now);
		},
	};
}

function buildDrafts(text: string, options: ImportRecordsOptions): EntityDraft[] {
	const table = parseTable(options.format, text);
	const mapping =
		options.mapping ?? inferMapping(table, options.targetType, options.source, options.knownProps);
	return table.records.map((record) => projectRecord(record, mapping));
}

/** Non-destructive dry-run: parse + map + project, then report the
 *  create/update split without writing (doc 45 §The import flow step 5). */
export async function planRecordsImport(
	session: VaultSession,
	text: string,
	options: ImportRecordsOptions,
): Promise<ImportPlan> {
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const deps = makeWriteDeps(repo, options.importedBy, options.targetType);
	return planImport(buildDrafts(text, options), options.source, deps);
}

/** Run the import: parse → map → project → idempotent upsert into the vault.
 *  `run` streams progress + carries the cancel signal (doc 45 §Streaming). */
export async function importRecordsIntoVault(
	session: VaultSession,
	text: string,
	options: ImportRecordsOptions,
	run: ImportRunOptions = {},
): Promise<ImportRunReport> {
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const deps = makeWriteDeps(repo, options.importedBy, options.targetType);
	return runImport(buildDrafts(text, options), options.source, deps, options.now, run);
}
