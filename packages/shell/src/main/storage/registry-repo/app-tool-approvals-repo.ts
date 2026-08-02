/**
 * AppToolApprovalsRepository — `registry.db.app_tool_approvals` (Tool-5).
 *
 * One row per tool the user has approved, holding the FINGERPRINT of the
 * declaration they approved. `tools.call` compares the current declaration
 * against it, so an app update that rewrites a tool cannot inherit the friction
 * the old wording earned.
 *
 * Unlike `app_tools`, these rows are NOT replaced wholesale on reinstall. That
 * is the point: the table records a decision a person made, not a fact derived
 * from the manifest. A reinstall of the same declaration therefore keeps its
 * approval (the fingerprint matches); a reinstall that changed the tool loses
 * it (the fingerprint differs), which is exactly the signal. They are dropped
 * only when the app is UNINSTALLED — an approval for a tool that no longer
 * exists would silently pre-approve a future app that reclaimed the id.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";

type Row = {
	caller_app_id: string;
	tool_id: string;
	app_id: string;
	fingerprint: string;
	approved_at: number;
};

export class AppToolApprovalsRepository {
	constructor(private readonly db: SqliteDatabase) {}

	/** The fingerprint THIS CALLER approved, or null.
	 *
	 * Per caller, not per tool: `confirmed` is an assertion the caller makes
	 * about a human it cannot prove, so a global row would let one caller's
	 * claim permanently bless the tool for everyone else. */
	get(callerAppId: string, toolId: string): string | null {
		const row = this.db
			.prepare("SELECT fingerprint FROM app_tool_approvals WHERE caller_app_id = ? AND tool_id = ?")
			.get(callerAppId, toolId) as { fingerprint: string } | undefined;
		return row?.fingerprint ?? null;
	}

	/** Record (or re-baseline) one tool's approved surface.
	 *
	 * Deliberately per-TOOL. Re-baselining a whole app on one approval is the
	 * hole the MCP path documents: approving one changed tool would silently
	 * bless every other tool that changed in the same update. */
	approve(
		callerAppId: string,
		toolId: string,
		appId: string,
		fingerprint: string,
		at: number,
	): void {
		this.db
			.prepare(
				"INSERT INTO app_tool_approvals (caller_app_id, tool_id, app_id, fingerprint, approved_at) VALUES (?, ?, ?, ?, ?)" +
					" ON CONFLICT(caller_app_id, tool_id) DO UPDATE SET fingerprint = excluded.fingerprint, approved_at = excluded.approved_at, app_id = excluded.app_id",
			)
			.run(callerAppId, toolId, appId, fingerprint, at);
	}

	/** Drop every approval that names this app — as the PROVIDER (its tools are
	 *  gone) or as the CALLER (its decisions are gone). Either way an approval
	 *  left behind would outlive the app it belonged to. */
	deleteForApp(appId: string): number {
		const result = this.db
			.prepare("DELETE FROM app_tool_approvals WHERE app_id = ? OR caller_app_id = ?")
			.run(appId, appId);
		return Number(result.changes);
	}

	listForApp(appId: string): Row[] {
		return this.db
			.prepare(
				"SELECT caller_app_id, tool_id, app_id, fingerprint, approved_at FROM app_tool_approvals WHERE app_id = ? ORDER BY caller_app_id, tool_id",
			)
			.all(appId) as Row[];
	}
}
