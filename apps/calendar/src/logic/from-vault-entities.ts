/**
 * Project a vault snapshot to `ScheduledItem` rows.
 *
 * **Long-term keystone**: the renderer never branches on a fixed source set —
 * it consumes the unified `ScheduledItem` shape. Placement is **catalog-
 * driven** (9.15f): any entity carrying a `Date`-typed property (per the
 * property catalog, with a built-in well-known fallback) is plotted on that
 * date, once per date property it carries. Each `(entity type · property)`
 * pair becomes its own toggleable source.
 *
 * Two projections aren't a plain numeric date property and keep dedicated
 * paths:
 *   - `Journal/Entry/v1` — plotted from its strict `YYYY-MM-DD` title
 *     (9.16.12); periodic rollups (`YYYY-Www` / `YYYY-MM`) never match.
 *   - Calendar-owned `Event/v1` — carries its own start/end/recurrence and is
 *     merged separately in `app.tsx` from Calendar's own repo, so it's skipped
 *     in the vault walk to avoid a double projection.
 *
 * Behaviour deltas for specific sources (yearly birthdays, read-only dates,
 * title framing) live in `SOURCE_OVERRIDES` — the single seam, not a per-type
 * `if` ladder.
 */

import { yearlyRecurrenceForDate } from "@brainstorm-os/sdk-types";
import { parseIcon } from "@brainstorm-os/sdk/entity-icon";
import { type TKey, t } from "../i18n/t";
import { JOURNAL_ENTRY_TYPE, type VaultEntity, type VaultSnapshot } from "../runtime";
import { EVENT_TYPE } from "../storage/entities-repository";
import type { Event } from "../types/event";
import {
	EVENT_SOURCE_KEY,
	JOURNAL_SOURCE_KEY,
	SOURCE_OVERRIDES,
	type ScheduledItem,
	sourceKeyFor,
} from "./scheduled-item";

/** Well-known date-property keys + their default display names, used as a
 *  fallback when the vault property catalog is sparse (a production / dogfood
 *  vault that never ran the dev catalog seeder — the F-152 trap). The live
 *  catalog's `ValueType.Date` defs are unioned over this in `buildDateKeyInfo`,
 *  and a catalog `name` wins for a shared key. */
export const WELL_KNOWN_DATE_KEYS: Readonly<Record<string, string>> = Object.freeze({
	scheduledAt: "Scheduled",
	dueAt: "Due",
	completedAt: "Completed",
	birthday: "Birthday",
	date: "Date",
	eventDate: "Event date",
	startDate: "Start date",
	dueDate: "Due date",
	deadline: "Deadline",
	when: "When",
});

/** The set of property keys treated as dates, plus a display name per key. */
export type DateKeyInfo = {
	keys: ReadonlySet<string>;
	names: ReadonlyMap<string, string>;
};

/** Build the date-key set from the catalog's `Date`-typed defs unioned with the
 *  well-known fallback. Catalog names win; fallback keys absent from the
 *  catalog stay so current behaviour never regresses. */
export function buildDateKeyInfo(
	catalogDateDefs: readonly { key: string; name: string }[],
): DateKeyInfo {
	const names = new Map<string, string>();
	for (const [key, name] of Object.entries(WELL_KNOWN_DATE_KEYS)) names.set(key, name);
	for (const def of catalogDateDefs) {
		if (def.key.length > 0) names.set(def.key, def.name);
	}
	return { keys: new Set(names.keys()), names };
}

// Plausible epoch-ms window (2001-01-01 … 2100-01-01) so a stray small
// number under a date-ish key doesn't plot a 1970 ghost.
const MIN_PLAUSIBLE_MS = Date.UTC(2001, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

/** True when `epochMs` carries a date but no meaningful time-of-day — it falls
 *  on midnight in either the local zone OR UTC. Date-only values land on UTC
 *  midnight (the seeder / Contacts store birthdays that way), so a local-only
 *  check would mis-tag them as timed in any non-UTC zone (F-040). */
function isDateOnly(epochMs: number): boolean {
	const d = new Date(epochMs);
	const localMidnight =
		d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
	const utcMidnight =
		d.getUTCHours() === 0 &&
		d.getUTCMinutes() === 0 &&
		d.getUTCSeconds() === 0 &&
		d.getUTCMilliseconds() === 0;
	return localMidnight || utcMidnight;
}

function isPlausibleDate(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_PLAUSIBLE_MS &&
		value <= MAX_PLAUSIBLE_MS
	);
}

/** Best title for an arbitrary entity: `name` → `title` → `fullName` → a
 *  localized fallback. */
function entityTitle(props: Record<string, unknown>): string {
	if (typeof props.name === "string" && props.name.length > 0) return props.name;
	if (typeof props.title === "string" && props.title.length > 0) return props.title;
	if (typeof props.fullName === "string" && props.fullName.length > 0) return props.fullName;
	return t("calendar.item.untitled");
}

/** Project one entity to a `ScheduledItem` per date-typed property it carries
 *  with a plausible numeric value. The empty array means "nothing to plot". */
export function entityToScheduledItems(
	entity: VaultEntity,
	dateKeyInfo: DateKeyInfo,
): ScheduledItem[] {
	const props = entity.properties;
	const out: ScheduledItem[] = [];
	const title = entityTitle(props);
	const icon = parseIcon(props.icon);
	const colorHint = typeof props.colorHint === "string" ? props.colorHint : null;
	const done = props.completedAt != null;
	for (const key of dateKeyInfo.keys) {
		const value = props[key];
		if (!isPlausibleDate(value)) continue;
		const sourceKey = sourceKeyFor(entity.type, key);
		const override = SOURCE_OVERRIDES[sourceKey];
		out.push({
			id: `${entity.id}:${key}`,
			sourceKey,
			sourceEntityId: entity.id,
			title: override?.titleTemplateKey
				? t(override.titleTemplateKey as TKey, { name: title })
				: title,
			icon,
			start: value,
			end: null,
			allDay: override?.allDay ?? isDateOnly(value),
			location: null,
			recurrence: override?.yearlyRecurrence ? yearlyRecurrenceForDate(value) : null,
			colorHint,
			...(override?.readonly ? { readonly: true } : {}),
			done,
		});
	}
	return out;
}

// Strict daily journal-entry title (`YYYY-MM-DD`) — periodic rollups
// (`YYYY-Www` / `YYYY-MM`) deliberately don't match, so they never plot.
const JOURNAL_DAILY_TITLE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local-midnight epoch for a strict daily journal title, or null. Rejects
 *  impossible dates (Feb 30) via a round-trip check. */
function journalDailyDateMs(title: string): number | null {
	const m = JOURNAL_DAILY_TITLE_RE.exec(title);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const probe = new Date(year, month - 1, day);
	if (probe.getFullYear() !== year || probe.getMonth() + 1 !== month || probe.getDate() !== day) {
		return null;
	}
	return probe.getTime();
}

/** Convert a daily `Journal/Entry/v1` to an all-day `ScheduledItem` on its
 *  date (9.16.12). Returns `null` for periodic rollups or a non-date title.
 *  The chip title is the entry's body snippet when present, else a generic
 *  "Journal" label. */
export function journalEntryToScheduledItem(entity: VaultEntity): ScheduledItem | null {
	if (entity.type !== JOURNAL_ENTRY_TYPE) return null;
	const props = entity.properties;
	const title = typeof props.title === "string" ? props.title : "";
	const date = journalDailyDateMs(title);
	if (date === null) return null;
	const snippet = typeof props.body === "string" && props.body.trim().length > 0 ? props.body : null;
	return {
		id: `journal:${entity.id}`,
		sourceKey: JOURNAL_SOURCE_KEY,
		sourceEntityId: entity.id,
		title: snippet ?? t("calendar.item.journal"),
		icon: parseIcon(props.icon),
		start: date,
		end: null,
		allDay: true,
		location: null,
		recurrence: null,
		colorHint: typeof props.colorHint === "string" ? props.colorHint : null,
	};
}

/** Project the full snapshot. Journal entries plot from their title; every
 *  other live entity goes through the catalog-driven date-property projector.
 *  Calendar-owned Events are skipped (merged separately) and soft-deleted rows
 *  are dropped. */
export function vaultSnapshotToScheduledItems(
	snapshot: VaultSnapshot,
	dateKeyInfo: DateKeyInfo,
): ScheduledItem[] {
	const out: ScheduledItem[] = [];
	for (const entity of snapshot.entities) {
		if (entity.deletedAt !== null) continue;
		if (entity.type === EVENT_TYPE) continue;
		if (entity.type === JOURNAL_ENTRY_TYPE) {
			const item = journalEntryToScheduledItem(entity);
			if (item) out.push(item);
			continue;
		}
		for (const item of entityToScheduledItems(entity, dateKeyInfo)) out.push(item);
	}
	out.sort((a, b) => a.start - b.start);
	return out;
}

/** Convert a single Calendar-owned `Event/v1` row to a `ScheduledItem`.
 *  Events are the *primary* Calendar entity — they carry their own
 *  start / end / allDay / location / recurrence so the projection is
 *  almost a 1:1 mapping. */
export function eventToScheduledItem(event: Event): ScheduledItem {
	return {
		id: `event:${event.id}`,
		sourceKey: EVENT_SOURCE_KEY,
		sourceEntityId: event.id,
		title: event.title,
		icon: event.icon ?? null,
		start: event.start,
		end: event.end,
		allDay: event.allDay,
		location: event.location,
		recurrence: event.recurrence,
		colorHint: event.colorHint,
		statusKey: event.statusKey,
		attendeeCount: event.attendees.length,
		timeZone: event.timeZone,
	};
}

/** Merge per-source projections into one sorted `ScheduledItem[]`.
 *  Each input array can be empty; the output is sorted ascending by
 *  `start` so the renderer's compile-view passes get a stable order. */
export function mergeScheduledItems(
	...lists: readonly (readonly ScheduledItem[])[]
): ScheduledItem[] {
	const out: ScheduledItem[] = [];
	for (const list of lists) {
		for (const item of list) out.push(item);
	}
	out.sort((a, b) => a.start - b.start);
	return out;
}
