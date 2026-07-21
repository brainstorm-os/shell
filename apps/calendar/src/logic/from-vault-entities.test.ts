import { IconKind, yearlyRecurrenceForDate } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	JOURNAL_ENTRY_TYPE,
	NOTE_ENTITY_TYPE,
	PERSON_ENTITY_TYPE,
	TASK_ENTITY_TYPE,
	type VaultEntity,
	type VaultSnapshot,
} from "../runtime";
import { EVENT_TYPE } from "../storage/entities-repository";
import type { Event } from "../types/event";
import {
	buildDateKeyInfo,
	entityToScheduledItems,
	eventToScheduledItem,
	journalEntryToScheduledItem,
	mergeScheduledItems,
	vaultSnapshotToScheduledItems,
} from "./from-vault-entities";
import {
	EVENT_SOURCE_KEY,
	JOURNAL_SOURCE_KEY,
	type ScheduledItem,
	sourceKeyFor,
} from "./scheduled-item";

const MAY_2026 = Date.UTC(2026, 4, 14);

/** Catalog-less default: just the well-known date keys (scheduledAt, dueAt,
 *  birthday, date, …). */
const FALLBACK_KEYS = buildDateKeyInfo([]);

function note(id: string, properties: Record<string, unknown>): VaultEntity {
	return {
		id,
		type: NOTE_ENTITY_TYPE,
		properties,
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
		ownerAppId: "io.brainstorm.notes",
	};
}

function journalEntry(id: string, properties: Record<string, unknown>): VaultEntity {
	return {
		id,
		type: JOURNAL_ENTRY_TYPE,
		properties,
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
		ownerAppId: "io.brainstorm.journal",
	};
}

function task(
	over: Partial<VaultEntity> & { id: string } & { properties?: Record<string, unknown> },
): VaultEntity {
	return {
		id: over.id,
		type: TASK_ENTITY_TYPE,
		properties: over.properties ?? {},
		createdAt: 0,
		updatedAt: 0,
		deletedAt: over.deletedAt ?? null,
		ownerAppId: "io.brainstorm.tasks",
	};
}

function person(
	over: Partial<VaultEntity> & { id: string } & { properties?: Record<string, unknown> },
): VaultEntity {
	return {
		id: over.id,
		type: PERSON_ENTITY_TYPE,
		properties: over.properties ?? {},
		createdAt: 0,
		updatedAt: 0,
		deletedAt: over.deletedAt ?? null,
		ownerAppId: "io.brainstorm.database",
	};
}

function snap(entities: VaultEntity[]): VaultSnapshot {
	return { entities, links: [] };
}

describe("buildDateKeyInfo", () => {
	it("seeds the well-known fallback keys so a sparse catalog still works", () => {
		expect(FALLBACK_KEYS.keys.has("scheduledAt")).toBe(true);
		expect(FALLBACK_KEYS.keys.has("dueAt")).toBe(true);
		expect(FALLBACK_KEYS.keys.has("birthday")).toBe(true);
		expect(FALLBACK_KEYS.names.get("scheduledAt")).toBe("Scheduled");
	});

	it("unions catalog Date defs over the fallback and lets catalog names win", () => {
		const info = buildDateKeyInfo([
			{ key: "reviewOn", name: "Review on" },
			{ key: "scheduledAt", name: "When scheduled" },
		]);
		expect(info.keys.has("reviewOn")).toBe(true);
		expect(info.names.get("reviewOn")).toBe("Review on");
		expect(info.names.get("scheduledAt")).toBe("When scheduled");
	});
});

describe("entityToScheduledItems (catalog-driven)", () => {
	it("emits one item per date-typed property the entity carries", () => {
		const due = Date.UTC(2026, 5, 1);
		const items = entityToScheduledItems(
			task({ id: "t1", properties: { name: "T", scheduledAt: MAY_2026, dueAt: due } }),
			FALLBACK_KEYS,
		);
		const bySource = new Map(items.map((i) => [i.sourceKey, i]));
		expect(bySource.get(sourceKeyFor(TASK_ENTITY_TYPE, "scheduledAt"))?.start).toBe(MAY_2026);
		expect(bySource.get(sourceKeyFor(TASK_ENTITY_TYPE, "dueAt"))?.start).toBe(due);
		expect(items).toHaveLength(2);
	});

	it("returns [] when the entity carries no date property", () => {
		expect(
			entityToScheduledItems(task({ id: "t1", properties: { name: "T" } }), FALLBACK_KEYS),
		).toEqual([]);
	});

	it("composes a deterministic id + carries the sourceEntityId + sourceKey", () => {
		const [item] = entityToScheduledItems(
			task({ id: "abc", properties: { name: "T", scheduledAt: MAY_2026 } }),
			buildDateKeyInfo([{ key: "scheduledAt", name: "Scheduled" }]),
		);
		expect(item?.id).toBe("abc:scheduledAt");
		expect(item?.sourceEntityId).toBe("abc");
		expect(item?.sourceKey).toBe(sourceKeyFor(TASK_ENTITY_TYPE, "scheduledAt"));
	});

	it("is all-day when the value has no time-of-day, timed otherwise (F-040)", () => {
		const midnight = new Date(2026, 5, 9, 0, 0, 0, 0).getTime();
		const [dateOnly] = entityToScheduledItems(
			task({ id: "t1", properties: { name: "Draft", scheduledAt: midnight } }),
			FALLBACK_KEYS,
		);
		expect(dateOnly?.allDay).toBe(true);
		const [timed] = entityToScheduledItems(
			task({
				id: "t2",
				properties: { name: "Standup", scheduledAt: new Date(2026, 5, 9, 9, 30).getTime() },
			}),
			FALLBACK_KEYS,
		);
		expect(timed?.allDay).toBe(false);
	});

	it("carries `done` from completedAt across every projected source (F-028)", () => {
		const items = entityToScheduledItems(
			task({ id: "t1", properties: { name: "T", scheduledAt: MAY_2026, completedAt: MAY_2026 } }),
			FALLBACK_KEYS,
		);
		expect(items.every((i) => i.done)).toBe(true);
		const [open] = entityToScheduledItems(
			task({ id: "t2", properties: { name: "T", scheduledAt: MAY_2026 } }),
			FALLBACK_KEYS,
		);
		expect(open?.done).toBe(false);
	});

	it("prefers name → title → fullName → 'Untitled'", () => {
		const keys = buildDateKeyInfo([{ key: "scheduledAt", name: "Scheduled" }]);
		expect(
			entityToScheduledItems(
				task({ id: "t", properties: { name: "A", title: "B", scheduledAt: MAY_2026 } }),
				keys,
			)[0]?.title,
		).toBe("A");
		expect(
			entityToScheduledItems(
				task({ id: "t", properties: { title: "B", scheduledAt: MAY_2026 } }),
				keys,
			)[0]?.title,
		).toBe("B");
		expect(
			entityToScheduledItems(task({ id: "t", properties: { scheduledAt: MAY_2026 } }), keys)[0]?.title,
		).toBe("Untitled");
	});

	it("ignores non-date keys + implausible values", () => {
		expect(
			entityToScheduledItems(note("n1", { title: "x", count: MAY_2026 }), FALLBACK_KEYS),
		).toEqual([]);
		// `date` is a date key, but 42 is outside the plausible epoch window.
		expect(entityToScheduledItems(note("n2", { date: 42 }), FALLBACK_KEYS)).toEqual([]);
	});

	it("projects a note via a recognized date property", () => {
		const [item] = entityToScheduledItems(
			note("n1", { title: "Launch", date: MAY_2026 }),
			FALLBACK_KEYS,
		);
		expect(item).toMatchObject({
			id: "n1:date",
			sourceKey: sourceKeyFor(NOTE_ENTITY_TYPE, "date"),
			title: "Launch",
			start: MAY_2026,
			allDay: true,
		});
	});

	it("discovers a custom catalog-only date key on any entity type", () => {
		const keys = buildDateKeyInfo([{ key: "reviewOn", name: "Review on" }]);
		const custom: VaultEntity = {
			id: "x1",
			type: "acme/Contract/v1",
			properties: { name: "MSA", reviewOn: MAY_2026 },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
			ownerAppId: "acme",
		};
		const [item] = entityToScheduledItems(custom, keys);
		expect(item?.sourceKey).toBe(sourceKeyFor("acme/Contract/v1", "reviewOn"));
		expect(item?.start).toBe(MAY_2026);
	});

	it("applies the birthday override: yearly recurrence, read-only, framed title", () => {
		const [item] = entityToScheduledItems(
			person({ id: "p1", properties: { name: "Mira", birthday: 1_700_000_000_000 } }),
			FALLBACK_KEYS,
		);
		expect(item).toMatchObject({
			id: "p1:birthday",
			sourceKey: sourceKeyFor(PERSON_ENTITY_TYPE, "birthday"),
			title: "Mira's birthday",
			recurrence: yearlyRecurrenceForDate(1_700_000_000_000),
			readonly: true,
			allDay: true,
		});
	});

	it("passes colorHint + icon through", () => {
		const [item] = entityToScheduledItems(
			task({
				id: "t",
				properties: {
					name: "T",
					scheduledAt: MAY_2026,
					colorHint: "#abc",
					icon: { kind: "emoji", value: "✅" },
				},
			}),
			buildDateKeyInfo([{ key: "scheduledAt", name: "Scheduled" }]),
		);
		expect(item?.colorHint).toBe("#abc");
		expect(item?.icon).toEqual({ kind: IconKind.Emoji, value: "✅" });
	});
});

describe("journalEntryToScheduledItem (9.16.12)", () => {
	it("plots a daily entry as an all-day item on its date", () => {
		const item = journalEntryToScheduledItem(
			journalEntry("journal-2026-05-14", { title: "2026-05-14", body: "shipped it" }),
		);
		expect(item?.sourceKey).toBe(JOURNAL_SOURCE_KEY);
		expect(item?.allDay).toBe(true);
		expect(item?.title).toBe("shipped it");
		expect(new Date(item?.start ?? 0).getDate()).toBe(14);
	});

	it("falls back to a generic title when the body snippet is empty", () => {
		const item = journalEntryToScheduledItem(
			journalEntry("journal-2026-05-14", { title: "2026-05-14" }),
		);
		expect(item?.title).toBe("Journal");
	});

	it("excludes periodic rollups + impossible dates", () => {
		expect(journalEntryToScheduledItem(journalEntry("j", { title: "2026-W20" }))).toBeNull();
		expect(journalEntryToScheduledItem(journalEntry("j", { title: "2026-05" }))).toBeNull();
		expect(journalEntryToScheduledItem(journalEntry("j", { title: "2026-02-30" }))).toBeNull();
	});
});

describe("vaultSnapshotToScheduledItems", () => {
	it("routes journal entries through the title-date projector", () => {
		const out = vaultSnapshotToScheduledItems(
			snap([journalEntry("j", { title: "2026-05-14", body: "log" })]),
			FALLBACK_KEYS,
		);
		expect(out.map((i) => i.sourceKey)).toEqual([JOURNAL_SOURCE_KEY]);
	});

	it("skips calendar-owned Event rows (merged separately)", () => {
		const event: VaultEntity = {
			id: "e1",
			type: EVENT_TYPE,
			properties: { name: "Mtg", start: MAY_2026 },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
			ownerAppId: "io.brainstorm.calendar",
		};
		expect(vaultSnapshotToScheduledItems(snap([event]), FALLBACK_KEYS)).toEqual([]);
	});

	it("emits tasks AND birthdays, skipping soft-deleted rows", () => {
		const out = vaultSnapshotToScheduledItems(
			snap([
				task({ id: "t1", properties: { name: "T", scheduledAt: 50 + MAY_2026 } }),
				person({ id: "p1", properties: { name: "Mira", birthday: 100 + MAY_2026 } }),
				person({ id: "p2", properties: { name: "Gone", birthday: 200 + MAY_2026 }, deletedAt: 9 }),
			]),
			FALLBACK_KEYS,
		);
		expect(out.map((i) => i.sourceEntityId)).toEqual(["t1", "p1"]);
		expect(out.find((i) => i.sourceEntityId === "p1")?.sourceKey).toBe(
			sourceKeyFor(PERSON_ENTITY_TYPE, "birthday"),
		);
	});

	it("sorts by start ascending across sources", () => {
		const out = vaultSnapshotToScheduledItems(
			snap([
				task({ id: "t-late", properties: { name: "Late", scheduledAt: MAY_2026 + 1000 } }),
				task({ id: "t-early", properties: { name: "Early", scheduledAt: MAY_2026 + 100 } }),
				task({ id: "t-mid", properties: { name: "Mid", scheduledAt: MAY_2026 + 500 } }),
			]),
			FALLBACK_KEYS,
		);
		expect(out.map((i) => i.sourceEntityId)).toEqual(["t-early", "t-mid", "t-late"]);
	});

	it("returns an empty list when nothing carries a date", () => {
		const out = vaultSnapshotToScheduledItems(
			snap([task({ id: "t1", properties: { name: "Unscheduled" } }), note("n1", { title: "x" })]),
			FALLBACK_KEYS,
		);
		expect(out).toEqual([]);
	});
});

function makeEvent(over: Partial<Event> = {}): Event {
	return {
		id: "e1",
		title: "Standup",
		icon: null,
		start: 1700000000000,
		end: null,
		allDay: false,
		location: null,
		recurrence: null,
		statusKey: null,
		colorHint: null,
		reminders: [],
		attendees: [],
		timeZone: null,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

describe("eventToScheduledItem", () => {
	it("preserves start / end / allDay / location / colorHint + stamps the Event source key", () => {
		const out = eventToScheduledItem(
			makeEvent({
				id: "abc",
				start: 100,
				end: 200,
				allDay: true,
				location: "Kitchen",
				colorHint: "#abc",
			}),
		);
		expect(out).toMatchObject({
			id: "event:abc",
			sourceKey: EVENT_SOURCE_KEY,
			sourceEntityId: "abc",
			start: 100,
			end: 200,
			allDay: true,
			location: "Kitchen",
			colorHint: "#abc",
		});
	});

	it("carries the event's own icon through (null when unset)", () => {
		expect(eventToScheduledItem(makeEvent({ icon: null })).icon).toBeNull();
		const icon = { kind: IconKind.Emoji, value: "🏔️" } as const;
		expect(eventToScheduledItem(makeEvent({ icon })).icon).toEqual(icon);
	});
});

describe("mergeScheduledItems", () => {
	function item(start: number, sourceEntityId: string): ScheduledItem {
		return {
			id: `i:${sourceEntityId}`,
			sourceKey: EVENT_SOURCE_KEY,
			sourceEntityId,
			title: sourceEntityId,
			icon: null,
			start,
			end: null,
			allDay: false,
			location: null,
			recurrence: null,
			colorHint: null,
		};
	}

	it("returns empty for empty inputs", () => {
		expect(mergeScheduledItems()).toEqual([]);
		expect(mergeScheduledItems([], [])).toEqual([]);
	});

	it("concatenates + sorts ascending by start", () => {
		const out = mergeScheduledItems(
			[item(1000, "late"), item(100, "early-a")],
			[item(500, "mid")],
			[item(200, "early-b")],
		);
		expect(out.map((i) => i.sourceEntityId)).toEqual(["early-a", "early-b", "mid", "late"]);
	});
});
