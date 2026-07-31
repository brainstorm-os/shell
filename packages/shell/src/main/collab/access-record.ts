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
	/** Collab-C5-invite-anchor — `"<inviteId>:<mac>"`, the granter's echo of the
	 *  single-use secret this member's invite carried. Covered by the grant
	 *  signature. `null` for a self-grant, a cascade child (see `via`), or any
	 *  pre-anchor grant. */
	anchor: string | null;
	/** Collab-C5-invite-anchor — the container id this entity descends from, for
	 *  a collection-cascade grant. Covered by the grant signature. `null` for a
	 *  direct share. */
	via: string | null;
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

/** A tagged grant segment must carry no `|`, or the segments stop being
 *  separable — see {@link grantPayload}. Empty and absent are the same thing. */
function separable(value: string | null | undefined): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("|");
}

/** Deterministic signed bytes for a grant. Binds scheme version + entity so a
 *  grant can't be replayed into another entity or read as another version. */
function grantPayload(
	entityId: string,
	member: string,
	role: AccessRole,
	addedBy: string,
	addedAt: number,
	x25519?: string | null,
	anchor?: string | null,
	via?: string | null,
): Uint8Array {
	// The X25519 segment is included ONLY when the grant carries a member
	// wrapping key (collection-sharing, design 71). Omitting it reproduces the
	// exact bytes of every pre-collection-sharing grant, so their signatures
	// still verify — the presence of the stored `x25519` field on the entry tells
	// `resolveMembers` which form to reconstruct.
	const x = separable(x25519) ? `${x25519}|` : "";
	// Same rule for the Collab-C5-invite-anchor fields: tagged, terminal, and
	// omitted when absent, so every grant minted before them still verifies. They
	// go last so the older payload is a strict prefix of the newer one.
	//
	// `separable` is what keeps the two tags unambiguous. Without it an
	// `anchor` containing the literal `|v=` would make ONE byte string readable as
	// both `(anchor = "Z|v=Y", via = null)` and `(anchor = "Z", via = "Y")`, so a
	// single signature would cover two different grants. Neither field can
	// legitimately contain a pipe (an anchor is base64url + `:` + base64; a
	// container id is an entity id), so a value that does is not a value - it is
	// refused into the null form and the grant simply fails to validate.
	const a = separable(anchor) ? `|a=${anchor}` : "";
	const v = separable(via) ? `|v=${via}` : "";
	return encoder.encode(
		`brainstorm/access/v${ACCESS_RECORD_VERSION}/grant|${entityId}|${member}|${x}${role}|${addedBy}|${addedAt}${a}${v}`,
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
		/** Collab-C5-invite-anchor — the granter's echo of the member's single-use
		 *  invite secret, `"<inviteId>:<mac>"`. Signed into the grant. */
		anchor?: string | null;
		/** Collab-C5-invite-anchor — the container this entity descends from, for a
		 *  cascade grant. Signed into the grant. */
		via?: string | null;
	},
): void {
	const arr = getAccessArray(doc);
	if (findActiveEntry(arr, opts.member) !== null) return;
	const x25519 = opts.x25519 ?? null;
	// Refused rather than stored: a pipe would make the signed segments ambiguous
	// (see `grantPayload`), and every legitimate value is pipe-free by
	// construction, so this can only be a caller bug or a hostile input.
	// Every field concatenated into the signed payload must be pipe-free, or the
	// segments stop being separable (see `grantPayload`). All of them are base64,
	// base64url or an entity id by construction, so a pipe is a caller bug or a
	// hostile input, never a value.
	for (const [name, value] of [
		["anchor", opts.anchor],
		["via", opts.via],
		["x25519", opts.x25519],
		["entityId", opts.entityId],
		["member", opts.member],
	] as const) {
		if (value?.includes("|")) throw new Error(`grantAccess: ${name} must not contain '|'`);
	}
	const anchor = opts.anchor ?? null;
	const via = opts.via ?? null;
	const addedBy = publicKeyToBase64(publicKeyFromSecret(opts.signerSecret));
	const sig = signPayload(
		opts.signerSecret,
		grantPayload(opts.entityId, opts.member, opts.role, addedBy, opts.now, x25519, anchor, via),
	);
	doc.transact(() => {
		const entry = new Y.Map<unknown>();
		entry.set("v", ACCESS_RECORD_VERSION);
		entry.set("member", opts.member);
		entry.set("x25519", x25519);
		entry.set("anchor", anchor);
		entry.set("via", via);
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
		const x25519raw = readString(m, "x25519");
		const x25519 = separable(x25519raw) ? x25519raw : null;
		// A stored value carrying a pipe cannot have been signed in the tagged form
		// (see `grantPayload`), so read it as absent — the reconstructed payload then
		// mismatches and `grantValid` is false, which is the fail-closed answer.
		const anchorRaw = readString(m, "anchor");
		const viaRaw = readString(m, "via");
		const anchor = separable(anchorRaw) ? anchorRaw : null;
		const via = separable(viaRaw) ? viaRaw : null;
		const revokedAt = readNumber(m, "revokedAt");
		const revokedBy = readString(m, "revokedBy");
		const grantValid = safeVerify(
			addedBy,
			grantPayload(entityId, member, role, addedBy, addedAt, x25519, anchor, via),
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
			anchor,
			via,
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

/**
 * Collab-C5 (F-288) — may `senderPub` WRITE to `entityId`? True iff the
 * sender is a current, active member whose role is Editor or Owner. The
 * sender key arrives base64**url** off the wire header while access grants
 * store std base64, so this compares by decoded BYTES (not string equality)
 * — a false string mismatch would silently drop a legitimate Editor's edits.
 *
 * Fail-closed: an unshared entity (no access record) has no members, so a
 * remote writer resolves to nothing → denied. That is correct — a remote
 * update can only arrive for a shared entity, and a shared entity always
 * carries the owner's self-grant (see `SharingEngine.provisionEntity`), so a
 * genuine owner/editor always resolves. `keyBytesEqual` is byte-exact.
 */
export function isAuthorizedWriter(doc: Y.Doc, entityId: string, senderKey: Uint8Array): boolean {
	for (const m of resolveCurrentMembers(doc, entityId)) {
		if (!m.active) continue;
		if (!roleAtLeast(m.role, AccessRole.Editor)) continue;
		let memberKey: Uint8Array;
		try {
			memberKey = base64ToBytes(m.member);
		} catch {
			continue;
		}
		if (keyBytesEqual(memberKey, senderKey)) return true;
	}
	return false;
}

/**
 * Collab-C5 (F-288 bootstrap) - the SIGNATURE half of the share-bootstrap gate.
 *
 * ⚠️ NOT SUFFICIENT ON ITS OWN, and never call it as the whole gate: an attacker
 * signs their own grants, so a self-signed record passes this predicate. It is
 * exported and kept as a discrete step because `authorizeShareBootstrap`
 * (`share-bootstrap-authz.ts`) layers the out-of-band invite anchor on top of it,
 * and because the adversarial regression test needs to demonstrate exactly what
 * this half does and does not decide. Production must go through
 * `authorizeShareBootstrap`.
 *
 * May `senderKey` write to `entityId` on the
 * strength of the state they are sending, when this device holds no record yet?
 *
 * The FIRST state frame of a new share carries the access record that
 * authorizes it. A receiver whose local doc is still empty therefore has
 * nothing to check {@link isAuthorizedWriter} against and drops the very frame
 * that would make them a member - and every frame after it, on the same empty
 * doc. That is a permanent deadlock, not a conservative denial: dogfood collab
 * `009` reproduced it as `sender <owner> is not an authorized writer` on a
 * brand-new share.
 *
 * Authority here comes from SIGNATURES, not from locality. Every grant is
 * individually Ed25519-signed over `(version, entityId, member, x25519, role,
 * addedBy, addedAt)` and {@link resolveMembers} verifies each one, so checking
 * the record carried INSIDE the frame is exactly as strong as checking a
 * persisted copy of the same signed entries. The relaxation is scoped as
 * tightly as it can be and stays fail-closed:
 *
 *   - it applies ONLY when the local doc carries NO access entries at all - a
 *     doc that already resolved a record is authoritative, so a later frame can
 *     never re-bootstrap around a revoke;
 *   - the incoming state is merged into a THROWAWAY doc, never the real one, so
 *     a rejected bootstrap leaves nothing behind;
 *   - the sender must resolve to an ACTIVE Editor-or-Owner member in that
 *     state; anything else (including a malformed update) denies.
 *
 * Reaching this predicate at all already required the sender to hold the
 * entity DEK and to have produced a valid signature over the frame, so this
 * opens no key-free surface.
 */
/** Ceiling on the state a share BOOTSTRAP may carry (see below). Deliberately
 *  generous against a real opening snapshot and still far under anything that
 *  could stall the main process. */
export const MAX_BOOTSTRAP_STATE_BYTES = 4 * 1024 * 1024;

export function authorizesAsShareBootstrap(
	localDoc: Y.Doc,
	entityId: string,
	senderKey: Uint8Array,
	incomingState: Uint8Array,
): boolean {
	// The real apply of a remote update is delegated to the ydoc WORKER; this
	// probe decodes the same attacker-supplied bytes on the main process, so it
	// gets an explicit ceiling that the worker path does not need. A share's
	// opening state is a fresh doc plus an access record, orders of magnitude
	// under this; anything larger is not a bootstrap and is refused rather than
	// handed to a length-prefixed decoder on the UI thread.
	if (incomingState.byteLength > MAX_BOOTSTRAP_STATE_BYTES) return false;
	if (resolveMembers(localDoc, entityId).length > 0) return false;
	const probe = new Y.Doc();
	try {
		Y.applyUpdate(probe, incomingState);
		return isAuthorizedWriter(probe, entityId, senderKey);
	} catch {
		return false;
	} finally {
		probe.destroy();
	}
}

/** Byte-exact public-key comparison. Keys are stored base64 in the access
 *  record and arrive base64**url** off the wire header, so string equality
 *  silently mismatches a legitimate member - always compare decoded bytes. */
export function keyBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
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
