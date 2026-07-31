/**
 * Agent directory (Agent-Teams-1) — the main-process authority for agents as
 * vault members: create (mint the agent's OWN Ed25519 key + persist the
 * `Agent/v1` entity), configure persona/traits, delete (revoke everything),
 * and the per-agent capability grant/revoke that the Team surface's consent
 * gesture drives.
 *
 * Security posture (doc 69 §Capabilities & security):
 *   - The agent's ledger principal is its key FINGERPRINT — a value disjoint
 *     from every app id (`principals.ts`), so the broker's fail-closed
 *     `ledger.has` protects agent calls identically with no schema change.
 *   - Grants only flow through `grantAgentCapability`, which fail-closes on
 *     (a) a fingerprint that doesn't belong to a live `Agent/v1` entity and
 *     (b) any capability outside the agent-grantable vocabulary — an agent
 *     can NEVER hold a write, network, or non-propose dispatch capability.
 *   - Identity fields are immutable after create: `updateAgent` structurally
 *     cannot touch `pubkey`/`fingerprint` (and the codec re-validates reads).
 *   - Every mutation appends an audit row keyed on the agent fingerprint, so
 *     "what happened to this agent's authority" is a filter, not a build.
 *
 * This module is shell-internal (dashboard IPC + seeding); apps never reach
 * it. The one place agent SECRETS are touched stays `credentials/agent-keys`.
 */

import { isAgentGrantableCapability } from "@brainstorm-os/capabilities/agent-grants";
import {
	type CapabilityGrant,
	type CapabilityLedger,
	GrantedVia,
	parseCapability,
} from "@brainstorm-os/capabilities/ledger";
import { isAgentPrincipal } from "@brainstorm-os/capabilities/principals";
import {
	AGENT_TYPE,
	AgentAutonomy,
	type AgentDef,
	AgentMemoryScope,
	AgentRouting,
	type AgentSkillRef,
	agentDefToEntityProperties,
	readAgentDef,
} from "@brainstorm-os/sdk-types";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { ulid } from "ulid";
import { createAgentKey, removeAgentKey } from "../credentials/agent-keys";
import type { CredentialStore } from "../credentials/store";
import { EntitiesRepository } from "../storage/entities-repo";
import {
	type AuditEventKind,
	type AuditEventRecord,
	appendAuditEvent,
	readAgentAuditEvents,
} from "../vault/audit-log";

/** The slice of `VaultSession` this module needs — structural, so tests fake
 *  it without a full vault boot. */
export type AgentDirectorySession = {
	readonly vaultId: string;
	readonly vaultPath: string;
	readonly credentials: CredentialStore;
	readonly dataStores: { open(name: "entities"): Promise<SqliteDatabase> };
	capabilityLedger(): Promise<CapabilityLedger>;
};

/** One directory row — the entity id plus the parsed definition. */
export type AgentRecord = {
	id: string;
	def: AgentDef;
	createdAt: number;
	updatedAt: number;
};

export type CreateAgentInput = {
	displayName: string;
	persona?: string;
	avatarRef?: string | null;
	routing?: AgentRouting;
	autonomy?: AgentAutonomy;
	memoryScope?: AgentMemoryScope;
	skills?: AgentSkillRef[];
};

/** Editable fields — identity (`pubkey`/`fingerprint`) is structurally absent,
 *  and the ledger ceiling is not data (grant/revoke only). */
export type UpdateAgentInput = Partial<
	Pick<
		AgentDef,
		"displayName" | "persona" | "avatarRef" | "routing" | "autonomy" | "memoryScope" | "skills"
	>
>;

export type AgentGrantResult =
	| { granted: true; grant: CapabilityGrant }
	| { granted: false; reason: "unknown-agent" | "not-grantable" | "invalid" };

export type AgentDirectoryOptions = {
	newId?: () => string;
	now?: () => number;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

async function repoFor(session: AgentDirectorySession): Promise<EntitiesRepository> {
	return new EntitiesRepository(await session.dataStores.open("entities"));
}

function toRecord(row: {
	id: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}): AgentRecord | null {
	const def = readAgentDef(row.properties);
	if (!def) return null;
	return { id: row.id, def, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

// Serialized so consecutive gestures land in gesture order — two unawaited
// appendFile calls have no ordering guarantee, and the activity view reads
// the log as a timeline.
let auditQueue: Promise<void> = Promise.resolve();

function audit(
	session: AgentDirectorySession,
	kind: AuditEventKind,
	metadata: Record<string, unknown>,
): void {
	// Fail-soft: a full disk must not break the gesture; the ledger row is the
	// authoritative state, the audit line is the narrative.
	auditQueue = auditQueue
		.then(() =>
			appendAuditEvent(session.vaultPath, {
				kind,
				vaultId: session.vaultId,
				...metadata,
			}),
		)
		.catch(() => {});
}

/** Create an agent: mint its own Ed25519 keypair (sealed in the credential
 *  store), persist the `Agent/v1` entity, audit. The minted key is removed
 *  again if the entity write fails — no orphan principals. */
export async function createAgent(
	session: AgentDirectorySession,
	input: CreateAgentInput,
	options: AgentDirectoryOptions = {},
): Promise<AgentRecord> {
	const displayName = input.displayName.trim();
	if (!displayName) throw makeError("Invalid", "agents.create: displayName required");

	const repo = await repoFor(session);
	const identity = await createAgentKey(session.credentials);
	const def: AgentDef = {
		pubkey: identity.pubkey,
		fingerprint: identity.fingerprint,
		displayName,
		avatarRef: input.avatarRef ?? null,
		persona: input.persona ?? "",
		skills: input.skills ?? [],
		routing: input.routing ?? AgentRouting.LocalOnly,
		autonomy: input.autonomy ?? AgentAutonomy.ConfirmOnWrite,
		memoryScope: input.memoryScope ?? AgentMemoryScope.PerConversation,
	};
	const now = options.now ? options.now() : Date.now();
	const id = options.newId ? options.newId() : `agt_${ulid()}`;
	try {
		const row = repo.create({
			id,
			type: AGENT_TYPE,
			createdBy: "shell",
			properties: agentDefToEntityProperties(def),
			now,
			dekId: null,
		});
		audit(session, "agent.create", { agent: def.fingerprint, entityId: id });
		const record = toRecord(row);
		if (!record) throw makeError("Unavailable", "agents.create: persisted record failed to parse");
		return record;
	} catch (error) {
		await removeAgentKey(session.credentials, identity.fingerprint).catch(() => {});
		throw error;
	}
}

/** Every live agent in the vault, malformed records dropped (fail-closed). */
export async function listAgents(session: AgentDirectorySession): Promise<AgentRecord[]> {
	const repo = await repoFor(session);
	const rows = repo.query({ type: AGENT_TYPE });
	const records: AgentRecord[] = [];
	for (const row of rows) {
		const record = toRecord(row);
		if (record) records.push(record);
	}
	return records.sort(
		(a, b) => a.def.displayName.localeCompare(b.def.displayName) || a.id.localeCompare(b.id),
	);
}

/** The live agent owning `fingerprint`, or null. */
export async function findAgentByFingerprint(
	session: AgentDirectorySession,
	fingerprint: string,
): Promise<AgentRecord | null> {
	const agents = await listAgents(session);
	return agents.find((a) => a.def.fingerprint === fingerprint) ?? null;
}

/** Update persona/traits/skills. Identity is structurally untouchable; the
 *  stored `pubkey`/`fingerprint` are re-asserted from the current row so even
 *  a widened caller could not swap them. */
export async function updateAgent(
	session: AgentDirectorySession,
	id: string,
	patch: UpdateAgentInput,
	options: AgentDirectoryOptions = {},
): Promise<AgentRecord | null> {
	const repo = await repoFor(session);
	const row = repo.get(id);
	if (!row || row.type !== AGENT_TYPE) return null;
	const current = readAgentDef(row.properties);
	if (!current) return null;
	const next: AgentDef = {
		...current,
		...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() } : {}),
		...(patch.persona !== undefined ? { persona: patch.persona } : {}),
		...(patch.avatarRef !== undefined ? { avatarRef: patch.avatarRef } : {}),
		...(patch.routing !== undefined ? { routing: patch.routing } : {}),
		...(patch.autonomy !== undefined ? { autonomy: patch.autonomy } : {}),
		...(patch.memoryScope !== undefined ? { memoryScope: patch.memoryScope } : {}),
		...(patch.skills !== undefined ? { skills: patch.skills } : {}),
		pubkey: current.pubkey,
		fingerprint: current.fingerprint,
	};
	if (!next.displayName) throw makeError("Invalid", "agents.update: displayName required");
	const now = options.now ? options.now() : Date.now();
	const updated = repo.update(id, agentDefToEntityProperties(next), now);
	return updated ? toRecord(updated) : null;
}

/** Delete an agent: revoke its ENTIRE ledger ceiling, remove its sealed key
 *  (it can never sign again), soft-delete the entity, audit. Order matters —
 *  authority dies first, so a crash mid-delete leaves a powerless record, not
 *  an unlisted-but-authorized ghost. */
export async function deleteAgent(session: AgentDirectorySession, id: string): Promise<boolean> {
	const repo = await repoFor(session);
	const row = repo.get(id);
	if (!row || row.type !== AGENT_TYPE) return false;
	const def = readAgentDef(row.properties);
	const ledger = await session.capabilityLedger();
	let revoked = 0;
	if (def) revoked = ledger.revokeAllFor(def.fingerprint);
	if (def) await removeAgentKey(session.credentials, def.fingerprint).catch(() => {});
	const deleted = repo.softDelete(id, Date.now());
	if (def) {
		audit(session, "agent.delete", { agent: def.fingerprint, entityId: id, revokedGrants: revoked });
	}
	return deleted;
}

/** Live ledger grants for an agent principal. */
export async function listAgentGrants(
	session: AgentDirectorySession,
	fingerprint: string,
): Promise<CapabilityGrant[]> {
	if (!isAgentPrincipal(fingerprint)) return [];
	const ledger = await session.capabilityLedger();
	return ledger.listActive(fingerprint);
}

/** Grant `capability` (a `service.verb[:scope]` string) to the agent owning
 *  `fingerprint`. Fail-closed on unknown agents and on anything outside the
 *  agent-grantable vocabulary. The CALLER is the consent gesture (the Team
 *  surface's explicit human click) — this function is the policy gate. */
export async function grantAgentCapability(
	session: AgentDirectorySession,
	fingerprint: string,
	capability: string,
): Promise<AgentGrantResult> {
	if (!isAgentPrincipal(fingerprint) || typeof capability !== "string" || !capability) {
		return { granted: false, reason: "invalid" };
	}
	const agent = await findAgentByFingerprint(session, fingerprint);
	if (!agent) return { granted: false, reason: "unknown-agent" };
	if (!isAgentGrantableCapability(capability)) return { granted: false, reason: "not-grantable" };
	const { capability: name, scope } = parseCapability(capability);
	const ledger = await session.capabilityLedger();
	const grant = ledger.grant({
		appId: fingerprint,
		capability: name,
		scope,
		grantedVia: GrantedVia.Runtime,
	});
	audit(session, "agent.grant", { agent: fingerprint, capability: name, scope });
	return { granted: true, grant };
}

/** The agent's recent audit trail — lifecycle + authority changes + broker
 *  denials, newest first ("what this agent did" is a filter, doc 69). */
export async function agentActivity(
	session: AgentDirectorySession,
	fingerprint: string,
	limit = 50,
): Promise<AuditEventRecord[]> {
	if (!isAgentPrincipal(fingerprint)) return [];
	return readAgentAuditEvents(session.vaultPath, fingerprint, limit);
}

/** Revoke one of an agent's grants. Returns false when no live grant matched. */
export async function revokeAgentCapability(
	session: AgentDirectorySession,
	fingerprint: string,
	capability: string,
	scope: string | null = null,
): Promise<boolean> {
	if (!isAgentPrincipal(fingerprint)) return false;
	const ledger = await session.capabilityLedger();
	const revoked = ledger.revoke(fingerprint, capability, scope);
	if (revoked) audit(session, "agent.revoke", { agent: fingerprint, capability, scope });
	return revoked;
}
