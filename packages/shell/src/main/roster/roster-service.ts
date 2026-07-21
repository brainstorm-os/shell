/**
 * The `roster` broker service (Collab-C6) — the app-facing window onto vault
 * membership + self-asserted display profiles.
 *
 * Methods:
 *   - `members(entityId)` → {@link RosterMember}[]. The authoritative pubkey
 *     roster from the entity's signed access record, joined to resolved display
 *     profiles. Always includes self. Requires `roster.read`.
 *   - `self()` → {@link RosterSelf}. The local user's own display profile.
 *     Requires `roster.read`.
 *   - `setSelf(input)` → {@link RosterSelf}. Sign + upsert the local profile.
 *     Requires `roster.write`.
 *
 * SECURITY: like the platform / network handlers, the broker's generic declared-
 * caps check is necessary-but-not-sufficient (the app controls `envelope.caps`).
 * `roster.read` / `roster.write` are scarce (not default grants), so we RE-CHECK
 * them against the active vault's ledger here — the authoritative gate. Fail-
 * closed throughout: no vault / no grant / ledger error → a typed `Unavailable` /
 * `Denied`, never a silent roster. `setSelf` always signs under the session's OWN
 * sovereign key for the session's OWN pubkey, so a write can never forge another
 * identity's profile even with the capability.
 */

import type { RosterMember, RosterSelf } from "@brainstorm-os/sdk-types";
import { RosterRole } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { type CapabilityLedger, LedgerUnavailableError } from "../capabilities/ledger";
import { AccessRole, activeMembers } from "../collab/access-record";
import {
	fingerprintOf,
	readProfile,
	readSelfProfile,
	writeSelfProfile,
} from "../collab/profile-store";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import { type ActiveMemberRef, type ResolvedDisplay, joinRoster } from "./roster";

/** Capabilities gating the roster. Scarce — not default grants. */
export const ROSTER_READ_CAPABILITY = "roster.read";
export const ROSTER_WRITE_CAPABILITY = "roster.write";

export type RosterServiceOptions = {
	/** The active vault session, or null when no vault is open (fail closed). */
	readonly getSession: () => VaultSession | null;
	/** SECURITY — the active vault's capability ledger, re-checked server-side.
	 *  Absent → the cap gate is skipped (unit tests that presume authorization). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	readonly now?: () => number;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

const ACCESS_TO_ROSTER_ROLE: Readonly<Record<AccessRole, RosterRole>> = {
	[AccessRole.Owner]: RosterRole.Owner,
	[AccessRole.Editor]: RosterRole.Editor,
	[AccessRole.Viewer]: RosterRole.Viewer,
};

/** Re-check a roster capability against the ledger (the authoritative gate).
 *  Fails closed: ledger error / no vault → `Unavailable`; not held → `Denied`.
 *  No-op when `getLedger` is unwired. */
async function requireCapability(
	envelope: Envelope,
	options: RosterServiceOptions,
	capability: string,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "roster: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "roster: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, capability);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "roster: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError("Denied", `roster.${envelope.method}: ${envelope.app} lacks ${capability}`);
	}
}

function requireSession(options: RosterServiceOptions): VaultSession {
	const session = options.getSession();
	if (!session) throw makeError("Unavailable", "roster: no active vault session");
	return session;
}

async function handleMembers(
	envelope: Envelope,
	options: RosterServiceOptions,
): Promise<RosterMember[]> {
	await requireCapability(envelope, options, ROSTER_READ_CAPABILITY);
	const session = requireSession(options);
	const entityId = typeof envelope.args[0] === "string" ? envelope.args[0] : "";
	if (!entityId) throw makeError("Invalid", "roster.members: entityId required");

	const { doc } = await session.ydocStore.load(entityId);
	const active: ActiveMemberRef[] = activeMembers(doc, entityId).map((m) => ({
		pubkey: m.member,
		role: ACCESS_TO_ROSTER_ROLE[m.role],
	}));

	const db = await session.dataStores.open("entities");
	const repo = new EntitiesRepository(db);
	const selfPubkey = session.identity.publicKeyBase64;
	const selfProfile = readProfile(repo, selfPubkey);

	const resolve = (pubkey: string): ResolvedDisplay => {
		const fingerprint = fingerprintOf(pubkey);
		const profile = pubkey === selfPubkey ? selfProfile : readProfile(repo, pubkey);
		const displayName = profile?.displayName ?? "";
		return {
			fingerprint,
			...(displayName ? { displayName } : {}),
			...(profile?.avatarRef ? { avatarRef: profile.avatarRef } : {}),
		};
	};

	return joinRoster({ selfPubkey, active, resolve });
}

async function handleSelf(envelope: Envelope, options: RosterServiceOptions): Promise<RosterSelf> {
	await requireCapability(envelope, options, ROSTER_READ_CAPABILITY);
	const session = requireSession(options);
	const profile = await readSelfProfile(session);
	return {
		pubkey: profile.pubkey,
		fingerprint: fingerprintOf(profile.pubkey),
		displayName: profile.displayName,
		...(profile.avatarRef ? { avatarRef: profile.avatarRef } : {}),
	};
}

async function handleSetSelf(
	envelope: Envelope,
	options: RosterServiceOptions,
): Promise<RosterSelf> {
	await requireCapability(envelope, options, ROSTER_WRITE_CAPABILITY);
	const session = requireSession(options);
	const input = (envelope.args[0] ?? {}) as { displayName?: unknown; avatarRef?: unknown };
	const displayName = typeof input.displayName === "string" ? input.displayName : "";
	const avatarRef = typeof input.avatarRef === "string" ? input.avatarRef : null;
	const now = options.now ? options.now() : Date.now();
	const profile = await writeSelfProfile(session, { displayName, avatarRef }, now);
	return {
		pubkey: profile.pubkey,
		fingerprint: fingerprintOf(profile.pubkey),
		displayName: profile.displayName,
		...(profile.avatarRef ? { avatarRef: profile.avatarRef } : {}),
	};
}

export function makeRosterServiceHandler(options: RosterServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case "members":
				return await handleMembers(envelope, options);
			case "self":
				return await handleSelf(envelope, options);
			case "setSelf":
				return await handleSetSelf(envelope, options);
			default:
				throw makeError("Invalid", `unknown roster method: ${envelope.method}`);
		}
	};
}
