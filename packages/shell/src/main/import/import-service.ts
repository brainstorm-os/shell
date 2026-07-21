/**
 * `import` — the app-facing broker service over the IE-2 import engine (IE-2
 * tail). Lets a sandboxed app run the shared Source→Parse→Map→Project→Dedupe→
 * Write pipeline (dry-run `plan` + idempotent `run`) instead of hand-rolling its
 * own importer (the IE-4 consolidation target).
 *
 * Capability model (mirrors `entities` —): import is **bulk
 * entity creation**, so it reuses the per-type `entities.write:<targetType>`
 * grant rather than inventing a broad new capability surface. The per-call broker
 * gate is a no-op (`caps: []`); THIS handler is the sole authority and checks the
 * per-vault ledger for `entities.write:<targetType>` (a `*` grant matches),
 * failing closed (`Unavailable`) on no vault / ledger error and `Denied` when the
 * app may not write the target type.
 *
 * Methods: `preview` (columns + row sample, no write — drives an app mapping UI),
 * `plan` (non-destructive dry-run), `run` (idempotent upsert).
 *
 * Two hardening invariants make the surface safe:
 *   - **type is never the app's to choose**: the written entity type is always
 *     the cap-checked `targetType`. An app's optional column `mapping` carries
 *     only column→property→include edits (overlaid onto the engine's inferred
 *     base via {@link resolveMapping}); it can't carry a target type, so it can't
 *     redirect the write to a type the app may not touch.
 *   - **app-scoped dedupe**: the idempotency key is namespaced by the calling app
 *     (`<app>::<source>`), so one app's re-import can't update another app's rows.
 *
 * Provenance: imported entities are stamped `createdBy: <app>` — attributable to
 * the app that ran the import, not the shell. All IO injected; unit-tested
 * against a real vault session without Electron.
 */

import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { ValueType } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { VaultSession } from "../vault/session";
import { inferMapping } from "./import-map";
import { parseTable } from "./import-parse";
import { ImportFormat, type MappingPlan } from "./import-types";
import {
	type ImportRecordsOptions,
	importRecordsIntoVault,
	planRecordsImport,
} from "./vault-import-engine";

export const IMPORT_SERVICE = "import";

export type ImportServiceDeps = {
	/** Active vault session, or null when none (→ `Unavailable`, fail closed). */
	readonly getSession: () => VaultSession | null;
	/** Active vault's capability ledger, or null (→ `Unavailable`). */
	readonly getLedger: () => Promise<CapabilityLedger | null>;
	readonly now: () => number;
};

function named(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function arg(envelope: { args: unknown[] }): Record<string, unknown> {
	const value = envelope.args[0];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw named("Invalid", "import: argument must be an object");
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw named("Invalid", `import: { ${field} } must be a non-empty string`);
	}
	return value;
}

const FORMATS = new Set<string>(Object.values(ImportFormat));

function requireFormat(value: unknown): ImportFormat {
	if (typeof value !== "string" || !FORMATS.has(value)) {
		throw named("Invalid", `import: { format } must be one of ${[...FORMATS].join(", ")}`);
	}
	return value as ImportFormat;
}

/** The target type's existing PropertyDefs (key → ValueType) so inference adopts
 *  a declared property's type instead of re-guessing (IE-2 map-onto-type). */
async function knownPropsFor(session: VaultSession): Promise<ReadonlyMap<string, ValueType>> {
	const store = await session.propertiesStore();
	const map = new Map<string, ValueType>();
	for (const [key, def] of Object.entries(store.snapshot().properties)) {
		map.set(key, def.valueType);
	}
	return map;
}

const SAMPLE_ROWS = 5;

/** One column override an app supplies to build an import UI: the target
 *  property name + whether to include the column. */
type ImportMappingEdit = { column: string; property: string; include: boolean };

/** Parse the app's optional mapping edits (defensive over untrusted args). The
 *  app supplies ONLY column→property→include — never a target type, so it can't
 *  redirect the write to a type it may not hold. */
function parseEdits(value: unknown): readonly ImportMappingEdit[] | null {
	if (!Array.isArray(value)) return null;
	const edits: ImportMappingEdit[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const e = raw as Record<string, unknown>;
		if (typeof e.column !== "string" || typeof e.property !== "string") continue;
		edits.push({ column: e.column, property: e.property, include: e.include !== false });
	}
	return edits.length > 0 ? edits : null;
}

/** Build the mapping for a run: the engine's inferred base (targetType + source +
 *  dedupeColumn + per-column ValueType are the engine's, NOT the app's), with the
 *  app's column→property + include edits overlaid. Mirrors the IE-3 dashboard
 *  handler's `resolveMapping` — the app picks *where* a column lands, never *how*
 *  its values are typed or which type the rows become. */
function resolveMapping(
	format: ImportFormat,
	text: string,
	targetType: string,
	source: string,
	knownProps: ReadonlyMap<string, ValueType>,
	edits: readonly ImportMappingEdit[] | null,
): MappingPlan | undefined {
	if (!edits) return undefined;
	const table = parseTable(format, text);
	const base = inferMapping(table, targetType, source, knownProps);
	const byColumn = new Map(edits.map((e) => [e.column, e]));
	return {
		...base,
		columns: base.columns.map((col) => {
			const edit = byColumn.get(col.column);
			if (!edit) return col;
			const property = edit.property.trim();
			return {
				...col,
				include: edit.include,
				property: property.length > 0 ? property : col.property,
			};
		}),
	};
}

export function makeImportServiceHandler(deps: ImportServiceDeps): ServiceHandler {
	return async (envelope) => {
		const app = envelope.app;
		const session = deps.getSession();
		const ledger = await deps.getLedger();
		if (!session || !ledger) throw named("Unavailable", "import service: no active vault session");

		const a = arg(envelope);
		const format = requireFormat(a.format);
		const targetType = requireString(a.targetType, "targetType");
		if (typeof a.text !== "string") throw named("Invalid", "import: { text } must be a string");
		const text = a.text;
		const userSource = typeof a.source === "string" && a.source.length > 0 ? a.source : format;

		// Sole authority: the app must hold entities.write for the target type
		// (`*` matches). A forged/absent envelope cap can't widen this.
		let canWrite: boolean;
		try {
			canWrite = ledger.has(app, `entities.write:${targetType}`);
		} catch (error) {
			if (error instanceof LedgerUnavailableError) {
				throw named("Unavailable", "import service: capability ledger unavailable");
			}
			throw error;
		}
		if (!canWrite) throw named("Denied", `import: no entities.write for ${targetType}`);

		// `preview` reads the source shape so an app can build a mapping UI —
		// it never writes, so the cap check above is the only gate it needs.
		if (envelope.method === "preview") {
			const table = parseTable(format, text);
			return {
				columns: table.columns,
				recordCount: table.records.length,
				sample: table.records.slice(0, SAMPLE_ROWS).map((r) => r.fields),
			};
		}

		const source = `${app}::${userSource}`;
		const knownProps = await knownPropsFor(session);
		const mapping = resolveMapping(
			format,
			text,
			targetType,
			source,
			knownProps,
			parseEdits(a.mapping),
		);
		const options: ImportRecordsOptions = {
			format,
			targetType,
			// App-scoped dedupe namespace: one app can't update another's imports.
			source,
			now: deps.now(),
			importedBy: app,
			knownProps,
			...(mapping ? { mapping } : {}),
		};

		switch (envelope.method) {
			case "plan":
				return planRecordsImport(session, text, options);
			case "run":
				return importRecordsIntoVault(session, text, options);
			default:
				throw named("Invalid", `unknown import method: ${envelope.method}`);
		}
	};
}
