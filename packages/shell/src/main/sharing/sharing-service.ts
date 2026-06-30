/**
 * The `sharing` broker service (Collab-C5) — the app-facing, capability-gated
 * surface for multi-user share / revoke, over the proven Stage-10 crypto spine
 * (per-entity DEK + HPKE member-wraps + signed access record). It is the
 * production analog of the env-gated `CollabDevBridge`: both drive the same
 * {@link SharingEngine}; this one adds the capability gate + the token
 * (de)serialization, and relies on the always-on {@link LiveSyncEngine} for
 * ongoing sync of a now-shared entity (via `refreshMembership`).
 *
 * Methods:
 *   - `createInvite(label)` → {@link ShareInviteToken}. Mint THIS user's
 *     self-signed invite (public keys only). Requires `sharing.read`.
 *   - `share({entityId, type, invite, role})` → {@link SharedMember}[]. Owner
 *     grants + delivers the DEK. Requires `sharing.share`.
 *   - `revoke({entityId, type, member})` → {@link SharedMember}[]. Owner
 *     revokes (signed audit). Requires `sharing.share`.
 *   - `access(entityId)` → {@link SharedMember}[]. Resolve the access record.
 *     Requires `sharing.read`.
 *
 * SECURITY: like roster / platform, the broker's declared-caps check is
 * necessary-but-not-sufficient (the app controls `envelope.caps`). `sharing.*`
 * is re-checked against the active vault's ledger here — the authoritative gate.
 * `sharing.share` is SCARCE (not a default grant), so by default only trusted
 * shell surfaces can grant access to a vault entity. Fail-closed throughout:
 * no vault / no grant / bad invite → a typed `Unavailable` / `Denied` /
 * `Invalid`, never a silent share. A grant always signs under the session's OWN
 * sovereign key, so the capability can never forge another identity's grant.
 */

import { Buffer } from "node:buffer";
import type { ShareInviteToken, SharedContact, SharedMember } from "@brainstorm/sdk-types";
import { RosterRole } from "@brainstorm/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { type CapabilityLedger, LedgerUnavailableError } from "../capabilities/ledger";
import { AccessRole } from "../collab/access-record";
import type { ContactsStore } from "../collab/contacts-store";
import { type ShareInvite, verifyShareInvite } from "../collab/share-invite";
import type { CollabAccessView, CollabRelayLike } from "../collab/sharing-engine";
import { SharingEngine } from "../collab/sharing-engine";
import type { VaultSession } from "../vault/session";

/** Capabilities gating the share surface. `read` is a default grant (mint your
 *  own invite / read access you can already see); `share` is scarce. */
export const SHARING_READ_CAPABILITY = "sharing.read";
export const SHARING_SHARE_CAPABILITY = "sharing.share";

export type SharingServiceOptions = {
	/** The active vault session, or null when no vault is open (fail closed). */
	readonly getSession: () => VaultSession | null;
	/** The live relay surface (`ActiveRelayOrchestrator`), or null when no
	 *  transport is up. Read on every share so a port swap is transparent. */
	readonly getRelay: () => CollabRelayLike | null;
	/** SECURITY — the active vault's capability ledger, re-checked server-side.
	 *  Absent → the cap gate is skipped (unit tests that presume authorization). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	/** After a grant/revoke mutates the access record, re-evaluate live-sync
	 *  membership so a freshly-shared open entity starts syncing (and a
	 *  fully-revoked one stops). Wired to `LiveSyncEngine.refreshMembership` in
	 *  production; absent in unit tests (the loopback proves the bootstrap). */
	readonly refreshMembership?: (entityId: string, type: string) => void;
	/** The active vault's contacts directory (share-by-name, design 71). Absent
	 *  ⇒ the contacts methods + the `contact` share shorthand are unavailable
	 *  (paste-a-code still works). */
	readonly getContactsStore?: () => Promise<ContactsStore | null>;
	readonly now?: () => number;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

const ROSTER_TO_ACCESS_ROLE: Readonly<Record<RosterRole, AccessRole>> = {
	[RosterRole.Owner]: AccessRole.Owner,
	[RosterRole.Editor]: AccessRole.Editor,
	[RosterRole.Viewer]: AccessRole.Viewer,
};
const ACCESS_TO_ROSTER_ROLE: Readonly<Record<AccessRole, RosterRole>> = {
	[AccessRole.Owner]: RosterRole.Owner,
	[AccessRole.Editor]: RosterRole.Editor,
	[AccessRole.Viewer]: RosterRole.Viewer,
};

function toSharedMember(view: CollabAccessView): SharedMember {
	return {
		pubkey: view.member,
		role: ACCESS_TO_ROSTER_ROLE[view.role],
		active: view.active,
		revokedAt: view.revokedAt,
	};
}

/** Encode a verified `ShareInvite` as a compact, copy-pasteable token. The
 *  invite is all-base64 strings, so plain JSON → base64url is stable + safe
 *  (only public keys + a signature; nothing secret). */
function encodeInviteToken(invite: ShareInvite): ShareInviteToken {
	return Buffer.from(JSON.stringify(invite), "utf8").toString("base64url");
}

/** Decode + cryptographically verify an invite token. Throws `Invalid` on a
 *  malformed token or a bad signature (fail-closed — a forged invite can never
 *  bind a wrapping key to an identity). */
function decodeInviteToken(token: unknown): ShareInvite {
	if (typeof token !== "string" || token.length === 0) {
		throw makeError("Invalid", "sharing: invite token required");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
	} catch {
		throw makeError("Invalid", "sharing: malformed invite token");
	}
	if (!verifyShareInvite(parsed)) {
		throw makeError("Invalid", "sharing: invite failed verification");
	}
	return parsed;
}

function parseRole(value: unknown): AccessRole {
	if (typeof value === "string" && value in ROSTER_TO_ACCESS_ROLE) {
		return ROSTER_TO_ACCESS_ROLE[value as RosterRole];
	}
	throw makeError("Invalid", `sharing: invalid role ${JSON.stringify(value)}`);
}

/** Re-check a sharing capability against the ledger (the authoritative gate).
 *  Fails closed: ledger error / no vault → `Unavailable`; not held → `Denied`.
 *  No-op when `getLedger` is unwired (unit tests). */
async function requireCapability(
	envelope: Envelope,
	options: SharingServiceOptions,
	capability: string,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "sharing: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "sharing: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, capability);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "sharing: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError("Denied", `sharing.${envelope.method}: ${envelope.app} lacks ${capability}`);
	}
}

/** Holds one {@link SharingEngine} bound to the active vault session, rebuilt
 *  when the session swaps (a new vault = a new identity + relay binding).
 *  Exported so the auto-share reactor (collection-sharing flow 2) reuses the
 *  same per-session engine instance the broker service uses. */
export function makeEngineHolder(options: {
	getSession: () => VaultSession | null;
	getRelay: () => CollabRelayLike | null;
}): () => SharingEngine {
	let cached: { engine: SharingEngine; session: VaultSession } | null = null;
	return () => {
		const session = options.getSession();
		if (!session) throw makeError("Unavailable", "sharing: no active vault session");
		if (!cached || cached.session !== session) {
			cached = { engine: new SharingEngine(session, options.getRelay), session };
		}
		return cached.engine;
	};
}

/** Resolve a share target to a verified invite: a pasted `invite` token, or a
 *  saved `contact` pubkey (share-by-name — the stored invite was verified on
 *  save and is re-verified on read). Fail-closed on neither / an unknown
 *  contact / no directory. */
async function resolveInvite(
	input: Record<string, unknown>,
	options: SharingServiceOptions,
): Promise<ShareInvite> {
	if (typeof input.invite === "string" && input.invite.length > 0) {
		return decodeInviteToken(input.invite);
	}
	if (typeof input.contact === "string" && input.contact.length > 0) {
		const store = options.getContactsStore ? await options.getContactsStore() : null;
		if (!store) throw makeError("Unavailable", "sharing: contacts directory unavailable");
		const contact = await store.get(input.contact);
		if (!contact) throw makeError("Invalid", `sharing: no saved contact for ${input.contact}`);
		return contact.invite;
	}
	throw makeError("Invalid", "sharing: an invite token or a saved contact is required");
}

export function makeSharingServiceHandler(options: SharingServiceOptions): ServiceHandler {
	const engineFor = makeEngineHolder(options);

	async function requireContactsStore(): Promise<ContactsStore> {
		const store = options.getContactsStore ? await options.getContactsStore() : null;
		if (!store) throw makeError("Unavailable", "sharing: contacts directory unavailable");
		return store;
	}

	/** Save a teammate's pasted invite under a display name so they can later be
	 *  shared-to by a click (read-tier — a local directory, grants no access). */
	async function handleSaveContact(envelope: Envelope): Promise<SharedContact> {
		await requireCapability(envelope, options, SHARING_READ_CAPABILITY);
		const input = (envelope.args[0] ?? {}) as Record<string, unknown>;
		const invite = decodeInviteToken(input.invite);
		const displayName = typeof input.displayName === "string" ? input.displayName : "";
		const store = await requireContactsStore();
		const contact = await store.add(displayName || invite.label, invite);
		return { pubkey: contact.invite.userPubB64, displayName: contact.displayName };
	}

	/** The saved contacts directory for the share-by-name picker (read-tier). */
	async function handleListContacts(envelope: Envelope): Promise<SharedContact[]> {
		await requireCapability(envelope, options, SHARING_READ_CAPABILITY);
		const store = options.getContactsStore ? await options.getContactsStore() : null;
		if (!store) return [];
		return (await store.list()).map((c) => ({
			pubkey: c.invite.userPubB64,
			displayName: c.displayName,
		}));
	}

	async function handleCreateInvite(envelope: Envelope): Promise<ShareInviteToken> {
		await requireCapability(envelope, options, SHARING_READ_CAPABILITY);
		const label = typeof envelope.args[0] === "string" ? envelope.args[0] : "";
		return encodeInviteToken(engineFor().createInvite(label));
	}

	async function handleShare(envelope: Envelope): Promise<SharedMember[]> {
		await requireCapability(envelope, options, SHARING_SHARE_CAPABILITY);
		const input = (envelope.args[0] ?? {}) as Record<string, unknown>;
		const entityId = typeof input.entityId === "string" ? input.entityId : "";
		const type = typeof input.type === "string" ? input.type : "";
		if (!entityId || !type) throw makeError("Invalid", "sharing.share: entityId + type required");
		const invite = await resolveInvite(input, options);
		const role = parseRole(input.role);
		const view = await engineFor().share({ entityId, type, invite, role });
		options.refreshMembership?.(entityId, type);
		return view.map(toSharedMember);
	}

	async function handleShareCollection(envelope: Envelope): Promise<SharedMember[]> {
		await requireCapability(envelope, options, SHARING_SHARE_CAPABILITY);
		const input = (envelope.args[0] ?? {}) as Record<string, unknown>;
		const entityId = typeof input.entityId === "string" ? input.entityId : "";
		const type = typeof input.type === "string" ? input.type : "";
		if (!entityId || !type) {
			throw makeError("Invalid", "sharing.shareCollection: entityId + type required");
		}
		const invite = await resolveInvite(input, options);
		const role = parseRole(input.role);
		const view = await engineFor().shareCollection({ entityId, type, invite, role });
		options.refreshMembership?.(entityId, type);
		return view.map(toSharedMember);
	}

	async function handleRevoke(envelope: Envelope): Promise<SharedMember[]> {
		await requireCapability(envelope, options, SHARING_SHARE_CAPABILITY);
		const input = (envelope.args[0] ?? {}) as Record<string, unknown>;
		const entityId = typeof input.entityId === "string" ? input.entityId : "";
		const type = typeof input.type === "string" ? input.type : "";
		const member = typeof input.member === "string" ? input.member : "";
		if (!entityId || !member) {
			throw makeError("Invalid", "sharing.revoke: entityId + member required");
		}
		const engine = engineFor();
		await engine.revoke(entityId, member);
		if (type) options.refreshMembership?.(entityId, type);
		return (await engine.access(entityId)).map(toSharedMember);
	}

	async function handleAccess(envelope: Envelope): Promise<SharedMember[]> {
		await requireCapability(envelope, options, SHARING_READ_CAPABILITY);
		const entityId = typeof envelope.args[0] === "string" ? envelope.args[0] : "";
		if (!entityId) throw makeError("Invalid", "sharing.access: entityId required");
		return (await engineFor().access(entityId)).map(toSharedMember);
	}

	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case "createInvite":
				return await handleCreateInvite(envelope);
			case "share":
				return await handleShare(envelope);
			case "shareCollection":
				return await handleShareCollection(envelope);
			case "saveContact":
				return await handleSaveContact(envelope);
			case "listContacts":
				return await handleListContacts(envelope);
			case "revoke":
				return await handleRevoke(envelope);
			case "access":
				return await handleAccess(envelope);
			default:
				throw makeError("Invalid", `unknown sharing method: ${envelope.method}`);
		}
	};
}
