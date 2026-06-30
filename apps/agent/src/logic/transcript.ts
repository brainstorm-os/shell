/**
 * Pure transcript helpers — turning the persisted `Message/v1` entities of a
 * conversation into the `ai.generate` wire transcript, and deriving a
 * conversation title from the first turn. No React, no DOM, no SDK runtime —
 * unit-testable in isolation.
 */

import { type AiChatMessage, MessageRole, isMessageRole } from "@brainstorm/sdk-types";

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
