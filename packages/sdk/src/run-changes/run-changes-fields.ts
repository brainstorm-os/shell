/**
 * The human face of a run diff's field rows (Agent-15). The shell projects
 * every key a write touched; this keeps the ones a reader should see and
 * renders their previews for people: host bookkeeping and provenance keys
 * are dropped, an empty bag counts as nothing, and an epoch stamp on a
 * date-shaped key reads through the shared date formatters.
 */

import {
	type AgentFieldChange,
	type FormatContext,
	isAgentChangeHiddenKey,
} from "@brainstorm-os/sdk-types";
import { formatDate, formatTime } from "../date-formatters";

const EMPTY_PREVIEWS: ReadonlySet<string> = new Set(["{}", "[]"]);
const DATE_SHAPED_KEY = /(At|Date|Time|Timestamp)$/;
const EPOCH_MS = /^\d{12,13}$/;
const EPOCH_MIN = Date.UTC(1990, 0, 1);
const EPOCH_MAX = Date.UTC(2200, 0, 1);

/** A preview as a reader should see it, or null when it says nothing. */
export function formatChangePreview(
	key: string,
	preview: string | null,
	ctx?: FormatContext,
): string | null {
	if (preview === null || EMPTY_PREVIEWS.has(preview)) return null;
	if (DATE_SHAPED_KEY.test(key) && EPOCH_MS.test(preview)) {
		const ms = Number(preview);
		if (ms >= EPOCH_MIN && ms < EPOCH_MAX) return `${formatDate(ms, ctx)} ${formatTime(ms, ctx)}`;
	}
	return preview;
}

/** The rows worth listing, previews formatted. Order is kept. */
export function humanFieldChanges(
	fields: readonly AgentFieldChange[],
	ctx?: FormatContext,
): AgentFieldChange[] {
	const out: AgentFieldChange[] = [];
	for (const field of fields) {
		if (isAgentChangeHiddenKey(field.key)) continue;
		const before = formatChangePreview(field.key, field.before, ctx);
		const after = formatChangePreview(field.key, field.after, ctx);
		if (before === null && after === null) continue;
		out.push({ ...field, before, after });
	}
	return out;
}
