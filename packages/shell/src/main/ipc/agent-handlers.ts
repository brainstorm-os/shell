/**
 * `agents:*` IPC handlers (Agent-Teams-1) — the dashboard renderer's window
 * onto the agent directory: list/create/configure/delete agent members and
 * drive the per-agent capability grant/revoke.
 *
 * Apps NEVER reach these channels — only the shell-trusted dashboard renderer
 * (the Team surface) invokes them, and the human's explicit click there IS the
 * consent gesture doc 69 requires for authority changes. Policy stays in
 * `main/agents/agent-directory.ts` (agent-grantable vocabulary, fail-closed on
 * unknown agents, audit rows); these handlers only validate arg shapes and
 * fail closed when no vault is open.
 */

import type {
	AgentAutonomy,
	AgentMemoryScope,
	AgentRouting,
	AgentSkillRef,
} from "@brainstorm-os/sdk-types";
import { ipcMain } from "electron";
import {
	type AgentGrantResult,
	type AgentRecord,
	agentActivity,
	createAgent,
	deleteAgent,
	grantAgentCapability,
	listAgentGrants,
	listAgents,
	revokeAgentCapability,
	updateAgent,
} from "../agents/agent-directory";
import { getActiveVaultSession } from "../vault/session";

/** The wire shape the Team surface renders — the record plus its live grants
 *  (each as `service.verb` + scope), so directory + capability sheet come from
 *  one round-trip. */
export type SerializedAgent = {
	id: string;
	pubkey: string;
	fingerprint: string;
	displayName: string;
	avatarRef: string | null;
	persona: string;
	skills: AgentSkillRef[];
	routing: AgentRouting;
	autonomy: AgentAutonomy;
	memoryScope: AgentMemoryScope;
	createdAt: number;
	updatedAt: number;
	grants: Array<{ capability: string; scope: string | null; grantedAt: number }>;
};

async function serialize(record: AgentRecord): Promise<SerializedAgent> {
	const session = getActiveVaultSession();
	const grants = session ? await listAgentGrants(session, record.def.fingerprint) : [];
	return {
		id: record.id,
		...record.def,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		grants: grants.map((g) => ({
			capability: g.capability,
			scope: g.scope,
			grantedAt: g.grantedAt,
		})),
	};
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function registerAgentHandlers(): void {
	ipcMain.handle("agents:list", async (): Promise<SerializedAgent[]> => {
		const session = getActiveVaultSession();
		if (!session) return [];
		const records = await listAgents(session);
		return Promise.all(records.map(serialize));
	});

	ipcMain.handle("agents:create", async (_e, input: unknown): Promise<SerializedAgent | null> => {
		const session = getActiveVaultSession();
		if (!session) return null;
		const raw = (input ?? {}) as Record<string, unknown>;
		const displayName = str(raw.displayName)?.trim();
		if (!displayName) return null;
		const persona = str(raw.persona);
		const record = await createAgent(session, {
			displayName,
			...(persona !== undefined ? { persona } : {}),
		});
		return serialize(record);
	});

	ipcMain.handle(
		"agents:update",
		async (_e, id: unknown, patch: unknown): Promise<SerializedAgent | null> => {
			const session = getActiveVaultSession();
			if (!session || typeof id !== "string" || !id) return null;
			const raw = (patch ?? {}) as Record<string, unknown>;
			// Structured trait/skill values are validated by the codec on write —
			// only pass through the fields the Team surface edits.
			const displayName = str(raw.displayName);
			const persona = str(raw.persona);
			const routing = str(raw.routing);
			const autonomy = str(raw.autonomy);
			const memoryScope = str(raw.memoryScope);
			const record = await updateAgent(session, id, {
				...(displayName !== undefined ? { displayName } : {}),
				...(persona !== undefined ? { persona } : {}),
				...(routing !== undefined ? { routing: routing as AgentRouting } : {}),
				...(autonomy !== undefined ? { autonomy: autonomy as AgentAutonomy } : {}),
				...(memoryScope !== undefined ? { memoryScope: memoryScope as AgentMemoryScope } : {}),
			});
			return record ? serialize(record) : null;
		},
	);

	ipcMain.handle("agents:delete", async (_e, id: unknown): Promise<boolean> => {
		const session = getActiveVaultSession();
		if (!session || typeof id !== "string" || !id) return false;
		return deleteAgent(session, id);
	});

	ipcMain.handle(
		"agents:grant",
		async (_e, fingerprint: unknown, capability: unknown): Promise<AgentGrantResult> => {
			const session = getActiveVaultSession();
			if (!session || typeof fingerprint !== "string" || typeof capability !== "string") {
				return { granted: false, reason: "invalid" };
			}
			return grantAgentCapability(session, fingerprint, capability);
		},
	);

	ipcMain.handle("agents:activity", async (_e, fingerprint: unknown): Promise<unknown[]> => {
		const session = getActiveVaultSession();
		if (!session || typeof fingerprint !== "string") return [];
		return agentActivity(session, fingerprint);
	});

	ipcMain.handle(
		"agents:revoke",
		async (_e, fingerprint: unknown, capability: unknown, scope: unknown): Promise<boolean> => {
			const session = getActiveVaultSession();
			if (!session || typeof fingerprint !== "string" || typeof capability !== "string") {
				return false;
			}
			return revokeAgentCapability(
				session,
				fingerprint,
				capability,
				typeof scope === "string" ? scope : null,
			);
		},
	);
}
