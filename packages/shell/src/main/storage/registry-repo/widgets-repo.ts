/**
 * WidgetsRepository — CRUD on `registry.db.widgets`. Replaced wholesale
 * per app on install/update.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";

export type WidgetRecord = {
	id: string;
	appId: string;
	name: string;
	size: "small" | "medium" | "large";
	registeredAt: number;
};

export class WidgetsRepository {
	constructor(private readonly db: SqliteDatabase) {}

	insert(widget: WidgetRecord): void {
		this.db
			.prepare("INSERT INTO widgets (id, app_id, name, size, registered_at) VALUES (?, ?, ?, ?, ?)")
			.run(widget.id, widget.appId, widget.name, widget.size, widget.registeredAt);
	}

	insertMany(widgets: readonly WidgetRecord[]): void {
		const stmt = this.db.prepare(
			"INSERT INTO widgets (id, app_id, name, size, registered_at) VALUES (?, ?, ?, ?, ?)",
		);
		for (const w of widgets) stmt.run(w.id, w.appId, w.name, w.size, w.registeredAt);
	}

	deleteForApp(appId: string): number {
		const result = this.db.prepare("DELETE FROM widgets WHERE app_id = ?").run(appId);
		return Number(result.changes);
	}

	listForApp(appId: string): WidgetRecord[] {
		const rows = this.db
			.prepare(
				"SELECT id, app_id, name, size, registered_at FROM widgets WHERE app_id = ? ORDER BY id",
			)
			.all(appId) as Array<{
			id: string;
			app_id: string;
			name: string;
			size: "small" | "medium" | "large";
			registered_at: number;
		}>;
		return rows.map((r) => ({
			id: r.id,
			appId: r.app_id,
			name: r.name,
			size: r.size,
			registeredAt: r.registered_at,
		}));
	}
}
