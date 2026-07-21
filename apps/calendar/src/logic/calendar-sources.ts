/**
 * Calendar source discovery — turns the live `ScheduledItem` projection into
 * the list of toggleable sources the sidebar renders (9.15f). A source is one
 * `(entity type · date property)` combination (or a built-in: Events, Journal);
 * the set is *discovered* from what's actually in the vault, not a hardcoded
 * enum, so a custom type carrying a `Date` property shows up automatically.
 */

import { friendlyTypeName } from "@brainstorm-os/sdk/system-entities";
import { type TKey, t } from "../i18n/t";
import type { DateKeyInfo } from "./from-vault-entities";
import {
	EVENT_SOURCE_KEY,
	JOURNAL_SOURCE_KEY,
	type ScheduledItem,
	colorForSourceKey,
	parseSourceKey,
} from "./scheduled-item";

export type CalendarSource = {
	/** The `ScheduledItem.sourceKey` this entry toggles. */
	key: string;
	/** Human label — "Tasks · Scheduled", or a built-in name. */
	label: string;
	/** Legend / dot colour (shared with the rendered chips). */
	color: string;
	/** Distinct source objects feeding this source (not raw item count, so a
	 *  yearly-recurring birthday counts once, not once per year). */
	count: number;
};

const BUILTIN_LABEL_KEY: Readonly<Record<string, TKey>> = {
	[EVENT_SOURCE_KEY]: "calendar.sidebar.calendar.events",
	[JOURNAL_SOURCE_KEY]: "calendar.sidebar.calendar.journal",
};

/** "scheduledAt" → "Scheduled at" — last-ditch label for a date key absent
 *  from the catalog and the well-known set (shouldn't normally happen). */
function humanizeKey(key: string): string {
	const spaced = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();
	if (spaced.length === 0) return key;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The display label for a source key: a built-in name, or
 *  "`<Type>` · `<Property>`" for a property-derived source. `dateKeyInfo` is
 *  optional — when absent (e.g. the search overlay) the property name falls
 *  back to a humanized key. */
export function labelForSourceKey(key: string, dateKeyInfo?: DateKeyInfo): string {
	const builtin = BUILTIN_LABEL_KEY[key];
	if (builtin) return t(builtin);
	const parsed = parseSourceKey(key);
	if (!parsed) return key;
	const typeName = friendlyTypeName(parsed.entityType);
	const propName = dateKeyInfo?.names.get(parsed.propertyKey) ?? humanizeKey(parsed.propertyKey);
	return `${typeName} · ${propName}`;
}

/** Build the discovered source list from the base (pre-expansion) item set.
 *  Sorted by object count desc, then label, for a stable order. */
export function discoverSources(
	items: readonly ScheduledItem[],
	dateKeyInfo: DateKeyInfo,
): CalendarSource[] {
	const entitiesPerSource = new Map<string, Set<string>>();
	for (const item of items) {
		let set = entitiesPerSource.get(item.sourceKey);
		if (!set) {
			set = new Set<string>();
			entitiesPerSource.set(item.sourceKey, set);
		}
		set.add(item.sourceEntityId);
	}
	const sources: CalendarSource[] = [];
	for (const [key, set] of entitiesPerSource) {
		sources.push({
			key,
			label: labelForSourceKey(key, dateKeyInfo),
			color: colorForSourceKey(key),
			count: set.size,
		});
	}
	sources.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
	return sources;
}
