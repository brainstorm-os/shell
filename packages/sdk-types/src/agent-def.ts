/**
 * `Agent/v1` entity codec (Agent-Teams-1) — the one mapping between an
 * `AgentDef` and the property bag persisted on a `brainstorm/Agent/v1` entity,
 * shared by the main-process agent directory (writes), the roster service
 * (resolves members), and the Team surface (renders/edits).
 *
 * Read side is fail-closed on IDENTITY: a record whose `pubkey` /
 * `fingerprint` don't parse is dropped (null), never guessed — an agent with a
 * forged or mangled identity must not resolve as a member. Trait fields
 * degrade the other way, to the most CONSERVATIVE value (`LocalOnly`,
 * `ConfirmOnWrite`, `PerConversation`): an unknown routing string must never
 * widen an agent to cloud or to autonomous writes.
 *
 * The capability ceiling is deliberately NOT here — it is ledger state, only
 * ever changed through the grant/revoke gesture (doc 69 §Management).
 */

export const AGENT_TYPE = "brainstorm/Agent/v1";

/** How an agent's model calls may be routed. */
export enum AgentRouting {
	LocalOnly = "local-only",
	CloudAllowed = "cloud-allowed",
}

/** How autonomously an agent acts within its frozen capability ceiling. */
export enum AgentAutonomy {
	ConfirmOnWrite = "confirm-on-write",
	AutonomousWithinCaps = "autonomous-within-caps",
}

/** The persistence scope of an agent's own `Memory/v1` partition. */
export enum AgentMemoryScope {
	PerConversation = "per-conversation",
	LongTerm = "long-term",
}

/** What backs a skill an agent can use. */
export enum AgentSkillKind {
	/** A granted intent verb (e.g. a `propose-<type>`). */
	Intent = "intent",
	/** A saved `Workflow/v1` procedure. */
	Workflow = "workflow",
}

/** One skill an agent can use — a granted intent verb or a saved workflow. */
export type AgentSkillRef = {
	kind: AgentSkillKind;
	/** The intent verb id or the `Workflow/v1` entity id. */
	ref: string;
};

/** The persona + traits of an agent member (`brainstorm/Agent/v1`). Its identity
 *  is its own Ed25519 key (`pubkey` / `fingerprint`); its capability CEILING is
 *  ledger state, NOT a field here (that changes only through grant/revoke). The
 *  persona prose, skills, and traits are ordinary editable fields. */
export type AgentDef = {
	/** base64 own Ed25519 public key — a distinct principal in the ledger. */
	pubkey: string;
	/** `ed25519:<hex>` fingerprint — the roster anchor. */
	fingerprint: string;
	/** Human-facing name ("Researcher"). */
	displayName: string;
	/** Encrypted media blob ref for the avatar, or null. */
	avatarRef: string | null;
	/** System-prompt preamble prepended to the harness self-model. */
	persona: string;
	/** Granted intents + saved workflows offered to this agent's loop. */
	skills: AgentSkillRef[];
	/** Local-only vs cloud-allowed model routing. */
	routing: AgentRouting;
	/** Confirm-on-write vs autonomous-within-caps posture. */
	autonomy: AgentAutonomy;
	/** Per-conversation vs long-term memory partition. */
	memoryScope: AgentMemoryScope;
};

/** The portable half of an agent (doc 69 §Marketplace distribution) — what a
 *  starter seed or a marketplace listing ships. Deliberately EXCLUDES the two
 *  non-portable pieces: the keypair (generated locally at instantiation) and
 *  grants (`requestedCapabilities` is a REQUEST manifest like an app's — a
 *  grant only ever comes from the user's consent gesture, never as data). */
export type AgentTemplate = {
	displayName: string;
	avatarRef: string | null;
	persona: string;
	skills: AgentSkillRef[];
	traits: {
		routing: AgentRouting;
		autonomy: AgentAutonomy;
		memoryScope: AgentMemoryScope;
	};
	/** `service.verb[:scope]` strings the template ASKS for — surfaced to the
	 *  user at instantiation, never auto-granted. */
	requestedCapabilities: string[];
};

/** Display-name length ceiling — same order as other entity titles. */
export const AGENT_NAME_MAX_LENGTH = 200;

/** Persona-prose ceiling — a system-prompt preamble, not a document. */
export const AGENT_PERSONA_MAX_LENGTH = 8_000;

/** Skills-list ceiling — a curated set, not an unbounded table. */
export const AGENT_SKILLS_MAX = 64;

const FINGERPRINT_RE = /^ed25519:[0-9a-f]{8,64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function clamp(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

/** Strip C0/C1 control chars — persona/name are prompt + UI strings. */
function stripControl(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		const isControl =
			(code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f);
		if (!isControl) out += ch;
	}
	return out;
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function parseSkills(value: unknown): AgentSkillRef[] {
	if (!Array.isArray(value)) return [];
	const skills: AgentSkillRef[] = [];
	for (const entry of value) {
		if (skills.length >= AGENT_SKILLS_MAX) break;
		if (typeof entry !== "object" || entry === null) continue;
		const kind = (entry as { kind?: unknown }).kind;
		const ref = (entry as { ref?: unknown }).ref;
		if (kind !== AgentSkillKind.Intent && kind !== AgentSkillKind.Workflow) continue;
		if (typeof ref !== "string" || ref.length === 0 || ref.length > 512) continue;
		skills.push({ kind, ref });
	}
	return skills;
}

/** The property bag persisted on a `brainstorm/Agent/v1` entity. `name` (not
 *  `displayName`) so the entity titles correctly in every generic surface. */
export function agentDefToEntityProperties(def: AgentDef): Record<string, unknown> {
	return {
		pubkey: def.pubkey,
		fingerprint: def.fingerprint,
		name: clamp(stripControl(def.displayName), AGENT_NAME_MAX_LENGTH),
		persona: clamp(stripControl(def.persona), AGENT_PERSONA_MAX_LENGTH),
		skills: def.skills.slice(0, AGENT_SKILLS_MAX).map((s) => ({ kind: s.kind, ref: s.ref })),
		routing: def.routing,
		autonomy: def.autonomy,
		memoryScope: def.memoryScope,
		...(def.avatarRef ? { avatarRef: def.avatarRef } : {}),
	};
}

/** Parse a persisted `Agent/v1` property bag back into an `AgentDef`.
 *  Null when the identity halves don't parse (fail-closed — see header). */
export function readAgentDef(properties: Record<string, unknown>): AgentDef | null {
	const pubkey = properties.pubkey;
	const fingerprint = properties.fingerprint;
	if (typeof pubkey !== "string" || pubkey.length === 0 || pubkey.length > 128) return null;
	if (!BASE64_RE.test(pubkey)) return null;
	if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) return null;

	const rawName = typeof properties.name === "string" ? properties.name : "";
	const rawPersona = typeof properties.persona === "string" ? properties.persona : "";
	const avatarRef = typeof properties.avatarRef === "string" ? properties.avatarRef : null;

	return {
		pubkey,
		fingerprint,
		displayName: clamp(stripControl(rawName), AGENT_NAME_MAX_LENGTH),
		avatarRef,
		persona: clamp(stripControl(rawPersona), AGENT_PERSONA_MAX_LENGTH),
		skills: parseSkills(properties.skills),
		routing: parseEnum(
			properties.routing,
			[AgentRouting.LocalOnly, AgentRouting.CloudAllowed],
			AgentRouting.LocalOnly,
		),
		autonomy: parseEnum(
			properties.autonomy,
			[AgentAutonomy.ConfirmOnWrite, AgentAutonomy.AutonomousWithinCaps],
			AgentAutonomy.ConfirmOnWrite,
		),
		memoryScope: parseEnum(
			properties.memoryScope,
			[AgentMemoryScope.PerConversation, AgentMemoryScope.LongTerm],
			AgentMemoryScope.PerConversation,
		),
	};
}
