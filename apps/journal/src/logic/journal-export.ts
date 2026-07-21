/**
 * Journal export (9.16.12) — render a date range of entries to Markdown or
 * HTML. Pure string codecs over the projected `JournalEntry[]`; the file
 * write rides the shared `@brainstorm-os/sdk/export-file` flow in `app.ts`.
 *
 * Each entry contributes its date heading, a metadata line (mood · words ·
 * habits), and its preview text. The preview is the denormalised snippet
 * the projection holds — full-body export would need a per-entity Y.Doc
 * load (a later concern); the digest covers the lead of every entry plus
 * the structured check-in data.
 */

import type { JournalEntry } from "../types/entry";
import { type HabitId, type MoodId, moodById } from "./check-in";
import { journalNoteTitle } from "./journal-keys";

export type JournalExportLabels = {
	/** Document title, e.g. "Journal". */
	title: string;
	moodLabel: (mood: MoodId) => string;
	habitLabel: (habit: HabitId) => string;
	words: (count: number) => string;
};

/** Entries whose date falls in `[startMs, endMs]` (inclusive), oldest
 *  first — the natural reading order for an exported digest. */
export function entriesInRange(
	entries: readonly JournalEntry[],
	startMs: number,
	endMs: number,
): JournalEntry[] {
	return entries
		.filter((e) => e.dateEpochMs >= startMs && e.dateEpochMs <= endMs)
		.sort((a, b) => a.dateEpochMs - b.dateEpochMs);
}

function metaLine(entry: JournalEntry, labels: JournalExportLabels): string {
	const parts: string[] = [];
	const mood = moodById(entry.mood);
	if (mood) parts.push(`${mood.emoji} ${labels.moodLabel(entry.mood as MoodId)}`);
	parts.push(labels.words(entry.wordCount));
	if (entry.habits.length > 0) parts.push(entry.habits.map((h) => labels.habitLabel(h)).join(", "));
	return parts.join(" · ");
}

/** Render entries to a Markdown digest. */
export function journalToMarkdown(
	entries: readonly JournalEntry[],
	labels: JournalExportLabels,
): string {
	const lines: string[] = [`# ${labels.title}`, ""];
	for (const entry of entries) {
		lines.push(`## ${journalNoteTitle(new Date(entry.dateEpochMs))}`);
		lines.push("");
		lines.push(`*${metaLine(entry, labels)}*`);
		lines.push("");
		if (entry.preview.length > 0) {
			lines.push(entry.preview);
			lines.push("");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Render entries to a self-contained HTML digest. */
export function journalToHtml(
	entries: readonly JournalEntry[],
	labels: JournalExportLabels,
): string {
	const body: string[] = [`<h1>${escapeHtml(labels.title)}</h1>`];
	for (const entry of entries) {
		body.push('<section class="entry">');
		body.push(`<h2>${escapeHtml(journalNoteTitle(new Date(entry.dateEpochMs)))}</h2>`);
		body.push(`<p class="meta">${escapeHtml(metaLine(entry, labels))}</p>`);
		if (entry.preview.length > 0) body.push(`<p>${escapeHtml(entry.preview)}</p>`);
		body.push("</section>");
	}
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		`<title>${escapeHtml(labels.title)}</title>`,
		"<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6}.meta{color:#888;font-size:.9em}section.entry{margin-bottom:1.5rem}</style>",
		"</head>",
		"<body>",
		...body,
		"</body>",
		"</html>",
		"",
	].join("\n");
}
