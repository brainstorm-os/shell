/**
 * AppToolsRepository — CRUD on `registry.db.app_tools` (Tool-2).
 *
 * Replaced wholesale per app on install / update, exactly like
 * `WidgetsRepository` and its siblings: an app's declared tool set is a
 * function of its manifest, so a re-install is a delete + insert, never a
 * merge (a stale row would otherwise keep offering a tool the app no longer
 * implements).
 *
 * `applies_to` / `surfaces` are stored as JSON arrays — the same shape the
 * openers repo uses for its multi-valued columns. Reads are defensive: a row
 * whose JSON fails to parse degrades to the empty list rather than throwing
 * a menu open.
 */

import {
	type AppToolEffect,
	type AppToolInput,
	type AppToolRecord,
	type AppToolSurface,
	isAppToolEffect,
	isAppToolSurface,
	normalizeAppToolInput,
	validateAppToolInput,
} from "@brainstorm-os/sdk-types";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";

type Row = {
	id: string;
	app_id: string;
	name: string;
	title: string;
	description: string;
	effect: string;
	applies_to: string;
	surfaces: string;
	input: string;
	registered_at: number;
};

function parseList(json: string): string[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** Re-validate the stored argument declaration on READ (Tool-3).
 *
 * The installer validates before writing, so a row that fails here is corrupt
 * or hand-edited. Degrading the way the list columns do — dropping the bad
 * entries and keeping the rest — would be fail-OPEN in the one place it must
 * not be: silently losing a `pattern` or a `range` leaves a tool that looks
 * constrained and validates nothing. So a bad declaration poisons the whole
 * tool instead. */
function parseInput(json: string): { input: AppToolInput[]; invalid: boolean } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { input: [], invalid: true };
	}
	if (!Array.isArray(parsed)) return { input: [], invalid: true };
	const input: AppToolInput[] = [];
	for (const [i, entry] of parsed.entries()) {
		if (!validateAppToolInput(entry, i).ok) return { input: [], invalid: true };
		input.push(normalizeAppToolInput(entry as AppToolInput));
	}
	return { input, invalid: false };
}

function toRecord(r: Row): AppToolRecord {
	const { input, invalid } = parseInput(r.input);
	return {
		...(invalid ? { declarationInvalid: true as const } : {}),
		input,
		id: r.id,
		appId: r.app_id,
		name: r.name,
		title: r.title,
		description: r.description,
		// A row whose effect isn't in the vocabulary keeps its RAW value: the
		// service's capability filter has no requirement entry for it and so
		// refuses to offer it at all. (Mapping it onto a real class would be
		// fail-OPEN — `proposes-write` requires nothing, so a mangled byte
		// would have skipped the provider-capability check entirely.)
		effect: (isAppToolEffect(r.effect) ? r.effect : r.effect) as AppToolEffect,
		appliesTo: parseList(r.applies_to),
		surfaces: parseList(r.surfaces).filter((s): s is AppToolSurface => isAppToolSurface(s)),
		registeredAt: r.registered_at,
	};
}

const COLUMNS =
	"id, app_id, name, title, description, effect, applies_to, surfaces, input, registered_at";

export class AppToolsRepository {
	constructor(private readonly db: SqliteDatabase) {}

	insertMany(tools: readonly AppToolRecord[]): void {
		const stmt = this.db.prepare(
			`INSERT INTO app_tools (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const t of tools) {
			stmt.run(
				t.id,
				t.appId,
				t.name,
				t.title,
				t.description,
				t.effect,
				JSON.stringify(t.appliesTo),
				JSON.stringify(t.surfaces),
				JSON.stringify(t.input ?? []),
				t.registeredAt,
			);
		}
	}

	deleteForApp(appId: string): number {
		const result = this.db.prepare("DELETE FROM app_tools WHERE app_id = ?").run(appId);
		return Number(result.changes);
	}

	listForApp(appId: string): AppToolRecord[] {
		const rows = this.db
			.prepare(`SELECT ${COLUMNS} FROM app_tools WHERE app_id = ? ORDER BY name`)
			.all(appId) as Row[];
		return rows.map(toRecord);
	}

	/** Every registered tool, ordered by id so a menu's order is stable across
	 *  opens (the registry is the single source of order). */
	listAll(): AppToolRecord[] {
		const rows = this.db.prepare(`SELECT ${COLUMNS} FROM app_tools ORDER BY id`).all() as Row[];
		return rows.map(toRecord);
	}

	get(id: string): AppToolRecord | null {
		const row = this.db.prepare(`SELECT ${COLUMNS} FROM app_tools WHERE id = ?`).get(id) as
			| Row
			| undefined;
		return row ? toRecord(row) : null;
	}
}
