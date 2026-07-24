/**
 * Agent-11c — provenance + back-links for agent-proposed entities.
 *
 * When the Agent app's propose→approve flow (11a/11b) creates a vault entity on
 * a human approval gesture, that entity carries a stamp of WHICH agent proposed
 * it and in WHICH conversation. This is the durable back-link: the created
 * object points back at the conversation, and the chat surface derives its
 * "created-object" chips from the same stamp.
 *
 * SECURITY — the `agent` field is SERVER-AUTHORITATIVE and must never be trusted
 * from the client. The entities service stamps it from the broker-verified
 * `envelope.app`, never from anything the calling app (or the model whose output
 * the app relays) puts on the wire. The client supplies ONLY the conversation id
 * ({@link AgentProvenanceRequest}); a model can propose draft fields but can
 * never reach this path (the propose tools never persist — only the human
 * approval gesture does), and even a compromised app can only ever attribute a
 * create to ITSELF (its own verified app id). The reserved property key is
 * STRIPPED from every incoming create/update by the service, so an app cannot
 * forge provenance by smuggling {@link AGENT_PROVENANCE_PROPERTY_KEY} in the
 * plain property bag.
 */

/** Reserved entity-property key the entities service owns. An entity's
 *  provenance lives here (mirroring `aiProvenance` on a Message/v1). Service-
 *  reserved: apps never write it directly — the service strips it from every
 *  create/update and only re-stamps it server-side. */
export const AGENT_PROVENANCE_PROPERTY_KEY = "agentProvenance";

/** The provenance stamp carried in an agent-created entity's properties. */
export type AgentProvenance = {
	/** Broker-verified app id of the proposing agent. Server-authoritative —
	 *  the entities service stamps it from `envelope.app`, never the client. */
	agent: string;
	/** The conversation the proposal was approved in (the back-link target). */
	conversationId: string;
	/** When the entity was created (epoch ms). */
	createdAt: number;
};

/** The client-supplied half of a create-time provenance request: the caller
 *  supplies ONLY the conversation id; the `agent` is forced server-side. */
export type AgentProvenanceRequest = {
	conversationId: string;
};

/** Guard the conversation id length so a pathological value can't bloat the
 *  stored bag (a vault entity id is short; this is generous headroom). */
const CONVERSATION_ID_MAX = 256;

/** Validate a wire-supplied provenance request. Fail-closed: anything that
 *  isn't `{ conversationId: <non-empty, bounded string> }` returns null (the
 *  create simply carries no provenance rather than a bogus one). */
export function parseProvenanceRequest(value: unknown): AgentProvenanceRequest | null {
	if (!value || typeof value !== "object") return null;
	const raw = (value as Record<string, unknown>).conversationId;
	if (typeof raw !== "string") return null;
	const conversationId = raw.trim();
	if (conversationId === "" || conversationId.length > CONVERSATION_ID_MAX) return null;
	return { conversationId };
}

/** Build the server-authoritative provenance stamp. `agent` MUST be the
 *  broker-verified `envelope.app` at the one call site (the entities service);
 *  the signature makes the authority explicit so it can't be sourced from
 *  client input by accident. */
export function buildAgentProvenance(
	agent: string,
	conversationId: string,
	createdAt: number,
): AgentProvenance {
	return { agent, conversationId, createdAt };
}

/** Safely read a provenance stamp back out of an entity's properties, or null
 *  when it isn't present / well-formed. Used by the chat surface to derive
 *  created-object chips from the live vault snapshot. */
export function readAgentProvenance(
	properties: Record<string, unknown> | null | undefined,
): AgentProvenance | null {
	if (!properties || typeof properties !== "object") return null;
	const raw = (properties as Record<string, unknown>)[AGENT_PROVENANCE_PROPERTY_KEY];
	if (!raw || typeof raw !== "object") return null;
	const { agent, conversationId, createdAt } = raw as Record<string, unknown>;
	if (typeof agent !== "string" || agent === "") return null;
	if (typeof conversationId !== "string" || conversationId === "") return null;
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
	return { agent, conversationId, createdAt };
}

/** Remove any caller-supplied provenance key from a property bag. The service
 *  calls this on EVERY create/update so an app can never forge provenance by
 *  smuggling the reserved key in its plain properties — the only provenance
 *  that survives is the one the service re-stamps server-side. Returns the same
 *  reference when the key is absent (the common path allocates nothing). */
export function stripAgentProvenance(properties: Record<string, unknown>): Record<string, unknown> {
	if (!(AGENT_PROVENANCE_PROPERTY_KEY in properties)) return properties;
	const { [AGENT_PROVENANCE_PROPERTY_KEY]: _drop, ...rest } = properties;
	return rest;
}
