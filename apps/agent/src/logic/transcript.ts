/**
 * Pure transcript helpers — turning the persisted `Message/v1` entities of a
 * conversation into the `ai.generate` wire transcript, and deriving a
 * conversation title from the first turn. No React, no DOM, no SDK runtime —
 * unit-testable in isolation.
 */

import { type AiChatMessage, MessageRole, isMessageRole } from "@brainstorm/sdk-types";
import { CITATION_ID_SOURCE } from "./citation-format";

/** The anti-fabrication contract shared by both the plain-chat and tool-enabled
 *  system prompts. The model is grounded ONLY on the context blocks the app
 *  injects (the workspace map, the vault summary, retrieved objects) — without
 *  this, asked "who are my clients" it confidently invents plausible names and
 *  claims they came from the vault. Appended to both prompts so the guarantee
 *  holds on every path (DRY: one source, two consumers). */
export const AGENT_GROUNDING_GUIDANCE =
	"Ground every statement about the user's own workspace, vault, notes, contacts, or data strictly in the context provided below — the workspace map, the vault summary, and any retrieved objects. If the information needed to answer is not present in that context, say plainly that you don't have it in the vault instead of guessing; never invent names, clients, companies, numbers, dates, or other specifics, and do not claim a detail came from the vault unless it appears in the provided context.";

export const AGENT_SYSTEM_PROMPT = `You are a helpful assistant inside the user's Brainstorm knowledge workspace. Answer concisely and directly. ${AGENT_GROUNDING_GUIDANCE}`;

/** The fields of a `Message/v1` entity this layer reads. */
export type TranscriptMessage = {
	id: string;
	role: string;
	body: string;
	createdAt: string;
	seq?: number;
};

/** Chronological order: `createdAt`, ties broken by `seq` then `id`. */
export function sortMessages<T extends TranscriptMessage>(messages: readonly T[]): T[] {
	return [...messages].sort((a, b) => {
		if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
		const sa = a.seq ?? 0;
		const sb = b.seq ?? 0;
		if (sa !== sb) return sa - sb;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

/**
 * Build the `ai.generate` transcript: the system prompt, then each
 * user/assistant turn in order. Tool / system messages in the store are
 * skipped (the agent loop that produces them is a later rung); a row with an
 * unknown role is coerced to `user` so a malformed entity can't drop context.
 */
export function buildAiMessages(
	messages: readonly TranscriptMessage[],
	systemPrompt: string = AGENT_SYSTEM_PROMPT,
): AiChatMessage[] {
	const out: AiChatMessage[] = [{ role: MessageRole.System, content: systemPrompt }];
	for (const m of sortMessages(messages)) {
		const role = isMessageRole(m.role) ? m.role : MessageRole.User;
		if (role !== MessageRole.User && role !== MessageRole.Assistant) continue;
		out.push({ role, content: m.body });
	}
	return out;
}

/** A whole line in the taught citation shape (`formatCitationLine`): an
 *  optional list marker (`- `, `* `, `+ `, `1. `) or a `…: ` lead-in, the
 *  bracketed id, then the rest of the line as the title. Title and lead-in
 *  admit no brackets or backticks, so a line with a second ref, a markdown
 *  link, or a code span never reaches the title branch. */
const CITATION_LINE = new RegExp(
	`^([ \\t]{0,3}(?:[-*+]|\\d{1,3}\\.)?[ \\t]*|[^\\[\\]\`]*:[ \\t]+)\\[(${CITATION_ID_SOURCE})\\][ \\t]+([^\\[\\]\`]*[a-zA-Z0-9][^\\[\\]\`]*?)[ \\t]*$`,
);

/** The lead-in captured by {@link CITATION_LINE} ends in an explicit anchor —
 *  a list marker or a colon — as opposed to a plain line start. */
const ANCHORED_PREFIX = /[-*+.:][ \t]*$/;

/** A bracketed entity-id anywhere in prose (not already a markdown link). */
const ENTITY_REF = new RegExp(`\\[(${CITATION_ID_SOURCE})\\](?!\\()`, "g");

/** Inline code spans (`` `…` `` / ``` ``…`` ```) — split so refs inside them
 *  pass through untouched. An unmatched backtick is literal text (CommonMark),
 *  so no match there is correct. */
const CODE_SPAN = /(`+[^`]*`+)/;

/** Rewrite bare `[<id>]` refs in a prose chunk to `[<id>](<id>)` links. The id
 *  must contain a digit: every minted id embeds a base36 timestamp/random, so
 *  real ids pass, while prose snake_case (`[max_retries]`, `[user_id]`) stays
 *  plain text instead of becoming a dead link. */
function linkifyBareRefs(text: string): string {
	return text.replace(ENTITY_REF, (match, id: string) =>
		/[0-9]/.test(id) ? `[${id}](${id})` : match,
	);
}

/**
 * Display-time normalization for the citation shapes models actually emit.
 * The retrieval context block lists vault objects as `- [<id>] <title>`
 * (`formatCitationLine` via `buildRetrievalContextBlock`), and smaller models
 * echo that bracket format verbatim in their prose instead of the
 * `[label](id)` markdown-link protocol — so the transcript showed raw node
 * ids (F-319). A whole line in the taught shape rewrites to `[<title>](<id>)`
 * so the shared `<Markdown>` entity-link resolver renders a clickable title;
 * a mid-sentence `[<id>]` keeps the id as its own label (the same fallback as
 * `citationsToLinks`) and never absorbs the prose after it. The title branch
 * needs an explicit anchor (list marker / colon) OR a digit in the id, and
 * the bare branch always needs the digit — so snake_case prose tokens stay
 * plain text. Fenced code blocks (``` or ~~~, fence chars matched), indented
 * (4-space/tab) code lines, and inline code spans pass through untouched.
 * Pure — safe to apply identically to historical and fresh messages.
 */
export function linkifyEntityRefs(body: string): string {
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	let fence: string | null = null;
	const out = lines.map((line) => {
		const fenceMark = /^[ \t]{0,3}(```|~~~)/.exec(line)?.[1];
		if (fenceMark) {
			if (fence === null) fence = fenceMark;
			else if (fence === fenceMark) fence = null;
			return line;
		}
		if (fence !== null || /^(?: {4}|\t)/.test(line)) return line;
		return linkifyLine(line);
	});
	return out.join("\n");
}

function linkifyLine(line: string): string {
	const citation = CITATION_LINE.exec(line);
	if (citation) {
		const [, prefix = "", id = "", title = ""] = citation;
		if (ANCHORED_PREFIX.test(prefix) || /[0-9]/.test(id)) {
			return `${prefix}[${title}](${id})`;
		}
	}
	return line
		.split(CODE_SPAN)
		.map((chunk, i) => (i % 2 === 1 ? chunk : linkifyBareRefs(chunk)))
		.join("");
}

const MAX_TITLE_LEN = 60;

/** A conversation title from the first user turn — first non-empty line,
 *  trimmed to a sane length with an ellipsis. Falls back to a default. */
export function deriveConversationTitle(body: string, fallback: string): string {
	const firstLine = body
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!firstLine) return fallback;
	if (firstLine.length <= MAX_TITLE_LEN) return firstLine;
	return `${firstLine.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`;
}
