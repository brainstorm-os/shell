/**
 * Live presentation for every entity pin on the dashboard (Stage 7.13).
 *
 * The dashboard `IconRecord` for a pinned object stores **only** the
 * entity id (`kind: "entity"`, `target: <id>`). Label, icon and the
 * opener-app badge are *not* persisted — they are recomputed here on
 * every dashboard snapshot read + on every `vault-entities` change, so:
 *
 *   - a renamed / re-iconed object updates its tile with no re-pin;
 *   - a deleted / binned object becomes a greyed **tombstone** (never
 *     silently auto-removed — a restore-from-Bin re-lights the pin in
 *     place, position preserved — OQ-DASH-1);
 *   - the badge always reflects the *current* opener (respecting the
 *     user's Settings → Defaults override).
 *
 * Pure: all I/O is injected, so the unit test drives it without a DB.
 * `app`/`view`-kind icons have no entry (they resolve from the app
 * registry, unchanged).
 */

import type { Icon, PinResolution } from "@brainstorm-os/sdk-types";
import { parseIcon } from "@brainstorm-os/sdk/entity-icon";
import { deriveEntityTitle } from "../entities/derive-title";
import type { IconRecord } from "./dashboard-store";

/** What the resolver needs to know about one entity — a thin slice of an
 *  `EntityRow`, so the test can stub it without the storage layer. */
export type ResolvedEntity = {
	type: string;
	properties: Record<string, unknown>;
};

export type PinResolverDeps = {
	/** The entity by id, or `null` if it no longer exists (→ tombstone). */
	getEntity: (entityId: string) => ResolvedEntity | null;
	/** The app `intent.open` currently routes `entityType` to (honouring
	 *  the user's default-handler override), or `null` if none registered.
	 *  Drawn as the small corner badge. */
	resolveOpenerApp: (entityType: string) => string | null;
	/** The opener app's human display name (manifest `name`, falling back to
	 *  its id) — the badge's identity when its icon asset can't be shown. */
	resolveAppName: (appId: string) => string;
};

function resolveOne(record: IconRecord, deps: PinResolverDeps): PinResolution {
	const entity = deps.getEntity(record.target);
	if (!entity) {
		// Tombstone — keep the last-known label so the tile is still
		// identifiable; no icon/app (the object is gone).
		return {
			label: record.label || record.target,
			icon: null,
			appId: null,
			appName: null,
			missing: true,
		};
	}
	const derived = deriveEntityTitle(entity.properties);
	const label = derived || record.label || record.target;
	// `properties.icon` is the canonical universal icon; validate through
	// the one shared parser so a malformed blob degrades to the badge
	// fallback instead of throwing the whole snapshot.
	const icon: Icon | null = parseIcon(entity.properties.icon);
	const appId = deps.resolveOpenerApp(entity.type);
	return {
		label,
		icon,
		appId,
		appName: appId ? deps.resolveAppName(appId) : null,
		missing: false,
	};
}

/**
 * Resolve every `kind === "entity"` and `kind === "app"` icon in the
 * dashboard's icon map to its live presentation. View icons are skipped
 * (no map entry — their label is shell-owned chrome).
 *
 * App pins carry only the app id; the label re-resolves from the app
 * registry on every read, so a manifest rename reaches pins made before
 * it (903 dogfood: pinned tiles kept pre-rename labels forever). An app
 * the registry no longer knows keeps its stored label — the same
 * identifiable-tombstone stance entity pins take.
 */
export function resolvePins(
	icons: Record<string, IconRecord>,
	deps: PinResolverDeps,
): Record<string, PinResolution> {
	const out: Record<string, PinResolution> = {};
	for (const [id, record] of Object.entries(icons)) {
		if (record.kind === "app") {
			const name = deps.resolveAppName(record.target);
			out[id] = {
				label: name !== record.target ? name : record.label || record.target,
				icon: null,
				appId: record.target,
				appName: name,
				missing: false,
			};
			continue;
		}
		if (record.kind !== "entity") continue;
		out[id] = resolveOne(record, deps);
	}
	return out;
}
