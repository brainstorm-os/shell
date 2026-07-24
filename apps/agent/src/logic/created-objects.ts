/**
 * Agent-11c — the chat's created-object back-links.
 *
 * When a proposed artifact (11a/11b) is approved, the shell stamps
 * server-authoritative provenance ({@link readAgentProvenance}) onto the created
 * entity — WHICH agent proposed it, in WHICH conversation. This pure helper
 * derives the "created in this chat" chips from the SAME live vault snapshot the
 * app already subscribes to (no new read surface, no hand-rolled change loop):
 * it filters the snapshot to entities whose provenance points back at the active
 * conversation. The chips `open` via the cap-checked `open` intent (in
 * `app.tsx`), so the back-link is round-trippable — the object points at the
 * conversation, the conversation lists the objects, and clicking one navigates.
 *
 * Reactive-by-derivation: because it reads the snapshot, a created object
 * survives reload and appears the moment its row lands, with no per-conversation
 * bookkeeping to persist.
 */

import { readAgentProvenance } from "@brainstorm-os/sdk-types";

/** One created-object chip: enough to render + `open` it. */
export type CreatedObjectChip = {
	id: string;
	type: string;
	title: string;
};

type SnapshotEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	deletedAt?: number | null;
};

function titleOf(properties: Record<string, unknown>): string {
	const raw = properties.title ?? properties.name;
	return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Entities this agent created on behalf of `conversationId`, newest-first
 * (by the provenance `createdAt`). `agentAppId`, when given, additionally
 * requires the stamp's server-authoritative `agent` to match this app — a
 * belt-and-braces guard so a chip only ever surfaces objects THIS agent
 * created, never one another agent stamped for a colliding conversation id.
 * Soft-deleted rows are dropped (a binned object shouldn't linger as a chip).
 */
export function createdObjectsForConversation(
	entities: readonly SnapshotEntity[],
	conversationId: string,
	agentAppId?: string,
): CreatedObjectChip[] {
	if (!conversationId) return [];
	const out: Array<CreatedObjectChip & { at: number }> = [];
	for (const e of entities) {
		if (e.deletedAt != null) continue;
		const prov = readAgentProvenance(e.properties);
		if (!prov || prov.conversationId !== conversationId) continue;
		if (agentAppId !== undefined && prov.agent !== agentAppId) continue;
		out.push({ id: e.id, type: e.type, title: titleOf(e.properties), at: prov.createdAt });
	}
	out.sort((a, b) => b.at - a.at);
	return out.map(({ at: _at, ...chip }) => chip);
}
