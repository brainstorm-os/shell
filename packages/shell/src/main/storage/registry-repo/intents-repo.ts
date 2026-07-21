/**
 * IntentsRepository — CRUD on `registry.db.intents`.
 *
 * One row per (app, verb, optional discriminator). Replaced wholesale per app
 * on install/update. The verb namespace is curated (per
 * §The standard intent verbs); the manifest validator enforces it.
 *
 * Discriminators (`entity_type`, `mime`, `format`, `kind`, `block_id`) are
 * orthogonal — a row can use any subset to match dispatch requests. Empty
 * discriminator columns are wildcards within their dimension.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";

export type IntentRecord = {
	appId: string;
	verb: string;
	entityType: string | null;
	mime: string | null;
	format: string | null;
	kind: string | null;
	blockId: string | null;
	label: string | null;
	priority: "primary" | "secondary";
	registeredAt: number;
	/** Action-surface presentation metadata (doc 63 / AS-3). NULL on the
	 *  open/quick-look rows that never surface as contributed actions. Optional
	 *  on the in-memory record so existing handler/opener literals don't need
	 *  the fields; the repo persists `null` when absent. */
	icon?: string | null;
	actionGroup?: string | null;
};

export type IntentQuery = {
	verb: string;
	entityType?: string;
	mime?: string;
	format?: string;
	kind?: string;
	blockId?: string;
};

type IntentRow = {
	app_id: string;
	verb: string;
	entity_type: string | null;
	mime: string | null;
	format: string | null;
	kind: string | null;
	block_id: string | null;
	label: string | null;
	priority: "primary" | "secondary";
	registered_at: number;
	icon: string | null;
	action_group: string | null;
};

export class IntentsRepository {
	constructor(private readonly db: SqliteDatabase) {}

	insert(intent: IntentRecord): void {
		this.db
			.prepare(
				`INSERT INTO intents
				(app_id, verb, entity_type, mime, format, kind, block_id, label, priority, registered_at, icon, action_group)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				intent.appId,
				intent.verb,
				intent.entityType,
				intent.mime,
				intent.format,
				intent.kind,
				intent.blockId,
				intent.label,
				intent.priority,
				intent.registeredAt,
				intent.icon ?? null,
				intent.actionGroup ?? null,
			);
	}

	insertMany(intents: readonly IntentRecord[]): void {
		const stmt = this.db.prepare(
			`INSERT INTO intents
			(app_id, verb, entity_type, mime, format, kind, block_id, label, priority, registered_at, icon, action_group)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const i of intents) {
			stmt.run(
				i.appId,
				i.verb,
				i.entityType,
				i.mime,
				i.format,
				i.kind,
				i.blockId,
				i.label,
				i.priority,
				i.registeredAt,
				i.icon ?? null,
				i.actionGroup ?? null,
			);
		}
	}

	deleteForApp(appId: string): number {
		const result = this.db.prepare("DELETE FROM intents WHERE app_id = ?").run(appId);
		return Number(result.changes);
	}

	listForApp(appId: string): IntentRecord[] {
		const rows = this.db
			.prepare(
				`SELECT app_id, verb, entity_type, mime, format, kind, block_id, label, priority, registered_at, icon, action_group
				FROM intents WHERE app_id = ? ORDER BY verb, entity_type, format, kind`,
			)
			.all(appId) as IntentRow[];
		return rows.map(fromRow);
	}

	/** Every registered intent across all installed apps — the full action/tool
	 *  vocabulary the platform catalog (doc 63 / Agent context layer) exposes to
	 *  the Agent. Ordered by app then verb so the snapshot is deterministic. */
	listAll(): IntentRecord[] {
		const rows = this.db
			.prepare(
				`SELECT app_id, verb, entity_type, mime, format, kind, block_id, label, priority, registered_at, icon, action_group
				FROM intents ORDER BY app_id, verb, entity_type, format, kind`,
			)
			.all() as IntentRow[];
		return rows.map(fromRow);
	}

	/**
	 * Find handlers matching a dispatch query. A row matches iff each of its
	 * non-null discriminator columns equals the corresponding query field. A
	 * NULL column is a wildcard in that dimension. Results sort by priority
	 * (primary before secondary), then app id for stability.
	 */
	findHandlers(query: IntentQuery): IntentRecord[] {
		const rows = this.db
			.prepare(
				`SELECT app_id, verb, entity_type, mime, format, kind, block_id, label, priority, registered_at, icon, action_group
				FROM intents
				WHERE verb = ?
				  AND (entity_type IS NULL OR entity_type = ?)
				  AND (mime IS NULL OR mime = ?)
				  AND (format IS NULL OR format = ?)
				  AND (kind IS NULL OR kind = ?)
				  AND (block_id IS NULL OR block_id = ?)
				ORDER BY CASE priority WHEN 'primary' THEN 0 ELSE 1 END, app_id`,
			)
			.all(
				query.verb,
				query.entityType ?? null,
				query.mime ?? null,
				query.format ?? null,
				query.kind ?? null,
				query.blockId ?? null,
			) as IntentRow[];
		return rows.map(fromRow);
	}

	/**
	 * The action-surface lookup (doc 63 / AS-1): every contribution whose
	 * `verb` is in `verbs` and whose non-null discriminators match the target
	 * (OQ-AS-2 — type/mime/format only). A row's NULL discriminator column is a
	 * wildcard within its dimension, so a target with only `entityType` set
	 * still matches a row that constrains just `entityType` (and any row that
	 * constrains nothing). One indexed query over the tiny intents table; the
	 * caller (the bus) applies cap/trust/cap-check on top.
	 */
	findActions(
		verbs: readonly string[],
		discriminators: { entityType?: string; mime?: string; format?: string },
	): IntentRecord[] {
		if (verbs.length === 0) return [];
		const placeholders = verbs.map(() => "?").join(", ");
		const rows = this.db
			.prepare(
				`SELECT app_id, verb, entity_type, mime, format, kind, block_id, label, priority, registered_at, icon, action_group
				FROM intents
				WHERE verb IN (${placeholders})
				  AND (entity_type IS NULL OR entity_type = ?)
				  AND (mime IS NULL OR mime = ?)
				  AND (format IS NULL OR format = ?)
				ORDER BY CASE priority WHEN 'primary' THEN 0 ELSE 1 END, app_id`,
			)
			.all(
				...verbs,
				discriminators.entityType ?? null,
				discriminators.mime ?? null,
				discriminators.format ?? null,
			) as IntentRow[];
		return rows.map(fromRow);
	}
}

function fromRow(r: IntentRow): IntentRecord {
	return {
		appId: r.app_id,
		verb: r.verb,
		entityType: r.entity_type,
		mime: r.mime,
		format: r.format,
		kind: r.kind,
		blockId: r.block_id,
		label: r.label,
		priority: r.priority,
		registeredAt: r.registered_at,
		icon: r.icon,
		actionGroup: r.action_group,
	};
}
