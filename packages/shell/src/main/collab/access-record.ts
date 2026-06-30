/**
 * Access record — the multi-user collaboration membership log (Collab C1).
 *
 * Stage 10 shipped single-user / multi-device sync (blind relay, per-entity
 * DEKs, HPKE member-wraps, pairing). Multi-USER collaboration — sharing an
 * entity with a *different* person — needs an authorization layer on top of
 * that crypto substrate: who is a member, with what role, granted/revoked by
 * whom and when. This module is that layer's foundation.
 *
 * Per the resolved **OQ-29** : membership
 * lives **inside the entity's Y.Doc** at `root.meta.access`, as an
 * **append-only**, **signed** log; revocation sets `revokedAt` rather than
 * deleting, so audit can always answer "who had access between X and Y". The
 * record lives in the encrypted-at-rest entity doc, so it's only ever visible
 * to current + past members — there is no server-side membership list.
 *
 * Each entry is a `Y.Map` (so `revokedAt` can be set later, concurrent-merge
 * safe) carrying a grant signature by `addedBy` and, once revoked, a revoke
 * signature by `revokedBy`. Both signatures bind the **entityId**, so a grant
 * minted for entity X can't be replayed into entity Y's doc (mirrors the
 * member-wrap AAD binding). Readers verify signatures on every resolve — a
 * tampered role or a forged revoke simply fails to validate and is ignored.
 *
 * Scope of C1: the signed log + grant / revoke / resolve + verification.
 * Authorization *policy* (only an Owner may grant; causal ordering of grants)
 * is a deliberate follow-up — this iteration proves authenticity + lifecycle.
 * The share/invite wire flow (wrap the DEK for the new member + emit it over
 * the relay) and the two-different-users E2E build on top of this.
 */

import * as Y from "yjs";
import { base64ToBytes, bytesToBase64 } from "../credentials/crypto";
import {
	publicKeyFromSecret,
	publicKeyToBase64,
	signPayload,
	verifySignature,
} from "../credentials/identity";
import { getEntityMetaMap } from "../credentials/member-wraps";

/** Bump only on a wire-incompatible change to the entry shape or the signed
 *  payload construction. Pinned into the signed payloads so a future codec can
 *  detect (and refuse) a record minted under a different scheme. */
export const ACCESS_RECORD_VERSION = 1 as const;

/** Key within the entity meta map (`brainstorm.meta`) for the access log.
 *  Sibling of the member-wraps array (`wraps`). */
export const ENTITY_ACCESS_KEY = "access" as const;

/** Membership roles, most → least privileged. String values are the wire
 *  format (stored in the doc), so never renumber — add, don't reorder. */
export enum AccessRole {
	Owner = "owner",
	Editor = "editor",
	Viewer = "viewer",
}

const ROLE_RANK: Readonly<Record<AccessRole, number>> = {
	[AccessRole.Viewer]: 0,
	[AccessRole.Editor]: 1,
	[AccessRole.Owner]: 2,
};

/** True for a value that is one of the known roles. */
export function isAccessRole(value: unknown): value is AccessRole {
	return value === AccessRole.Owner || value === AccessRole.Editor || value === AccessRole.Viewer;
}

/** `a` is at least as privileged as `b`. */
export function roleAtLeast(a: AccessRole, b: AccessRole): boolean {
	return ROLE_RANK[a] >= ROLE_RANK[b];
}

/** The resolved, verification-checked view of one membership entry. Derived
 *  from a stored `Y.Map`; never written directly. */
export type ResolvedMember = {
	/** base64 user-Ed25519 public key of the member. */
	member: string;
	/** base64 device X25519 wrapping key of the member, when the grant carries
	 *  one (collection-sharing, design 71 — so the cascade can wrap a child's DEK
	 *  to this member *authentically*, the X25519 being covered by the grant
	 *  signature). `null` for a pre-collection-sharing grant that signed no key. */
	x25519: string | null;
	role: AccessRole;
	/** base64 user-Ed25519 public key of the granter. */
	addedBy: string;
	addedAt: number;
	revokedAt: number | null;
	revokedBy: string | null;
	/** The grant signature verified under `addedBy` for this entity. */
	grantValid: boolean;
	/** If revoked, the revoke signature verified under `revokedBy`. */
	revokeValid: boolean;
	/** Member is currently active: a valid grant, not validly revoked. */
	active: boolean;
};

const encoder = new TextEncoder();

/** Deterministic signed bytes for a grant. Binds scheme version + entity so a
 *  grant can't be replayed into another entity or read as another version. */
function grantPayload(
	entityId: string,
	member: string,
	role: AccessRole,
	addedBy: string,
	addedAt: number,
	x25519?: string | null,
): Uint8Array {
	// The X25519 segment is included ONLY when the grant carries a member
	// wrapping key (collection-sharing, design 71). Omitting it reproduces the
	// exact bytes of every pre-collection-sharing grant, so their signatures
	// still verify — the presence of the stored `x25519` field on the entry tells
	// `resolveMembers` which form to reconstruct.
	const x = x25519 ? `${x25519}|` : "";
	return encoder.encode(
		`brainstorm/access/v${ACCESS_RECORD_VERSION}/grant|${entityId}|${member}|${x}${role}|${addedBy}|${addedAt}`,
	);
}

/** Deterministic signed bytes for a revoke. Binds the original `addedAt` so a
 *  revoke is tied to the specific grant it cancels. */
function revokePayload(
	entityId: string,
	member: string,
	addedAt: number,
	revokedAt: number,
	revokedBy: string,
): Uint8Array {
	return encoder.encode(
		`brainstorm/access/v${ACCESS_RECORD_VERSION}/revoke|${entityId}|${member}|${addedAt}|${revokedAt}|${revokedBy}`,
	);
}

/** Get-or-create the access `Y.Array` nested under the entity meta map. First
 *  call on a fresh doc installs an empty array in one transaction (one undo
 *  step, one Yjs update). Mirrors `getWrapsArray`. */
export function getAccessArray(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
	const meta = getEntityMetaMap(doc);
	const existing = meta.get(ENTITY_ACCESS_KEY);
	if (existing instanceof Y.Array) return existing as Y.Array<Y.Map<unknown>>;
	const fresh = new Y.Array<Y.Map<unknown>>();
	doc.transact(() => {
		if (!(meta.get(ENTITY_ACCESS_KEY) instanceof Y.Array)) {
			meta.set(ENTITY_ACCESS_KEY, fresh);
		}
	});
	return meta.get(ENTITY_ACCESS_KEY) as Y.Array<Y.Map<unknown>>;
}

function readString(map: Y.Map<unknown>, key: string): string | null {
	const v = map.get(key);
	return typeof v === "string" ? v : null;
}

function readNumber(map: Y.Map<unknown>, key: string): number | null {
	const v = map.get(key);
	return typeof v === "number" ? v : null;
}

/** Find the live (not-yet-revoked) entry for a member, if any. */
function findActiveEntry(arr: Y.Array<Y.Map<unknown>>, member: string): Y.Map<unknown> | null {
	for (let i = 0; i < arr.length; i++) {
		const m = arr.get(i);
		if (readString(m, "member") === member && readNumber(m, "revokedAt") === null) {
			return m;
		}
	}
	return null;
}

/** Grant `member` access to `entityId` at `role`, signed by the holder of
 *  `signerSecret` (the granter's user-Ed25519 secret). Idempotent: if the
 *  member already has a live grant, this is a no-op (use `revokeAccess` then
 *  re-grant to change a role). The append + any install run in one
 *  transaction so the grant propagates as a single Yjs update. */
export function grantAccess(
	doc: Y.Doc,
	opts: {
		entityId: string;
		member: string;
		role: AccessRole;
		signerSecret: Uint8Array;
		now: number;
		/** base64 device X25519 wrapping key for `member`, signed into the grant
		 *  (collection-sharing, design 71). Omit for a key-less grant. */
		x25519?: string | null;
	},
): void {
	const arr = getAccessArray(doc);
	if (findActiveEntry(arr, opts.member) !== null) return;
	const x25519 = opts.x25519 ?? null;
	const addedBy = publicKeyToBase64(publicKeyFromSecret(opts.signerSecret));
	const sig = signPayload(
		opts.signerSecret,
		grantPayload(opts.entityId, opts.member, opts.role, addedBy, opts.now, x25519),
	);
	doc.transact(() => {
		const entry = new Y.Map<unknown>();
		entry.set("v", ACCESS_RECORD_VERSION);
		entry.set("member", opts.member);
		entry.set("x25519", x25519);
		entry.set("role", opts.role);
		entry.set("addedBy", addedBy);
		entry.set("addedAt", opts.now);
		entry.set("grantSig", bytesToBase64(sig));
		entry.set("revokedAt", null);
		entry.set("revokedBy", null);
		entry.set("revokeSig", null);
		arr.push([entry]);
	});
}

/** Revoke `member`'s live grant on `entityId`, signed by `signerSecret`
 *  (the revoker's user-Ed25519 secret). Sets `revokedAt`/`revokedBy`/
 *  `revokeSig` on the existing entry (append-only audit — the entry stays).
 *  Returns true if a live grant was found and revoked. */
export function revokeAccess(
	doc: Y.Doc,
	opts: { entityId: string; member: string; signerSecret: Uint8Array; now: number },
): boolean {
	const arr = getAccessArray(doc);
	const entry = findActiveEntry(arr, opts.member);
	if (entry === null) return false;
	const addedAt = readNumber(entry, "addedAt");
	if (addedAt === null) return false;
	const revokedBy = publicKeyToBase64(publicKeyFromSecret(opts.signerSecret));
	const sig = signPayload(
		opts.signerSecret,
		revokePayload(opts.entityId, opts.member, addedAt, opts.now, revokedBy),
	);
	doc.transact(() => {
		entry.set("revokedAt", opts.now);
		entry.set("revokedBy", revokedBy);
		entry.set("revokeSig", bytesToBase64(sig));
	});
	return true;
}

function safeVerify(publicKeyB64: string, payload: Uint8Array, sigB64: string | null): boolean {
	if (sigB64 === null) return false;
	try {
		return verifySignature(base64ToBytes(publicKeyB64), payload, base64ToBytes(sigB64));
	} catch {
		return false;
	}
}

/** Resolve the full access log into verified membership entries (including
 *  revoked ones — the audit history). Every signature is re-verified against
 *  `entityId`, so a tampered field or a record copied from another entity's
 *  doc fails to validate and is reported `grantValid: false` (and never
 *  `active`). Order follows the append order. */
export function resolveMembers(doc: Y.Doc, entityId: string): ResolvedMember[] {
	const arr = getAccessArray(doc);
	const out: ResolvedMember[] = [];
	for (let i = 0; i < arr.length; i++) {
		const m = arr.get(i);
		const member = readString(m, "member");
		const roleRaw = m.get("role");
		const addedBy = readString(m, "addedBy");
		const addedAt = readNumber(m, "addedAt");
		if (member === null || addedBy === null || addedAt === null || !isAccessRole(roleRaw)) continue;
		const role = roleRaw;
		const x25519 = readString(m, "x25519");
		const revokedAt = readNumber(m, "revokedAt");
		const revokedBy = readString(m, "revokedBy");
		const grantValid = safeVerify(
			addedBy,
			grantPayload(entityId, member, role, addedBy, addedAt, x25519),
			readString(m, "grantSig"),
		);
		const revokeValid =
			revokedAt !== null && revokedBy !== null
				? safeVerify(
						revokedBy,
						revokePayload(entityId, member, addedAt, revokedAt, revokedBy),
						readString(m, "revokeSig"),
					)
				: false;
		out.push({
			member,
			x25519,
			role,
			addedBy,
			addedAt,
			revokedAt,
			revokedBy,
			grantValid,
			revokeValid,
			active: grantValid && !revokeValid,
		});
	}
	return out;
}

/** Collapse the per-entry audit log to ONE row per member — the member's CURRENT
 *  status. `resolveMembers` returns one row per append (the full grant/revoke
 *  audit history), so a member who was revoked then re-granted appears twice; a
 *  consumer doing `find(member)` on that raw list hits the stale revoked row
 *  first and concludes the member is inactive (F-287). This view keeps one row:
 *  an active grant wins; absent one, the latest-granted (by `addedAt`) entry
 *  represents the member. First-seen member order is preserved. Use this for
 *  "who are the members now"; use `resolveMembers` for the audit trail. */
export function resolveCurrentMembers(doc: Y.Doc, entityId: string): ResolvedMember[] {
	const byMember = new Map<string, ResolvedMember>();
	for (const m of resolveMembers(doc, entityId)) {
		const prev = byMember.get(m.member);
		if (!prev) {
			byMember.set(m.member, m);
			continue;
		}
		const preferNew = m.active !== prev.active ? m.active : m.addedAt > prev.addedAt;
		if (preferNew) byMember.set(m.member, m);
	}
	return [...byMember.values()];
}

/** Currently-active members (valid grant, not validly revoked). */
export function activeMembers(doc: Y.Doc, entityId: string): ResolvedMember[] {
	return resolveMembers(doc, entityId).filter((m) => m.active);
}

/** True if `memberB64` is a currently-active member of `entityId`. */
export function isActiveMember(doc: Y.Doc, entityId: string, memberB64: string): boolean {
	return activeMembers(doc, entityId).some((m) => m.member === memberB64);
}

/** The active role for `memberB64`, or null if not an active member. If the
 *  log somehow holds two live grants (concurrent grant before revoke), the
 *  most privileged wins — least-surprise for the holder, and a revoke can
 *  always demote. */
export function roleOf(doc: Y.Doc, entityId: string, memberB64: string): AccessRole | null {
	const roles = activeMembers(doc, entityId)
		.filter((m) => m.member === memberB64)
		.map((m) => m.role);
	if (roles.length === 0) return null;
	return roles.reduce((best, r) => (roleAtLeast(r, best) ? r : best), AccessRole.Viewer);
}
