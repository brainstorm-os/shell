/**
 * CalDAV two-way sync engine (9.15.19) — one `syncCalendar` pass for one
 * subscribed `CalDavCalendar/v1`, pure over injected ports (the protocol
 * client and the entities surface), so the whole two-way story is
 * unit-tested without a server or Electron.
 *
 * Pass shape (pull first, then push — the pull refreshes the etags the
 * push guards on):
 *   1. **Pull** — RFC 6578 delta (or full etag listing when the token is
 *      missing/expired) → multiget changed objects → upsert as
 *      `brainstorm/Event/v1` rows keyed on the connector dedupe key
 *      (`caldav:<href>`); server-removed hrefs delete the local row.
 *   2. **Push creates** — local events tagged to this calendar with no
 *      server href yet → `PUT If-None-Match: *`.
 *   3. **Push updates** — local rows whose `updatedAt` moved past the
 *      `syncedUpdatedAt` watermark → `PUT If-Match: <etag>`.
 *   4. **Push deletes** — hrefs in the persisted `knownHrefs` ledger with
 *      no surviving local row → `DELETE If-Match: <etag>`.
 *
 * **Conflict policy (v1, documented): server-wins-with-local-redo.** Any
 * etag mismatch (a 412, or a pull that lands on a locally-dirty row)
 * resolves by adopting the server copy locally and counting a conflict in
 * the run summary — the local edit is surfaced as "redo it", never
 * silently force-pushed. Deterministic, lossless on the server, and the
 * cheapest correct policy until CRDT-backed property merge (doc 19) and
 * the snapshot the engine writes locally are visibly diffable in-app.
 *
 * Idempotency: re-running a pass against an unchanged server is a no-op —
 * upserts compare etags against `knownHrefs`, pushes key off the
 * `syncedUpdatedAt` watermark.
 */

import { CALDAV_CALENDAR_REF_PROP, type CalDavSyncSummary } from "@brainstorm-os/sdk-types";
import { type CalDavClient, type CalendarObject, DeleteOutcome, PutOutcome } from "./caldav-client";
import { parseVEvent, serializeVEvent } from "./vevent-codec";

export const EVENT_TYPE_URL = "brainstorm/Event/v1";
/** Same flat dedupe-key property the generic connector engine uses. */
export const CONNECTOR_EXTERNAL_ID_PROP = "connectorExternalId";
/** Provenance + round-trip handle (href/etag/uid/watermarks). */
export const CALDAV_SOURCE_PROP = "caldav.source";

export function caldavExternalKey(href: string): string {
	return `caldav:${href}`;
}

export type CalDavSource = {
	href: string;
	etag: string | null;
	uid: string;
	calendarRef: string;
	syncedAt: string;
	/** The `updatedAt` value as of the last successful sync of this row —
	 *  a local edit moves `updatedAt` off this watermark (clock-skew-proof,
	 *  unlike comparing against `syncedAt`). */
	syncedUpdatedAt: number;
};

export type LocalEventRow = {
	id: string;
	properties: Record<string, unknown>;
};

export type CalDavSyncPorts = {
	client: Pick<
		CalDavClient,
		"syncCollection" | "listEventHrefs" | "multiGet" | "putEvent" | "deleteEvent"
	>;
	/** Live `Event/v1` rows tagged with this calendar's ref. */
	listLocalEvents(calendarRef: string): Promise<LocalEventRow[]>;
	createEntity(type: string, properties: Record<string, unknown>): Promise<{ id: string }>;
	updateEntity(id: string, patch: Record<string, unknown>): Promise<void>;
	deleteEntity(id: string): Promise<void>;
	now(): number;
	newUid(): string;
};

export type CalDavCalendarState = {
	calendarRef: string;
	calendarUrl: string;
	syncToken: string | null;
	/** href → last-seen server etag ("" when unknown). */
	knownHrefs: Record<string, string>;
};

export type CalDavSyncOutcome = {
	summary: CalDavSyncSummary;
	nextSyncToken: string | null;
	knownHrefs: Record<string, string>;
};

function readSource(row: LocalEventRow): CalDavSource | null {
	const raw = row.properties[CALDAV_SOURCE_PROP];
	if (!raw || typeof raw !== "object") return null;
	const s = raw as Record<string, unknown>;
	if (typeof s.href !== "string" || typeof s.uid !== "string") return null;
	return {
		href: s.href,
		etag: typeof s.etag === "string" ? s.etag : null,
		uid: s.uid,
		calendarRef: typeof s.calendarRef === "string" ? s.calendarRef : "",
		syncedAt: typeof s.syncedAt === "string" ? s.syncedAt : "",
		syncedUpdatedAt: typeof s.syncedUpdatedAt === "number" ? s.syncedUpdatedAt : 0,
	};
}

function isLocallyDirty(row: LocalEventRow, source: CalDavSource): boolean {
	const updatedAt = row.properties.updatedAt;
	return typeof updatedAt === "number" && updatedAt !== source.syncedUpdatedAt;
}

export class CalDavSyncEngine {
	constructor(private readonly ports: CalDavSyncPorts) {}

	async syncCalendar(state: CalDavCalendarState): Promise<CalDavSyncOutcome> {
		const startedAt = new Date(this.ports.now()).toISOString();
		const knownHrefs = { ...state.knownHrefs };
		const summary: CalDavSyncSummary = {
			calendarRef: state.calendarRef,
			pulled: 0,
			pushedCreated: 0,
			pushedUpdated: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			conflicts: 0,
			startedAt,
			finishedAt: startedAt,
		};

		const localRows = await this.ports.listLocalEvents(state.calendarRef);
		const byHref = new Map<string, LocalEventRow>();
		const createsPending: LocalEventRow[] = [];
		for (const row of localRows) {
			const source = readSource(row);
			if (source) byHref.set(source.href, row);
			else createsPending.push(row);
		}

		// ── 1. Pull ──────────────────────────────────────────────────────
		const delta = await this.resolveDelta(state, knownHrefs);
		const pulledHrefs = new Set<string>();

		const toFetch = delta.changed.filter(
			(c) => c.etag === null || knownHrefs[c.href] !== c.etag || !byHref.has(c.href),
		);
		if (toFetch.length > 0) {
			const objects = await this.ports.client.multiGet(
				state.calendarUrl,
				toFetch.map((c) => c.href),
			);
			for (const object of objects) {
				const applied = await this.applyServerObject(state, object, byHref, knownHrefs);
				if (applied === null) continue;
				pulledHrefs.add(object.href);
				summary.pulled += 1;
				if (applied.conflicted) summary.conflicts += 1;
			}
		}

		for (const href of delta.removed) {
			const row = byHref.get(href);
			if (row) {
				await this.ports.deleteEntity(row.id);
				byHref.delete(href);
				summary.deletedLocal += 1;
			}
			delete knownHrefs[href];
		}

		// ── 2. Push creates ──────────────────────────────────────────────
		for (const row of createsPending) {
			const uid = this.ports.newUid();
			const href = new URL(`${encodeURIComponent(uid)}.ics`, state.calendarUrl).toString();
			const ics = serializeVEvent({ uid, properties: row.properties, now: this.ports.now() });
			if (ics === null) continue;
			const put = await this.ports.client.putEvent({ url: href, ics });
			if (put.outcome === PutOutcome.Conflict) {
				// A fresh UID collided — overwhelmingly a re-run that already
				// created it; adopt the server copy (server wins).
				summary.conflicts += await this.adoptServerCopy(state, href, byHref, knownHrefs, row);
				continue;
			}
			await this.markSynced(row, {
				href,
				etag: put.etag,
				uid,
				calendarRef: state.calendarRef,
			});
			byHref.set(href, row);
			knownHrefs[href] = put.etag ?? "";
			summary.pushedCreated += 1;
		}

		// ── 3. Push updates ──────────────────────────────────────────────
		for (const [href, row] of byHref) {
			if (pulledHrefs.has(href)) continue; // server already won this pass
			const source = readSource(row);
			if (!source || !isLocallyDirty(row, source)) continue;
			const ics = serializeVEvent({
				uid: source.uid,
				properties: row.properties,
				now: this.ports.now(),
			});
			if (ics === null) continue;
			const put = await this.ports.client.putEvent({
				url: href,
				ics,
				...(source.etag !== null && source.etag.length > 0 ? { etag: source.etag } : {}),
			});
			if (put.outcome === PutOutcome.Conflict) {
				summary.conflicts += await this.adoptServerCopy(state, href, byHref, knownHrefs, row);
				continue;
			}
			await this.markSynced(row, {
				href,
				etag: put.etag,
				uid: source.uid,
				calendarRef: state.calendarRef,
			});
			knownHrefs[href] = put.etag ?? "";
			summary.pushedUpdated += 1;
		}

		// ── 4. Push deletes ──────────────────────────────────────────────
		for (const href of Object.keys(knownHrefs)) {
			if (byHref.has(href)) continue;
			const etag = knownHrefs[href];
			const outcome = await this.ports.client.deleteEvent(
				href,
				etag !== undefined && etag.length > 0 ? etag : undefined,
			);
			if (outcome === DeleteOutcome.Conflict) {
				// The server copy moved since deletion — server wins: pull it back.
				summary.conflicts += await this.adoptServerCopy(state, href, byHref, knownHrefs, null);
				continue;
			}
			delete knownHrefs[href];
			summary.deletedRemote += 1;
		}

		summary.finishedAt = new Date(this.ports.now()).toISOString();
		return {
			summary,
			nextSyncToken: delta.nextSyncToken ?? state.syncToken,
			knownHrefs,
		};
	}

	private async resolveDelta(
		state: CalDavCalendarState,
		knownHrefs: Record<string, string>,
	): Promise<{
		changed: { href: string; etag: string | null }[];
		removed: string[];
		nextSyncToken: string | null;
	}> {
		const sync = await this.ports.client.syncCollection(state.calendarUrl, state.syncToken);
		if (!sync.fullResyncRequired) {
			return { changed: sync.changed, removed: sync.removed, nextSyncToken: sync.syncToken };
		}
		// Token expired / unsupported: full listing diffed against the ledger.
		const listing = await this.ports.client.listEventHrefs(state.calendarUrl);
		const present = new Set(listing.map((entry) => entry.href));
		const changed = listing.filter(
			(entry) => entry.etag === null || knownHrefs[entry.href] !== entry.etag,
		);
		const removed = Object.keys(knownHrefs).filter((href) => !present.has(href));
		return { changed, removed, nextSyncToken: null };
	}

	/** Upsert one fetched calendar object. Returns conflict info, or null
	 *  when the payload had no usable VEVENT. */
	private async applyServerObject(
		state: CalDavCalendarState,
		object: CalendarObject,
		byHref: Map<string, LocalEventRow>,
		knownHrefs: Record<string, string>,
	): Promise<{ conflicted: boolean } | null> {
		const parsed = parseVEvent(object.ics, this.ports.now());
		if (parsed === null) return null;

		const source: CalDavSource = {
			href: object.href,
			etag: object.etag,
			uid: parsed.uid,
			calendarRef: state.calendarRef,
			syncedAt: new Date(this.ports.now()).toISOString(),
			syncedUpdatedAt: (parsed.properties.updatedAt as number | undefined) ?? this.ports.now(),
		};
		const properties: Record<string, unknown> = {
			...parsed.properties,
			[CONNECTOR_EXTERNAL_ID_PROP]: caldavExternalKey(object.href),
			[CALDAV_CALENDAR_REF_PROP]: state.calendarRef,
			[CALDAV_SOURCE_PROP]: source,
		};

		const existing = byHref.get(object.href);
		let conflicted = false;
		if (existing) {
			const existingSource = readSource(existing);
			conflicted = existingSource !== null && isLocallyDirty(existing, existingSource);
			await this.ports.updateEntity(existing.id, properties);
			existing.properties = { ...existing.properties, ...properties };
		} else {
			const created = await this.ports.createEntity(EVENT_TYPE_URL, properties);
			byHref.set(object.href, { id: created.id, properties });
		}
		knownHrefs[object.href] = object.etag ?? "";
		return { conflicted };
	}

	/** Server-wins resolution: fetch the server copy at `href` and apply it
	 *  over the local row (when given). Returns the number of conflicts to
	 *  count (1 when something was adopted, 1 even when the fetch came back
	 *  empty — the push WAS refused). */
	private async adoptServerCopy(
		state: CalDavCalendarState,
		href: string,
		byHref: Map<string, LocalEventRow>,
		knownHrefs: Record<string, string>,
		localRow: LocalEventRow | null,
	): Promise<number> {
		if (localRow && !byHref.has(href)) byHref.set(href, localRow);
		const objects = await this.ports.client.multiGet(state.calendarUrl, [href]);
		const object = objects.find((o) => o.href === href) ?? objects[0];
		if (object) await this.applyServerObject(state, object, byHref, knownHrefs);
		return 1;
	}

	private async markSynced(
		row: LocalEventRow,
		coords: { href: string; etag: string | null; uid: string; calendarRef: string },
	): Promise<void> {
		const source: CalDavSource = {
			...coords,
			syncedAt: new Date(this.ports.now()).toISOString(),
			syncedUpdatedAt: (row.properties.updatedAt as number | undefined) ?? this.ports.now(),
		};
		const patch: Record<string, unknown> = {
			[CONNECTOR_EXTERNAL_ID_PROP]: caldavExternalKey(coords.href),
			[CALDAV_CALENDAR_REF_PROP]: coords.calendarRef,
			[CALDAV_SOURCE_PROP]: source,
		};
		await this.ports.updateEntity(row.id, patch);
		row.properties = { ...row.properties, ...patch };
	}
}
