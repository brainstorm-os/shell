/**
 * Browsable-type resolution for the universal Files browser.
 *
 * Files shows every object an app can open — not just File/Folder rows
 * (design 30 §"Not opinionated about content"; design 41 §content pane
 * shows all types). "Openable" is registry truth: the store asks the
 * shell `intents.suggest({ verb: "open", entityType })` per distinct
 * non-File/Folder type once and caches the answer here. A type with an
 * opener is browsable (and the default opener app names + icons its
 * rows); an internal state/config row (`*View/v1`, `FileManagerState/v1`,
 * connector accounts, …) registers none and stays hidden.
 *
 * These helpers are the pure bookkeeping around that cache so the async
 * IPC stays a thin shell in the store and the projection logic is unit-
 * testable.
 */

import { FILE_TYPE, FOLDER_TYPE, entityTypeName } from "../types/entity";

/** Type-name families that are app-internal state / view config / logs /
 *  connector accounts — never browsable content even though their owner app
 *  registers an opener (you "open" a saved list view or a browsing session to
 *  resume it, so `intents.suggest` returns a handler). Matched against the
 *  type's name segment (`brainstorm/ListView/v1` → "ListView"). */
const INTERNAL_NAME_SUFFIXES = [
	"View", // CalendarView / GraphView / ListView
	"Session", // BrowsingSession
	"State", // FileManagerState & any app view-state
	"History", // BrowsingHistory
	"Run", // WorkflowRun (execution log)
	"Edge", // WhiteboardEdge (connector geometry)
	"Account", // MailAccount / ConnectorAccount / CalDavAccount
	"Designation", // AutomationHostDesignation
];

/** Specific app-internal types with no shared suffix — theme internals,
 *  automation/agent config, connector references. */
const INTERNAL_TYPES = new Set([
	"brainstorm/Theme/v1",
	"brainstorm/TokenSet/v1",
	"brainstorm/StylePack/v1",
	"brainstorm/Typography/v1",
	"brainstorm/Memory/v1",
	"brainstorm/Trigger/v1",
	"brainstorm/Reminder/v1",
	"brainstorm/Connector/v1",
	"brainstorm/MailFolder/v1",
	"brainstorm/CalDavCalendar/v1",
	"brainstorm/Template/v1",
]);

/** Whether a type is app-internal state/config/log — hidden from the browser
 *  even when it has a registered opener. The opener registry alone
 *  over-includes (apps register openers for their own view-state to resume
 *  it), so this structural filter is the necessary complement. */
export function isAppInternalType(type: string): boolean {
	if (INTERNAL_TYPES.has(type)) return true;
	const name = entityTypeName(type);
	return INTERNAL_NAME_SUFFIXES.some((suffix) => name !== suffix && name.endsWith(suffix));
}

/** The default opener app for a type, or `null` when the registry has none
 *  (the type is not browsable). A resolved-but-unbrowsable type maps to
 *  `null` so it is never re-queried. */
export type OpenerMeta = { appId: string; label: string | null };

/** The cache the store threads across snapshots: `type → opener | null`
 *  (absent key = not yet resolved, `null` value = resolved-no-opener). */
export type OpenerCache = ReadonlyMap<string, OpenerMeta | null>;

type EntityLike = { type: string; deletedAt?: number | null };

/** Distinct, live, non-File/Folder types in the snapshot that the cache
 *  hasn't resolved yet — the work-list for the next `intents.suggest`
 *  round. File/Folder are structural (always browsable) so never queried. */
export function unresolvedTypes(entities: readonly EntityLike[], cache: OpenerCache): string[] {
	const out = new Set<string>();
	for (const e of entities) {
		if (e.deletedAt != null) continue;
		const { type } = e;
		if (type === FILE_TYPE || type === FOLDER_TYPE) continue;
		// Cheap dedupe/already-resolved skips first, so the suffix scan in
		// `isAppInternalType` runs at most once per distinct, unresolved type
		// rather than once per row.
		if (cache.has(type) || out.has(type)) continue;
		if (isAppInternalType(type)) continue; // never browsable — don't waste an IPC query
		out.add(type);
	}
	return [...out];
}

/** The set of non-File/Folder types that have an opener — what
 *  `buildVaultFileTree` filters its non-structural rows against. */
export function browsableTypeSet(cache: OpenerCache): Set<string> {
	const out = new Set<string>();
	for (const [type, opener] of cache) {
		if (opener !== null && !isAppInternalType(type)) out.add(type);
	}
	return out;
}

/** Reduce a raw `intents.suggest` reply to the default opener (the first
 *  row — the bus returns primary-first), or `null` when nothing handles
 *  the type. Tolerant of a missing/duplicate label. */
export function openerFromHandlers(
	handlers: ReadonlyArray<{ appId: string; label?: string | null }> | null | undefined,
): OpenerMeta | null {
	const first = handlers?.[0];
	if (!first || typeof first.appId !== "string" || first.appId.length === 0) return null;
	return { appId: first.appId, label: first.label ?? null };
}
