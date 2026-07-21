/**
 * VEVENT ↔ `brainstorm/Event/v1` property-bag codec for the CalDAV sync
 * engine (9.15.19).
 *
 * Deliberately separate from the Calendar app's file import/export codec
 * (`apps/calendar/src/logic/ics.ts`): that one maps to the app's typed
 * `Event` and treats times as floating local wall-clock (its file-import
 * contract); this one targets the raw entity property bag the engine
 * writes through the entities service, and must understand the zoned
 * times real CalDAV servers emit — `DTSTART;TZID=…` is converted to an
 * epoch instant via `Intl` (no tz database dependency) and the IANA id is
 * kept on the `timeZone` property. RRULE rides the one shared
 * `@brainstorm-os/sdk-types` structured-Recurrence codec.
 *
 * Push serialisation emits timed events as UTC instants (`DTSTART:…Z`) —
 * lossless on the instant, universally accepted; the original TZID
 * context is not round-tripped on a local edit (documented v1 limit).
 * Server fields outside the Event/v1 model (ORGANIZER, CATEGORIES,
 * custom X-props) are likewise not preserved by a push — the
 * server-wins conflict policy bounds the blast radius.
 */

import {
	type Recurrence,
	isRecurrence,
	recurrenceToRRule,
	rruleToRecurrence,
} from "@brainstorm-os/sdk-types";

// Wire values mirror the Calendar app's catalogs (`apps/calendar/src/types/
// attendee.ts`, `logic/event-status.ts`) — the entity property contract.
const RsvpKey = {
	NeedsAction: "needs-action",
	Accepted: "accepted",
	Declined: "declined",
	Tentative: "tentative",
} as const;
type RsvpKey = (typeof RsvpKey)[keyof typeof RsvpKey];

const StatusKey = {
	Confirmed: "confirmed",
	Tentative: "tentative",
	Cancelled: "cancelled",
} as const;
type StatusKey = (typeof StatusKey)[keyof typeof StatusKey];

const PARTSTAT_TO_RSVP: Readonly<Record<string, RsvpKey>> = {
	ACCEPTED: RsvpKey.Accepted,
	DECLINED: RsvpKey.Declined,
	TENTATIVE: RsvpKey.Tentative,
	"NEEDS-ACTION": RsvpKey.NeedsAction,
};

const RSVP_TO_PARTSTAT: Readonly<Record<RsvpKey, string>> = {
	[RsvpKey.Accepted]: "ACCEPTED",
	[RsvpKey.Declined]: "DECLINED",
	[RsvpKey.Tentative]: "TENTATIVE",
	[RsvpKey.NeedsAction]: "NEEDS-ACTION",
};

const ICS_TO_STATUS: Readonly<Record<string, StatusKey>> = {
	CONFIRMED: StatusKey.Confirmed,
	TENTATIVE: StatusKey.Tentative,
	CANCELLED: StatusKey.Cancelled,
};

const STATUS_TO_ICS: Readonly<Record<StatusKey, string>> = {
	[StatusKey.Confirmed]: "CONFIRMED",
	[StatusKey.Tentative]: "TENTATIVE",
	[StatusKey.Cancelled]: "CANCELLED",
};

export type ParsedVEvent = {
	uid: string;
	/** `brainstorm/Event/v1` properties (no `id` — the entity id is local). */
	properties: Record<string, unknown>;
};

// ── ICS line primitives ───────────────────────────────────────────────

const MAX_LINE = 73;

function unfold(text: string): string[] {
	const raw = text.split(/\r\n|\n|\r/);
	const out: string[] = [];
	for (const line of raw) {
		if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
			out[out.length - 1] += line.slice(1);
		} else if (line.length > 0) {
			out.push(line);
		}
	}
	return out;
}

function foldLine(line: string): string {
	if (line.length <= MAX_LINE) return line;
	const chunks: string[] = [line.slice(0, MAX_LINE)];
	let rest = line.slice(MAX_LINE);
	while (rest.length > 0) {
		chunks.push(` ${rest.slice(0, MAX_LINE - 1)}`);
		rest = rest.slice(MAX_LINE - 1);
	}
	return chunks.join("\r\n");
}

function escapeText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/,/g, "\\,")
		.replace(/;/g, "\\;");
}

function unescapeText(value: string): string {
	return value.replace(/\\([\\;,nN])/g, (_match, ch: string) =>
		ch === "n" || ch === "N" ? "\n" : ch,
	);
}

type IcsProp = { name: string; params: Map<string, string>; value: string };

function splitProperty(line: string): IcsProp | null {
	let colon = -1;
	let inQuote = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') inQuote = !inQuote;
		else if (ch === ":" && !inQuote) {
			colon = i;
			break;
		}
	}
	if (colon < 0) return null;
	const head = line.slice(0, colon);
	const value = line.slice(colon + 1);

	const segments: string[] = [];
	let buf = "";
	inQuote = false;
	for (const ch of head) {
		if (ch === '"') {
			inQuote = !inQuote;
			buf += ch;
		} else if (ch === ";" && !inQuote) {
			segments.push(buf);
			buf = "";
		} else {
			buf += ch;
		}
	}
	segments.push(buf);

	const name = (segments.shift() ?? "").toUpperCase();
	if (name.length === 0) return null;
	const params = new Map<string, string>();
	for (const seg of segments) {
		const eq = seg.indexOf("=");
		if (eq <= 0) continue;
		let paramValue = seg.slice(eq + 1).trim();
		if (paramValue.startsWith('"') && paramValue.endsWith('"')) {
			paramValue = paramValue.slice(1, -1);
		}
		params.set(seg.slice(0, eq).toUpperCase(), paramValue);
	}
	return { name, params, value };
}

// ── Zoned time (no tz database — Intl does the lookup) ───────────────

function tzOffsetAt(utcMs: number, timeZone: string): number {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts: Record<string, number> = {};
	for (const part of dtf.formatToParts(new Date(utcMs))) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	const asUtc = Date.UTC(
		parts.year ?? 1970,
		(parts.month ?? 1) - 1,
		parts.day ?? 1,
		// Intl emits hour 24 for midnight under hour12:false + 2-digit.
		(parts.hour ?? 0) % 24,
		parts.minute ?? 0,
		parts.second ?? 0,
	);
	return asUtc - utcMs;
}

/** Epoch ms of a wall-clock time in an IANA zone. Two-pass offset fix
 *  handles DST edges; an unknown zone throws (caller degrades). */
function zonedWallTimeToEpoch(
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number,
	s: number,
	timeZone: string,
): number {
	const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
	let ts = wallAsUtc;
	for (let i = 0; i < 2; i++) {
		ts = wallAsUtc - tzOffsetAt(ts, timeZone);
	}
	return ts;
}

function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

type ParsedDate = { ms: number; dateOnly: boolean; timeZone: string | null };

function parseIcsDate(value: string, params: Map<string, string>): ParsedDate | null {
	const v = value.trim();
	const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
	if (dateMatch || params.get("VALUE") === "DATE") {
		const m = dateMatch ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
		if (!m) return null;
		return {
			ms: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(),
			dateOnly: true,
			timeZone: null,
		};
	}
	const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
	if (!dt) return null;
	const [y, mo, d, h, mi, s] = [dt[1], dt[2], dt[3], dt[4], dt[5], dt[6]].map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	if (dt[7]) {
		return { ms: Date.UTC(y, mo - 1, d, h, mi, s), dateOnly: false, timeZone: null };
	}
	const tzid = params.get("TZID");
	if (tzid && isValidTimeZone(tzid)) {
		return {
			ms: zonedWallTimeToEpoch(y, mo, d, h, mi, s, tzid),
			dateOnly: false,
			timeZone: tzid,
		};
	}
	// Floating (or unknown TZID): local wall-clock, the app's native model.
	return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), dateOnly: false, timeZone: null };
}

function parseTrigger(value: string): number | null {
	const m = /^[+-]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
		value.trim().toUpperCase(),
	);
	if (!m) return null;
	const [w, d, h, min, s] = [m[1], m[2], m[3], m[4], m[5]].map((x) => (x ? Number(x) : 0));
	return (
		(w ?? 0) * 7 * 1440 + (d ?? 0) * 1440 + (h ?? 0) * 60 + (min ?? 0) + Math.round((s ?? 0) / 60)
	);
}

// ── Parse ─────────────────────────────────────────────────────────────

type Attendee = { name: string; email: string | null; rsvp: RsvpKey };

/** First VEVENT of a calendar object → Event/v1 properties. Returns null
 *  when there is no usable VEVENT (no UID-bearing component with a
 *  DTSTART) — a malformed server payload is skipped, never thrown. */
export function parseVEvent(ics: string, now: number): ParsedVEvent | null {
	const lines = unfold(ics);

	let uid: string | null = null;
	let summary: string | null = null;
	let description: string | null = null;
	let location: string | null = null;
	let start: ParsedDate | null = null;
	let end: ParsedDate | null = null;
	let recurrence: Recurrence | null = null;
	let statusKey: StatusKey | null = null;
	let createdAt: number | null = null;
	let updatedAt: number | null = null;
	const attendees: Attendee[] = [];
	const reminders: number[] = [];

	let inEvent = false;
	let inAlarm = false;
	let inTimezone = false;
	let alarmTrigger: number | null = null;

	for (const line of lines) {
		const upper = line.toUpperCase();
		if (upper === "BEGIN:VTIMEZONE") {
			inTimezone = true;
			continue;
		}
		if (upper === "END:VTIMEZONE") {
			inTimezone = false;
			continue;
		}
		if (inTimezone) continue;
		if (upper === "BEGIN:VEVENT") {
			if (inEvent) break; // only the first VEVENT (overrides are v2)
			inEvent = true;
			continue;
		}
		if (upper === "END:VEVENT") break;
		if (!inEvent) continue;
		if (upper === "BEGIN:VALARM") {
			inAlarm = true;
			alarmTrigger = null;
			continue;
		}
		if (upper === "END:VALARM") {
			if (alarmTrigger !== null) reminders.push(alarmTrigger);
			inAlarm = false;
			continue;
		}

		const prop = splitProperty(line);
		if (!prop) continue;
		if (inAlarm) {
			if (prop.name === "TRIGGER") alarmTrigger = parseTrigger(prop.value);
			continue;
		}

		switch (prop.name) {
			case "UID":
				uid = prop.value.trim() || null;
				break;
			case "SUMMARY":
				summary = unescapeText(prop.value);
				break;
			case "DESCRIPTION":
				description = unescapeText(prop.value);
				break;
			case "LOCATION":
				location = unescapeText(prop.value);
				break;
			case "DTSTART":
				start = parseIcsDate(prop.value, prop.params);
				break;
			case "DTEND":
				end = parseIcsDate(prop.value, prop.params);
				break;
			case "RRULE":
				recurrence = rruleToRecurrence(prop.value);
				break;
			case "STATUS":
				statusKey = ICS_TO_STATUS[prop.value.trim().toUpperCase()] ?? null;
				break;
			case "CREATED":
				createdAt = parseIcsDate(prop.value, prop.params)?.ms ?? null;
				break;
			case "LAST-MODIFIED":
				updatedAt = parseIcsDate(prop.value, prop.params)?.ms ?? null;
				break;
			case "DTSTAMP":
				if (updatedAt === null) updatedAt = parseIcsDate(prop.value, prop.params)?.ms ?? null;
				break;
			case "ATTENDEE": {
				const email = prop.value.replace(/^mailto:/i, "").trim();
				const name = prop.params.get("CN") ?? "";
				if (name.length === 0 && email.length === 0) break;
				const partstat = prop.params.get("PARTSTAT")?.toUpperCase() ?? "";
				attendees.push({
					name: name.length > 0 ? name : email,
					email: email.length > 0 ? email : null,
					rsvp: PARTSTAT_TO_RSVP[partstat] ?? RsvpKey.NeedsAction,
				});
				break;
			}
		}
	}

	if (uid === null || start === null) return null;

	const allDay = start.dateOnly;
	const endMs = allDay || end === null || end.dateOnly ? null : end.ms;
	const properties: Record<string, unknown> = {
		title: summary ?? "(untitled)",
		// Null (not absent) so an upsert patch clears a stale local value.
		description: description !== null && description.length > 0 ? description : null,
		icon: null,
		start: start.ms,
		end: endMs !== null && endMs < start.ms ? null : endMs,
		allDay,
		location: location !== null && location.length > 0 ? location : null,
		recurrence: isRecurrence(recurrence) ? recurrence : null,
		statusKey,
		colorHint: null,
		reminders: [...new Set(reminders)].sort((a, b) => a - b),
		attendees,
		timeZone: start.timeZone,
		createdAt: createdAt ?? now,
		updatedAt: updatedAt ?? now,
	};
	return { uid, properties };
}

// ── Serialize ─────────────────────────────────────────────────────────

const PRODID = "-//Brainstorm//CalDAV//EN";

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

function formatUtcStamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
		d.getUTCHours(),
	)}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function formatLocalDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Event/v1 properties → a single-VEVENT VCALENDAR for PUT. Returns null
 *  when the properties are not a renderable event (no finite start). */
export function serializeVEvent(input: {
	uid: string;
	properties: Record<string, unknown>;
	now: number;
}): string | null {
	const p = input.properties;
	const start = num(p.start);
	if (start === null) return null;

	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:${PRODID}`,
		"CALSCALE:GREGORIAN",
		"BEGIN:VEVENT",
		`UID:${input.uid}`,
		`DTSTAMP:${formatUtcStamp(num(p.updatedAt) ?? input.now)}`,
	];

	if (p.allDay === true) {
		lines.push(`DTSTART;VALUE=DATE:${formatLocalDate(start)}`);
	} else {
		lines.push(`DTSTART:${formatUtcStamp(start)}`);
		const end = num(p.end);
		if (end !== null) lines.push(`DTEND:${formatUtcStamp(end)}`);
	}

	lines.push(`SUMMARY:${escapeText(str(p.title) ?? "(untitled)")}`);
	const description = str(p.description);
	if (description !== null) lines.push(`DESCRIPTION:${escapeText(description)}`);
	const location = str(p.location);
	if (location !== null) lines.push(`LOCATION:${escapeText(location)}`);
	if (isRecurrence(p.recurrence)) {
		lines.push(`RRULE:${recurrenceToRRule(p.recurrence as Recurrence)}`);
	}
	const statusKey = str(p.statusKey);
	if (statusKey !== null && statusKey in STATUS_TO_ICS) {
		lines.push(`STATUS:${STATUS_TO_ICS[statusKey as StatusKey]}`);
	}

	if (Array.isArray(p.attendees)) {
		for (const raw of p.attendees) {
			if (!raw || typeof raw !== "object") continue;
			const a = raw as Record<string, unknown>;
			const name = str(a.name) ?? "";
			const email = str(a.email) ?? "";
			if (name.length === 0 && email.length === 0) continue;
			const rsvp = (str(a.rsvp) as RsvpKey | null) ?? RsvpKey.NeedsAction;
			const partstat = RSVP_TO_PARTSTAT[rsvp] ?? RSVP_TO_PARTSTAT[RsvpKey.NeedsAction];
			const cn = /[;:,]/.test(name) ? `"${name.replace(/"/g, "")}"` : name;
			lines.push(`ATTENDEE;CN=${cn};PARTSTAT=${partstat}:mailto:${email}`);
		}
	}

	if (Array.isArray(p.reminders)) {
		for (const raw of p.reminders) {
			const minutes = num(raw);
			if (minutes === null || minutes < 0) continue;
			lines.push(
				"BEGIN:VALARM",
				"ACTION:DISPLAY",
				`TRIGGER:-PT${Math.round(minutes)}M`,
				`DESCRIPTION:${escapeText(str(p.title) ?? "(untitled)")}`,
				"END:VALARM",
			);
		}
	}

	lines.push("END:VEVENT", "END:VCALENDAR");
	return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
