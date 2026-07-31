/**
 * Seeded starter agents (Agent-Teams-4) — the vault's team is alive on first
 * look rather than an empty directory. Three conservative starters mirroring
 * the dogfood lenses (doc 69 §Seeded starter agents), in the SAME
 * `AgentTemplate` format the marketplace will ship (the seed is the format's
 * first consumer, which keeps the marketplace rung cheap later).
 *
 * OQ-AT-3 position taken here: neutral ROLE names (not dogfood personas),
 * conservative traits (`LocalOnly` + `ConfirmOnWrite`), fully editable and
 * deletable — and seeded with ZERO grants. `requestedCapabilities` is what
 * each starter would ask for on a consent sheet; instantiation never grants
 * it. A starter is a visible, powerless team member until the human scopes
 * it on the Team surface — grants only ever come from the consent gesture,
 * never as data (doc 69 §Identity).
 */

import {
	AgentAutonomy,
	AgentMemoryScope,
	AgentRouting,
	type AgentTemplate,
} from "@brainstorm-os/sdk-types";
import {
	type AgentDirectorySession,
	type AgentRecord,
	createAgent,
	listAgents,
} from "./agent-directory";

export const STARTER_AGENT_TEMPLATES: readonly AgentTemplate[] = [
	{
		displayName: "Researcher",
		avatarRef: null,
		persona:
			"You are the team's researcher. You ground every answer in what is actually in the vault — notes, contacts, projects, bookmarks — and say plainly when the vault holds nothing on a topic. You never invent sources.",
		skills: [],
		traits: {
			routing: AgentRouting.LocalOnly,
			autonomy: AgentAutonomy.ConfirmOnWrite,
			memoryScope: AgentMemoryScope.PerConversation,
		},
		requestedCapabilities: ["ai.use", "search.read", "search.hybrid", "entities.read:*"],
	},
	{
		displayName: "Builder",
		avatarRef: null,
		persona:
			"You are the team's builder. You turn discussion into concrete drafts — tasks, events, notes, database rows — and always stage them as proposals for a person to approve. You keep drafts small and well-titled.",
		skills: [],
		traits: {
			routing: AgentRouting.LocalOnly,
			autonomy: AgentAutonomy.ConfirmOnWrite,
			memoryScope: AgentMemoryScope.PerConversation,
		},
		requestedCapabilities: [
			"ai.use",
			"search.read",
			"intents.dispatch:propose-note",
			"intents.dispatch:propose-task",
			"intents.dispatch:propose-event",
			"intents.dispatch:propose-row",
		],
	},
	{
		displayName: "Reviewer",
		avatarRef: null,
		persona:
			"You are the team's reviewer. You read what the team produces and point out gaps, inconsistencies, and unclear wording — specific and constructive, quoting the exact place you mean. You propose fixes; you never rewrite silently.",
		skills: [],
		traits: {
			routing: AgentRouting.LocalOnly,
			autonomy: AgentAutonomy.ConfirmOnWrite,
			memoryScope: AgentMemoryScope.PerConversation,
		},
		requestedCapabilities: ["ai.use", "search.read", "entities.read:*", "roster.read"],
	},
];

/** Instantiate one template: local key-gen + the `Agent/v1` record. The
 *  template's `requestedCapabilities` are deliberately NOT granted. */
export async function instantiateAgentTemplate(
	session: AgentDirectorySession,
	template: AgentTemplate,
): Promise<AgentRecord> {
	return createAgent(session, {
		displayName: template.displayName,
		persona: template.persona,
		avatarRef: template.avatarRef,
		skills: template.skills,
		routing: template.traits.routing,
		autonomy: template.traits.autonomy,
		memoryScope: template.traits.memoryScope,
	});
}

/** Seed the starter roster. Idempotent on the DIRECTORY, not a marker row: any
 *  existing agent (including a renamed or user-created one) means the user has
 *  a team already, and re-seeding would resurrect deleted starters. */
export async function seedStarterAgents(session: AgentDirectorySession): Promise<AgentRecord[]> {
	const existing = await listAgents(session);
	if (existing.length > 0) return [];
	const seeded: AgentRecord[] = [];
	for (const template of STARTER_AGENT_TEMPLATES) {
		seeded.push(await instantiateAgentTemplate(session, template));
	}
	return seeded;
}
