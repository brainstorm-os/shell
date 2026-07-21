/**
 * The Agent's vault-data context (doc 63 — the Agent context layer, slice 3).
 * Where the workspace block (`workspace-context.ts`) says what COULD exist (the
 * schema — apps, types, actions), this says what ACTUALLY exists right now: a
 * bounded tally of the vault's objects by type + the names of its collections,
 * so the agent grounds on the real shape of the user's data.
 *
 * Pure + deterministic — derived from the live entity snapshot the app already
 * subscribes to (`useVaultEntities`; the app holds `entities.read:*`), so no new
 * read surface. Bounded (top-N types + collections) so a large vault can't blow
 * up the prompt; collection names (user free-text) are length-clamped +
 * control-stripped. Model-prompt text, not UI — intentionally plain English
 * (like `AGENT_TOOL_SYSTEM_PROMPT`), no `t()`.
 */

import { COLLECTION_TYPE_URL } from "@brainstorm-os/sdk-types";
import { friendlyTypeName } from "@brainstorm-os/sdk/system-entities";

/** Types listed in the tally before collapsing the tail into "and N more". */
const MAX_TYPES_RENDERED = 12;
/** Collection names listed before collapsing the tail. */
const MAX_COLLECTIONS_RENDERED = 12;
/** Length cap on a single collection name injected into the prompt. */
const MAX_COLLECTION_NAME_LENGTH = 60;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export type VaultDataEntity = {
	type: string;
	properties: Record<string, unknown>;
};

/** Clamp + control-strip a user-supplied collection name for the prompt. */
function cleanName(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (cleaned.length === 0) return "";
	return cleaned.length > MAX_COLLECTION_NAME_LENGTH
		? `${cleaned.slice(0, MAX_COLLECTION_NAME_LENGTH - 1).trimEnd()}…`
		: cleaned;
}

/**
 * Build the vault-data context block, or `""` when there is nothing to report.
 * `excludeTypes` drops the agent's own bookkeeping types (Conversation / Message
 * / Memory) from the tally so the agent reports the user's content, not its own
 * transcript. Collections (`List/v1`) are tallied separately, by name.
 */
export function buildVaultDataContextBlock(
	entities: readonly VaultDataEntity[],
	excludeTypes: ReadonlySet<string> = new Set(),
): string {
	const counts = new Map<string, number>();
	const collections: string[] = [];
	for (const entity of entities) {
		if (entity.type === COLLECTION_TYPE_URL) {
			const name = cleanName(entity.properties.name);
			if (name) collections.push(name);
			continue;
		}
		if (excludeTypes.has(entity.type)) continue;
		counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
	}
	if (counts.size === 0 && collections.length === 0) return "";

	const lines: string[] = ["## Your vault"];
	if (counts.size > 0) {
		const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
		const shown = ranked
			.slice(0, MAX_TYPES_RENDERED)
			.map(([type, n]) => `${n} ${friendlyTypeName(type)}`);
		const extra = ranked.length - MAX_TYPES_RENDERED;
		const more = extra > 0 ? `, and ${extra} more type${extra === 1 ? "" : "s"}` : "";
		lines.push(`Your vault contains ${shown.join(", ")}${more}.`);
	}
	if (collections.length > 0) {
		const shown = collections.slice(0, MAX_COLLECTIONS_RENDERED);
		const extra = collections.length - MAX_COLLECTIONS_RENDERED;
		const more = extra > 0 ? `, and ${extra} more` : "";
		lines.push(`Collections: ${shown.join(", ")}${more}.`);
	}
	return lines.join("\n");
}
