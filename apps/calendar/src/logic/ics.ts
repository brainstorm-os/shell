/**
 * ICS / iCalendar (RFC 5545) import + export for `Event/v1` (9.15.18).
 *
 * Pure: text in, `Event[]` out and vice-versa. Times are *floating* local
 * wall-clock (matching the app's current model — 9.15.21 layers tz on
 * top); all-day events use `VALUE=DATE`. Recurrence maps through the
 * structured-RRULE codec; reminders ↔ VALARM TRIGGER; attendees ↔
 * ATTENDEE; status ↔ STATUS; colour rides an `X-BRAINSTORM-COLOR` X-prop.
 */

import type { Recurrence } from "@brainstorm-os/sdk-types";
import type { Attendee } from "../types/attendee";
import { AttendeeRsvp } from "../types/attendee";
import type { Event } from "../types/event";
import { normalizeAttendees } from "./attendees";
import { normalizeColorHint } from "./event-colors";
import { EventStatus, normalizeStatusKey } from "./event-status";
import { normalizeReminders } from "./reminders";
import { recurrenceToRRule, rruleToRecurrence } from "./rrule";

const PRODID = "-//Brainstorm//Calendar//EN";
const MAX_LINE = 73; // conservative fold width (RFC 5545 caps at 75 octets)

// ── Export ────────────────────────────────────────────────────────────

export function serializeCalendar(events: readonly Event[]): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${PRODID}`, "CALSCALE:GREGORIAN"];
	for (const event of events) lines.push(...eventToLines(event));
	lines.push("END:VCALENDAR");
	return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function eventToLines(event: Event): string[] {
	const lines: string[] = ["BEGIN:VEVENT"];
	lines.push(`UID:${event.id}`);
	lines.push(`DTSTAMP:${formatUtcStamp(event.updatedAt)}`);
	if (event.allDay) {
		lines.push(`DTSTART;VALUE=DATE:${formatDate(event.start)}`);
	} else {
		lines.push(`DTSTART:${formatLocalDateTime(event.start)}`);
		if (event.end !== null) lines.push(`DTEND:${formatLocalDateTime(event.end)}`);
	}
	lines.push(`SUMMARY:${escapeText(event.title)}`);
	if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
	if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
	if (event.recurrence) lines.push(`RRULE:${recurrenceToRRule(event.recurrence)}`);
	const status = icsStatus(event.statusKey);
	if (status) lines.push(`STATUS:${status}`);
	if (event.colorHint) lines.push(`X-BRAINSTORM-COLOR:${event.colorHint}`);
	lines.push(`CREATED:${formatUtcStamp(event.createdAt)}`);
	lines.push(`LAST-MODIFIED:${formatUtcStamp(event.updatedAt)}`);
	for (const attendee of event.attendees) lines.push(attendeeLine(attendee));
	for (const minutes of event.reminders) {
		lines.push(
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			`TRIGGER:-PT${minutes}M`,
			`DESCRIPTION:${escapeText(event.title)}`,
			"END:VALARM",
		);
	}
	lines.push("END:VEVENT");
	return lines;
}

function attendeeLine(attendee: Attendee): string {
	const cn = quoteParam(attendee.name);
	const partstat = icsPartstat(attendee.rsvp);
	return `ATTENDEE;CN=${cn};PARTSTAT=${partstat}:mailto:${attendee.email ?? ""}`;
}

const STATUS_TO_ICS: Record<EventStatus, string> = {
	[EventStatus.Confirmed]: "CONFIRMED",
	[EventStatus.Tentative]: "TENTATIVE",
	[EventStatus.Cancelled]: "CANCELLED",
};

function icsStatus(statusKey: string | null): string | null {
	const status = normalizeStatusKey(statusKey);
	return status ? STATUS_TO_ICS[status] : null;
}

const RSVP_TO_PARTSTAT: Record<AttendeeRsvp, string> = {
	[AttendeeRsvp.Accepted]: "ACCEPTED",
	[AttendeeRsvp.Declined]: "DECLINED",
	[AttendeeRsvp.Tentative]: "TENTATIVE",
	[AttendeeRsvp.NeedsAction]: "NEEDS-ACTION",
};

function icsPartstat(rsvp: AttendeeRsvp): string {
	return RSVP_TO_PARTSTAT[rsvp];
}

// ── Import ────────────────────────────────────────────────────────────

export type ParseResult = {
	events: Event[];
	warnings: string[];
};

export function parseCalendar(text: string, now: number = Date.now()): ParseResult {
	const lines = unfold(text);
	const events: Event[] = [];
	const warnings: string[] = [];

	let current: ParsedEvent | null = null;
	let inAlarm = false;
	let alarmTrigger: number | null = null;
	let index = 0;

	for (const line of lines) {
		const upper = line.toUpperCase();
		if (upper === "BEGIN:VEVENT") {
			current = emptyParsed();
			continue;
		}
		if (upper === "END:VEVENT") {
			if (current) {
				const built = buildEvent(current, index++, now, warnings);
				if (built) events.push(built);
			}
			current = null;
			continue;
		}
		if (!current) continue;
		if (upper === "BEGIN:VALARM") {
			inAlarm = true;
			alarmTrigger = null;
			continue;
		}
		if (upper === "END:VALARM") {
			if (alarmTrigger !== null) current.reminders.push(alarmTrigger);
			inAlarm = false;
			continue;
		}

		const prop = splitProperty(line);
		if (!prop) continue;
		if (inAlarm) {
			if (prop.name === "TRIGGER") alarmTrigger = parseTrigger(prop.value);
			continue;
		}
		applyProperty(current, prop);
	}

	return { events, warnings };
}

type ParsedProp = { name: string; params: Map<string, string>; value: string };

type ParsedEvent = {
	uid: string | null;
	summary: string | null;
	description: string | null;
	location: string | null;
	start: number | null;
	end: number | null;
	allDay: boolean;
	recurrence: Recurrence | null;
	statusKey: string | null;
	colorHint: string | null;
	createdAt: number | null;
	updatedAt: number | null;
	attendees: Attendee[];
	reminders: number[];
};

function emptyParsed(): ParsedEvent {
	return {
		uid: null,
		summary: null,
		description: null,
		location: null,
		start: null,
		end: null,
		allDay: false,
		recurrence: null,
		statusKey: null,
		colorHint: null,
		createdAt: null,
		updatedAt: null,
		attendees: [],
		reminders: [],
	};
}

function applyProperty(event: ParsedEvent, prop: ParsedProp): void {
	switch (prop.name) {
		case "UID":
			event.uid = prop.value.trim() || null;
			return;
		case "SUMMARY":
			event.summary = unescapeText(prop.value);
			return;
		case "DESCRIPTION":
			event.description = unescapeText(prop.value);
			return;
		case "LOCATION":
			event.location = unescapeText(prop.value);
			return;
		case "DTSTART": {
			const parsed = parseIcsDate(prop.value, prop.params);
			if (parsed) {
				event.start = parsed.ms;
				event.allDay = parsed.dateOnly;
			}
			return;
		}
		case "DTEND": {
			const parsed = parseIcsDate(prop.value, prop.params);
			if (parsed && !parsed.dateOnly) event.end = parsed.ms;
			return;
		}
		case "RRULE":
			event.recurrence = rruleToRecurrence(prop.value);
			return;
		case "STATUS":
			event.statusKey = ICS_TO_STATUS[prop.value.trim().toUpperCase()] ?? null;
			return;
		case "X-BRAINSTORM-COLOR":
			event.colorHint = normalizeColorHint(prop.value.trim());
			return;
		case "CREATED":
			event.createdAt = parseIcsDate(prop.value, prop.params)?.ms ?? null;
			return;
		case "LAST-MODIFIED":
		case "DTSTAMP":
			if (event.updatedAt === null) {
				event.updatedAt = parseIcsDate(prop.value, prop.params)?.ms ?? null;
			}
			return;
		case "ATTENDEE": {
			const attendee = parseAttendee(prop);
			if (attendee) event.attendees.push(attendee);
			return;
		}
	}
}

const ICS_TO_STATUS: Record<string, string> = {
	CONFIRMED: EventStatus.Confirmed,
	TENTATIVE: EventStatus.Tentative,
	CANCELLED: EventStatus.Cancelled,
};

const PARTSTAT_TO_RSVP: Record<string, AttendeeRsvp> = {
	ACCEPTED: AttendeeRsvp.Accepted,
	DECLINED: AttendeeRsvp.Declined,
	TENTATIVE: AttendeeRsvp.Tentative,
	"NEEDS-ACTION": AttendeeRsvp.NeedsAction,
};

function parseAttendee(prop: ParsedProp): Attendee | null {
	const cn = prop.params.get("CN") ?? "";
	const partstat = prop.params.get("PARTSTAT")?.toUpperCase() ?? "";
	const rsvp = PARTSTAT_TO_RSVP[partstat] ?? AttendeeRsvp.NeedsAction;
	const email = prop.value.replace(/^mailto:/i, "").trim();
	const built = normalizeAttendees([{ name: cn, email: email || null, rsvp }]);
	return built[0] ?? null;
}

function buildEvent(
	parsed: ParsedEvent,
	index: number,
	now: number,
	warnings: string[],
): Event | null {
	if (parsed.start === null) {
		warnings.push(`Skipped a VEVENT with no DTSTART (item ${index + 1}).`);
		return null;
	}
	const id = parsed.uid ?? `imported-${parsed.start}-${index}`;
	const createdAt = parsed.createdAt ?? now;
	const updatedAt = parsed.updatedAt ?? now;
	// All-day events follow the app's single-day model (no DTEND span).
	const end = parsed.allDay ? null : parsed.end;
	const event: Event = {
		id,
		title: parsed.summary ?? "(untitled)",
		icon: null,
		start: parsed.start,
		end: end !== null && end < parsed.start ? null : end,
		allDay: parsed.allDay,
		location: parsed.location && parsed.location.length > 0 ? parsed.location : null,
		recurrence: parsed.recurrence,
		statusKey: parsed.statusKey,
		colorHint: parsed.colorHint,
		reminders: normalizeReminders(parsed.reminders),
		attendees: parsed.attendees,
		// ICS import keeps floating local wall-clock in v1 (no TZID mapping).
		timeZone: null,
		createdAt,
		updatedAt,
	};
	if (parsed.description && parsed.description.length > 0) event.description = parsed.description;
	return event;
}

// ── Line / text primitives ────────────────────────────────────────────

function splitProperty(line: string): ParsedProp | null {
	// NAME(;PARAM=VAL)*:VALUE — the first unquoted colon ends the name+params.
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
	const segments = splitParams(head);
	const name = (segments.shift() ?? "").toUpperCase();
	if (name.length === 0) return null;
	const params = new Map<string, string>();
	for (const seg of segments) {
		const eq = seg.indexOf("=");
		if (eq <= 0) continue;
		params.set(seg.slice(0, eq).toUpperCase(), unquoteParam(seg.slice(eq + 1)));
	}
	return { name, params, value };
}

/** Split the `NAME;P1=…;P2=…` head on unquoted semicolons. */
function splitParams(head: string): string[] {
	const out: string[] = [];
	let buf = "";
	let inQuote = false;
	for (const ch of head) {
		if (ch === '"') {
			inQuote = !inQuote;
			buf += ch;
		} else if (ch === ";" && !inQuote) {
			out.push(buf);
			buf = "";
		} else {
			buf += ch;
		}
	}
	out.push(buf);
	return out;
}

function quoteParam(value: string): string {
	return /[;:,]/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

function unquoteParam(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
	return trimmed;
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

/** Unfold continuation lines (a line beginning with space/tab continues
 *  the previous one) and drop empty lines. */
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

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

function formatLocalDateTime(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(
		d.getMinutes(),
	)}${pad(d.getSeconds())}`;
}

function formatDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function formatUtcStamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
		d.getUTCHours(),
	)}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function parseIcsDate(
	value: string,
	params?: Map<string, string>,
): { ms: number; dateOnly: boolean } | null {
	const v = value.trim();
	const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
	if (dateMatch || params?.get("VALUE") === "DATE") {
		const m = dateMatch ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
		if (!m) return null;
		return {
			ms: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(),
			dateOnly: true,
		};
	}
	const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
	if (!dt) return null;
	const [, y, mo, d, h, mi, s, z] = dt;
	const nums = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
	if (z) {
		return {
			ms: Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]),
			dateOnly: false,
		};
	}
	return {
		ms: new Date(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]).getTime(),
		dateOnly: false,
	};
}

/** Parse a VALARM TRIGGER duration to minutes-before-start (magnitude). */
function parseTrigger(value: string): number | null {
	const m = /^[+-]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
		value.trim().toUpperCase(),
	);
	if (!m) return null;
	const [, w, d, h, min, s] = m.map((x) => (x ? Number(x) : 0));
	const minutes =
		(w ?? 0) * 7 * 1440 + (d ?? 0) * 1440 + (h ?? 0) * 60 + (min ?? 0) + Math.round((s ?? 0) / 60);
	return minutes;
}
