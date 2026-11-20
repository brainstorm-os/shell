/**
 * Access record — the multi-user collaboration membership log (Collab C1) and
 * its authorization policy (0.16.0, design 71 §Authorization).
 *
 * Membership lives **inside the entity's Y.Doc** at `root.meta.access` (resolved
 * OQ-29) as a log of **signed statements**: a grant (`member` at `role`, signed
 * by `addedBy`) and, once revoked, a revoke (signed by `revokedBy`). Both bind
 * the **entityId**, so a statement minted for entity X cannot be replayed into
 * entity Y. The record rides the encrypted entity doc, so there is no
 * server-side membership list.
 *
 * A valid signature only proves WHO SAID IT. Anyone who can write the doc can
 * write the array, so a signature is not authority - the policy below is, and
 * every reader in this module applies it. There is no raw-entry reader.
 *
 * THE POLICY (owner-rooted, order-free)
 *
 *   Root.   Every entity has one ROOT OWNER: the identity that created its
 *           record (the self-signed Owner grant written when it was first
 *           shared). The root is NOT read from the mutable array on every
 *           resolve - it arrives as {@link AccessTrust}, pinned in local storage
 *           on first sight (`AccessTrustStore`) and never replaced. The root is
 *           always an active Owner and cannot be revoked or demoted, by anyone,
 *           itself included (ownership transfer is deliberately not built).
 *           A device being handed the entity for the first time takes the root
 *           from the GRANTER of its own grant — her genesis grant, or the root
 *           she attests beside the grant — never from whoever relayed the
 *           record ({@link firstSightRoot}).
 *
 *   Tenure. Ownership is held for a TENURE: from the date on the Owner grant
 *           that gave it (signed by an owner whose own tenure covers that date)
 *           until the date on the root's removal of it, or until the granting
 *           owner's tenure ends. The root's tenure is all of time. A tenure is
 *           CURRENT while nothing has ended it anywhere up the chain. The
 *           dates are the signed timestamps of the statements - stamped by the
 *           granting owner and by the root, never by the member concerned.
 *
 *   Grants. A grant has effect only when dated within a CURRENT tenure of its
 *           signer. So an Editor or a Viewer cannot add anyone; a grant signed
 *           by a co-owner stops counting when she is removed; and it does not
 *           come back if she is made an owner again - that is a new tenure,
 *           and covers only what she signs from then on.
 *
 *   Revokes. A revoke of an Owner grant has effect only when signed by the root
 *           or by the member themselves. A revoke of an Editor/Viewer grant has
 *           effect when signed by the member themselves (leaving) or when
 *           dated within ANY tenure of its signer, ended or not. The asymmetry
 *           is deliberate and fail-closed: removing a co-owner must never
 *           resurrect the people she removed. What she signs dated after her
 *           removal has no effect, and an Owner grant she hands out then
 *           confers nothing. (She chooses the dates on what she signs, so a
 *           removed co-owner who BACK-dates a revoke into her old tenure, and
 *           gets a current writer to relay it, can still remove a member. A
 *           co-owner who left of her own accord keeps this revoke power.)
 *
 *   Everything else is ignored. An entry that fails the policy may stay in the
 *   CRDT; it has no effect on any reader.
 *
 * Why order-free: array position and Yjs clocks are attacker-influenced, and
 * existing records carry no causal link to bind them. The only ordering used
 * is between a statement's own signed date and its signer's tenure. The rules
 * above are a pure function of the SET of signed
 * statements plus the root, so two replicas holding the same statements resolve
 * identically whatever order they arrived or sit in.
 *
 * Deletion. A writer can delete or overwrite anything in the array, and Yjs
 * discards deleted content, so the doc alone cannot be the memory of a revoke.
 * A revoke therefore targets a GRANT IDENTITY `(member, addedAt)` rather than an
 * array slot (re-appending a copy of a revoked grant does not un-revoke it), and
 * each device REMEMBERS the statements it has seen take effect
 * ({@link AccessMemory}, persisted by `AccessTrustStore`). Resolution runs over
 * the union of the doc and that memory, so deleting an entry changes nothing on
 * a device that has seen it, and {@link repairAccessRecord} writes it back.
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
	/** The grant's signer holds authority under the policy (a current owner).
	 *  A correctly-signed grant from anyone else is `grantValid` and nothing more. */
	authorized: boolean;
	/** A revoke of this grant has effect under the policy. `revokedAt` /
	 *  `revokedBy` are that revoke's, and null when no revoke counts. */
	revokeValid: boolean;
	/** Member is currently active: an authorized grant with no effective revoke. */
	active: boolean;
};

/** The signed fields of one grant. */
export type GrantStatement = {
	member: string;
	x25519: string | null;
	anchor: string | null;
	via: string | null;
	role: AccessRole;
	addedBy: string;
	addedAt: number;
	grantSig: string;
};

/** The signed fields of one revoke. It names the grant it cancels by
 *  `(member, addedAt)`, never by where that grant sits in the array. */
export type RevokeStatement = {
	member: string;
	addedAt: number;
	revokedAt: number;
	revokedBy: string;
	revokeSig: string;
};

/** Statements this device has already seen take effect. Resolution unions them
 *  with the doc, so they survive deletion from the array. */
export type AccessMemory = {
	grants: readonly GrantStatement[];
	revokes: readonly RevokeStatement[];
};

/** What a reader must bring to resolve a record: the root of authority, and
 *  what this device remembers. `root: null` means no root is known, and then
 *  NOBODY resolves as a member - the fail-closed answer. */
export type AccessTrust = {
	root: string | null;
	memory?: AccessMemory;
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

/** Deterministic signed bytes for a ROOT ATTESTATION: the granter of
 *  `(member, addedAt)` stating who the entity's root owner is. It rides the
 *  entry beside the grant (not inside the grant payload, so a pre-0.16 reader
 *  still verifies the grant) and is read in exactly one place: by the member it
 *  names, the first time they see the record ({@link firstSightRoot}). */
function rootAttestationPayload(
	entityId: string,
	member: string,
	addedBy: string,
	addedAt: number,
	root: string,
): Uint8Array {
	return encoder.encode(
		`brainstorm/access/v${ACCESS_RECORD_VERSION}/root|${entityId}|${member}|${addedBy}|${addedAt}|${root}`,
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

/** The access array if the doc has one — never creates it, so a READ leaves the
 *  doc untouched (and never throws on a record someone replaced with junk). */
function readAccessArray(doc: Y.Doc): Y.Array<unknown> | null {
	const value = getEntityMetaMap(doc).get(ENTITY_ACCESS_KEY);
	return value instanceof Y.Array ? (value as Y.Array<unknown>) : null;
}

/** Does the doc carry ANY access entry, effective or not? Structural only — it
 *  answers "has a record ever been written here", never "who is a member". */
export function hasAccessEntries(doc: Y.Doc): boolean {
	return (readAccessArray(doc)?.length ?? 0) > 0;
}

function grantOf(entry: Y.Map<unknown>): GrantStatement | null {
	const member = readString(entry, "member");
	const role = entry.get("role");
	const addedBy = readString(entry, "addedBy");
	const addedAt = readNumber(entry, "addedAt");
	const grantSig = readString(entry, "grantSig");
	if (member === null || addedBy === null || addedAt === null || grantSig === null) return null;
	if (!isAccessRole(role)) return null;
	// A stored value carrying a pipe cannot have been signed in the tagged form
	// (see `grantPayload`), so read it as absent — the reconstructed payload then
	// mismatches and the signature fails, which is the fail-closed answer.
	const x25519 = readString(entry, "x25519");
	const anchor = readString(entry, "anchor");
	const via = readString(entry, "via");
	return {
		member,
		x25519: separable(x25519) ? x25519 : null,
		anchor: separable(anchor) ? anchor : null,
		via: separable(via) ? via : null,
		role,
		addedBy,
		addedAt,
		grantSig,
	};
}

function revokeOf(entry: Y.Map<unknown>): RevokeStatement | null {
	const member = readString(entry, "member");
	const addedAt = readNumber(entry, "addedAt");
	const revokedAt = readNumber(entry, "revokedAt");
	const revokedBy = readString(entry, "revokedBy");
	const revokeSig = readString(entry, "revokeSig");
	if (member === null || addedAt === null) return null;
	if (revokedAt === null || revokedBy === null || revokeSig === null) return null;
	return { member, addedAt, revokedAt, revokedBy, revokeSig };
}

function safeVerify(publicKeyB64: string, payload: Uint8Array, sigB64: string): boolean {
	try {
		return verifySignature(base64ToBytes(publicKeyB64), payload, base64ToBytes(sigB64));
	} catch {
		return false;
	}
}

function grantSignatureValid(entityId: string, g: GrantStatement): boolean {
	return safeVerify(
		g.addedBy,
		grantPayload(entityId, g.member, g.role, g.addedBy, g.addedAt, g.x25519, g.anchor, g.via),
		g.grantSig,
	);
}

function revokeSignatureValid(entityId: string, r: RevokeStatement): boolean {
	return safeVerify(
		r.revokedBy,
		revokePayload(entityId, r.member, r.addedAt, r.revokedAt, r.revokedBy),
		r.revokeSig,
	);
}

/** Every field, so two entries are "the same statement" only when they agree
 *  on all of them — a copy with one field changed is a different (and, its
 *  signature no longer matching, invalid) statement, never a shadow of the real
 *  one. */
function grantKey(g: GrantStatement): string {
	return JSON.stringify([
		g.member,
		g.x25519,
		g.anchor,
		g.via,
		g.role,
		g.addedBy,
		g.addedAt,
		g.grantSig,
	]);
}

function revokeKey(r: RevokeStatement): string {
	return JSON.stringify([r.member, r.addedAt, r.revokedAt, r.revokedBy, r.revokeSig]);
}

/** The grant a revoke cancels. */
function targetKey(member: string, addedAt: number): string {
	return JSON.stringify([member, addedAt]);
}

type Statements = { grants: GrantStatement[]; revokes: RevokeStatement[] };

/** Every distinct statement in the doc and in memory, signature-checked. Doc
 *  order first, then anything only memory still holds. */
function collectStatements(doc: Y.Doc, entityId: string, memory?: AccessMemory): Statements {
	const grants = new Map<string, GrantStatement>();
	const revokes = new Map<string, RevokeStatement>();
	const array = readAccessArray(doc);
	if (array) {
		for (const entry of array.toArray()) {
			// A 0.16 device writes only maps here, but the array is writable by any
			// member and by any future version, so a foreign element is skipped
			// rather than dereferenced.
			if (!(entry instanceof Y.Map)) continue;
			const grant = grantOf(entry as Y.Map<unknown>);
			if (grant) grants.set(grantKey(grant), grant);
			const revoke = revokeOf(entry as Y.Map<unknown>);
			if (revoke) revokes.set(revokeKey(revoke), revoke);
		}
	}
	for (const grant of memory?.grants ?? []) {
		if (!grants.has(grantKey(grant))) grants.set(grantKey(grant), grant);
	}
	for (const revoke of memory?.revokes ?? []) {
		if (!revokes.has(revokeKey(revoke))) revokes.set(revokeKey(revoke), revoke);
	}
	return {
		grants: [...grants.values()].filter((g) => grantSignatureValid(entityId, g)),
		revokes: [...revokes.values()].filter((r) => revokeSignatureValid(entityId, r)),
	};
}

/** A stretch of time during which a member held ownership: from the Owner
 *  grant that gave it (`start`, the grant's `addedAt`) until the root removed
 *  them or the tenure of whoever granted it ended (`end`, exclusive).
 *  `current` ⇔ it is still running: nothing has ended it, all the way up the
 *  chain to the root. Times are the SIGNED timestamps of the statements - the
 *  granting owner's for `start`, the root's for a removal - so the member whose
 *  tenure it is chooses neither. */
type Tenure = { start: number; end: number; current: boolean };

const ROOT_TENURE: Tenure = {
	start: Number.NEGATIVE_INFINITY,
	end: Number.POSITIVE_INFINITY,
	current: true,
};

function covering(tenures: Iterable<Tenure> | undefined, at: number): Tenure | null {
	let best: Tenure | null = null;
	for (const t of tenures ?? []) {
		if (t.start > at || at >= t.end) continue;
		if (
			best === null ||
			(t.current && !best.current) ||
			(t.current === best.current && t.end > best.end)
		) {
			best = t;
		}
	}
	return best;
}

/** Every member's tenures as an owner — the least fixed point of "the root,
 *  always; and the member of an Owner grant signed by someone who held
 *  ownership at the moment the grant is dated". */
function ownerTenures(
	root: string,
	grants: readonly GrantStatement[],
	ownerRevoke: (grant: GrantStatement) => RevokeStatement | null,
): Map<string, Map<string, Tenure>> {
	const held = new Map<string, Map<string, Tenure>>([[root, new Map([["", ROOT_TENURE]])]]);
	for (let changed = true; changed; ) {
		changed = false;
		for (const g of grants) {
			if (g.role !== AccessRole.Owner || g.member === root) continue;
			const backing = covering(held.get(g.addedBy)?.values(), g.addedAt);
			if (!backing) continue;
			const revoke = ownerRevoke(g);
			// The root's removal ends the tenure at the time the ROOT signed. A
			// member's own leave ends its being current, but not the stretch in
			// which her earlier acts are honoured: she picks that timestamp, and a
			// back-dated leave must not be a way to undo the revokes she made.
			const end =
				revoke !== null && revoke.revokedBy === root
					? Math.min(backing.end, revoke.revokedAt)
					: backing.end;
			const current = backing.current && revoke === null;
			if (end <= g.addedAt) continue;
			const key = grantKey(g);
			const mine = held.get(g.member) ?? new Map<string, Tenure>();
			const prev = mine.get(key);
			if (prev && prev.end >= end && (prev.current || !current)) continue;
			mine.set(key, {
				start: g.addedAt,
				end: Math.max(prev?.end ?? end, end),
				current: (prev?.current ?? false) || current,
			});
			held.set(g.member, mine);
			changed = true;
		}
	}
	return held;
}

type Evaluation = {
	/** One row per distinct signature-valid grant. */
	rows: ResolvedMember[];
	/** Current owners — who may grant — and since when (their earliest running
	 *  tenure's start; `-Infinity` for the root). */
	owners: ReadonlyMap<string, number>;
	/** The statements that had effect — what a device remembers. */
	counted: AccessMemory;
	/** The latest signed timestamp among the statements `member` signed that
	 *  have (or had) effect, or null. */
	lastActOf: (member: string) => number | null;
};

const NOBODY: Evaluation = {
	rows: [],
	owners: new Map(),
	counted: { grants: [], revokes: [] },
	lastActOf: () => null,
};

/** THE POLICY. See the module header; this is the only place it is decided. */
function evaluate(doc: Y.Doc, entityId: string, trust: AccessTrust): Evaluation {
	const root = trust.root;
	if (root === null) return NOBODY;
	const { grants, revokes } = collectStatements(doc, entityId, trust.memory);
	const revokesByTarget = new Map<string, RevokeStatement[]>();
	for (const r of revokes) {
		const key = targetKey(r.member, r.addedAt);
		const list = revokesByTarget.get(key);
		if (list) list.push(r);
		else revokesByTarget.set(key, [r]);
	}
	// Several effective revokes of one grant: the earliest, with a total order
	// behind it so every replica picks the same one.
	const earliest = (
		g: GrantStatement,
		counts: (r: RevokeStatement) => boolean,
	): RevokeStatement | null => {
		let chosen: RevokeStatement | null = null;
		for (const r of revokesByTarget.get(targetKey(g.member, g.addedAt)) ?? []) {
			if (!counts(r)) continue;
			if (
				chosen === null ||
				r.revokedAt < chosen.revokedAt ||
				(r.revokedAt === chosen.revokedAt && r.revokeSig < chosen.revokeSig)
			) {
				chosen = r;
			}
		}
		return chosen;
	};
	// An Owner grant ends only by the root's hand or the member's own. The
	// root's wins when both exist: it is the one that bounds her tenure.
	const ownerRevoke = (g: GrantStatement): RevokeStatement | null =>
		g.member === root
			? null
			: (earliest(g, (r) => r.revokedBy === root) ?? earliest(g, (r) => r.revokedBy === g.member));
	const tenures = ownerTenures(root, grants, ownerRevoke);
	const heldAt = (member: string, at: number): Tenure | null =>
		covering(tenures.get(member)?.values(), at);
	const effectiveRevoke = (g: GrantStatement): RevokeStatement | null => {
		if (g.member === root) return null;
		if (g.role === AccessRole.Owner) return ownerRevoke(g);
		// Anyone else's grant: the member leaving, or someone who held ownership
		// at the moment the revoke is dated.
		return earliest(g, (r) => r.revokedBy === g.member || heldAt(r.revokedBy, r.revokedAt) !== null);
	};
	const owners = new Map<string, number>();
	for (const [member, mine] of tenures) {
		for (const t of mine.values()) {
			if (t.current) owners.set(member, Math.min(owners.get(member) ?? t.start, t.start));
		}
	}

	const rows: ResolvedMember[] = [];
	const countedGrants: GrantStatement[] = [];
	const countedRevokes = new Map<string, RevokeStatement>();
	let rootIsOwner = false;
	const lastAct = new Map<string, number>();
	const acted = (member: string, at: number): void => {
		lastAct.set(member, Math.max(lastAct.get(member) ?? at, at));
	};
	for (const g of grants) {
		// In force NOW: signed by someone whose ownership is still running and
		// had begun when the grant is dated. A grant from before a co-owner's
		// removal does not come back when she is made an owner again.
		const backing = heldAt(g.addedBy, g.addedAt);
		const authorized = backing?.current === true;
		const revoke = backing ? effectiveRevoke(g) : null;
		const active = authorized && revoke === null;
		// Remembered whenever it EVER had effect: a tenure that has ended still
		// has to be reconstructible, or the revokes made during it would lapse.
		if (backing) {
			countedGrants.push(g);
			acted(g.addedBy, g.addedAt);
		}
		if (revoke) {
			countedRevokes.set(revokeKey(revoke), revoke);
			acted(revoke.revokedBy, revoke.revokedAt);
		}
		if (active && g.member === root && g.role === AccessRole.Owner) rootIsOwner = true;
		rows.push({
			member: g.member,
			x25519: g.x25519,
			anchor: g.anchor,
			via: g.via,
			role: g.role,
			addedBy: g.addedBy,
			addedAt: g.addedAt,
			revokedAt: revoke?.revokedAt ?? null,
			revokedBy: revoke?.revokedBy ?? null,
			grantValid: true,
			authorized,
			revokeValid: revoke !== null,
			active,
		});
	}
	// The root's standing comes from the pin, not from an entry a writer could
	// delete: with its self-grant gone it is still the Owner.
	if (!rootIsOwner) {
		rows.unshift({
			member: root,
			x25519: null,
			anchor: null,
			via: null,
			role: AccessRole.Owner,
			addedBy: root,
			addedAt: 0,
			revokedAt: null,
			revokedBy: null,
			grantValid: true,
			authorized: true,
			revokeValid: false,
			active: true,
		});
	}
	return {
		rows,
		owners,
		counted: { grants: countedGrants, revokes: [...countedRevokes.values()] },
		lastActOf: (member) => lastAct.get(member) ?? null,
	};
}

/** The statements in `doc` (and `trust.memory`) that have effect under the
 *  policy — what `AccessTrustStore` persists as this device's memory. */
export function effectiveStatements(
	doc: Y.Doc,
	entityId: string,
	trust: AccessTrust,
): AccessMemory {
	return evaluate(doc, entityId, trust).counted;
}

/**
 * Work out the root owner from a record this device has no pin for — trust on
 * first use. Returns null when the record does not single one out, and then
 * nothing is pinned and nobody resolves.
 *
 * A root is always the signer of a self-signed Owner grant. Which one:
 *   1. `self`, when this identity signed one — nobody else can forge that, and
 *      this identity only ever signs one into an empty record, as its creator;
 *   2. `sender`, when the authenticated party handing us the record signed one
 *      — the inviter who gave us the DEK is who we trust on first sight (the
 *      bootstrap gate then still demands that their record makes us a member,
 *      and an out-of-band anchor);
 *   3. otherwise the ONLY candidate under which `self` is an active member (or,
 *      with no `self`, the only candidate at all). Two candidates is a record
 *      someone has tampered with, and it is refused rather than guessed at.
 */
export function deriveAccessRoot(
	doc: Y.Doc,
	entityId: string,
	hints: { self?: string; sender?: string; memory?: AccessMemory } = {},
): string | null {
	const { grants } = collectStatements(doc, entityId, hints.memory);
	const candidates = new Set<string>();
	for (const g of grants) {
		if (g.role === AccessRole.Owner && g.member === g.addedBy) candidates.add(g.member);
	}
	if (hints.self !== undefined && candidates.has(hints.self)) return hints.self;
	const admits = (root: string): boolean => {
		if (hints.self === undefined) return true;
		const trust: AccessTrust = hints.memory ? { root, memory: hints.memory } : { root };
		return evaluate(doc, entityId, trust).rows.some((m) => m.active && m.member === hints.self);
	};
	if (hints.sender !== undefined && candidates.has(hints.sender)) return hints.sender;
	const admitted = [...candidates].filter(admits);
	return admitted.length === 1 ? (admitted[0] ?? null) : null;
}

/**
 * The root owner of a record `selfB64` is being handed for the FIRST time (the
 * share-bootstrap gate), or null when the record does not establish one.
 *
 * The party trusted on first sight is the GRANTER of the grant that names us —
 * not whoever relayed the frame, because any member holds the DEK and can send
 * us a record of their own composition. The gate authenticates that granter
 * out of band (the invite anchor is a MAC only the holder of our invite secret
 * could compute over the granter's key; a cascade granter must be a member of a
 * container we already hold). So the root is:
 *
 *   - us, if we signed the record's genesis grant ourselves;
 *   - the granter, if the record carries the granter's own genesis grant;
 *   - otherwise the root the granter ATTESTS on our grant (0.16+ granters).
 *
 * and in every case our grant must actually count under that root. A grant
 * from a pre-0.16 co-owner carries no attestation and establishes nothing —
 * the entity's root owner has to share it, or the co-owner upgrade.
 */
export function firstSightRoot(
	doc: Y.Doc,
	entityId: string,
	selfB64: string,
	/** Which of the grants naming us may be believed. The bootstrap gate
	 *  authenticates the granter itself afterwards and passes nothing; a device
	 *  working out the root of a doc it already HOLDS passes its anchor check. */
	accept: (grant: GrantStatement) => boolean = () => true,
): string | null {
	const genesis = new Set<string>();
	const naming: Array<{ grant: GrantStatement; attested: string | null }> = [];
	for (const entry of readAccessArray(doc)?.toArray() ?? []) {
		if (!(entry instanceof Y.Map)) continue;
		const grant = grantOf(entry as Y.Map<unknown>);
		if (!grant || !grantSignatureValid(entityId, grant)) continue;
		if (grant.role === AccessRole.Owner && grant.member === grant.addedBy) genesis.add(grant.member);
		if (grant.member !== selfB64 || !accept(grant)) continue;
		const root = readString(entry as Y.Map<unknown>, "root");
		const rootSig = readString(entry as Y.Map<unknown>, "rootSig");
		const attested =
			root !== null &&
			rootSig !== null &&
			safeVerify(
				grant.addedBy,
				rootAttestationPayload(entityId, grant.member, grant.addedBy, grant.addedAt, root),
				rootSig,
			)
				? root
				: null;
		naming.push({ grant, attested });
	}
	if (genesis.has(selfB64)) return selfB64;
	// Anchored grants first (the strongest out-of-band binding), then a fixed
	// order, so every device considers the same grant first.
	naming.sort(
		(a, b) =>
			Number(b.grant.anchor !== null) - Number(a.grant.anchor !== null) ||
			b.grant.addedAt - a.grant.addedAt ||
			(a.grant.grantSig < b.grant.grantSig ? -1 : 1),
	);
	for (const { grant, attested } of naming) {
		const root = genesis.has(grant.addedBy) ? grant.addedBy : attested;
		if (root === null) continue;
		const counts = evaluate(doc, entityId, { root }).rows.some(
			(m) =>
				m.active && m.member === selfB64 && m.addedBy === grant.addedBy && m.addedAt === grant.addedAt,
		);
		if (counts) return root;
	}
	return null;
}

/** Has anything ever been DELETED from the record's array, or the array itself
 *  been replaced? No version of this code deletes an entry (a revoke is written
 *  onto its entry; a repair appends), so a tombstone here is a member having
 *  removed statements - evidence that what remains may not be the whole story.
 *  Reads Yjs's item lists, the only place a deletion stays visible. */
export function accessRecordTampered(doc: Y.Doc): boolean {
	type Items = { _start: Y.Item | null; _map: Map<string, Y.Item> };
	const meta = getEntityMetaMap(doc) as unknown as Items;
	const latest = meta._map.get(ENTITY_ACCESS_KEY);
	if (!latest) return false;
	for (let item: Y.Item | null = latest; item; item = item.left) {
		if (item.deleted) return true;
	}
	const array = readAccessArray(doc) as unknown as Items | null;
	for (let item = array?._start ?? null; item; item = item.right) {
		if (item.deleted) return true;
	}
	return false;
}

/** Does any correctly-signed grant in the doc name `memberB64`? Structural —
 *  it says the record MENTIONS them, never that they are a member. */
export function hasGrantNaming(doc: Y.Doc, entityId: string, memberB64: string): boolean {
	return collectStatements(doc, entityId).grants.some((g) => g.member === memberB64);
}

/** UNPINNED trust: the root is derived from the doc on the spot. For a doc this
 *  device does not hold yet (a bootstrap probe) and for tests. Production
 *  readers of a PERSISTED doc go through `AccessTrustStore.trustFor`, which pins
 *  the root the first time and never lets the record change it afterwards. */
export function docTrust(
	doc: Y.Doc,
	entityId: string,
	hints: { self?: string; sender?: string } = {},
): AccessTrust {
	return { root: deriveAccessRoot(doc, entityId, hints) };
}

function signerPubOf(signerSecret: Uint8Array): string {
	return publicKeyToBase64(publicKeyFromSecret(signerSecret));
}

/** Grant `member` access to `entityId` at `role`, signed by the holder of
 *  `signerSecret`. Idempotent: if the member already has an EFFECTIVE grant this
 *  is a no-op (change a role with `revokeAccess` then re-grant) — an entry that
 *  merely sits in the array without authority does not block a real one.
 *
 *  This is the write primitive and it signs whatever it is asked to: authority
 *  is decided when the record is READ, so a grant from a signer who holds none
 *  is written and then ignored by every reader. Callers that want to refuse up
 *  front ask {@link mayGrant} first. The append runs in one transaction so the
 *  grant propagates as a single Yjs update. */
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
		/** The pinned trust for this entity. Omitted ⇒ derived from the doc with
		 *  the signer as `self`. */
		trust?: AccessTrust;
	},
): void {
	const addedBy = signerPubOf(opts.signerSecret);
	const trust = opts.trust ?? docTrust(doc, opts.entityId, { self: addedBy });
	const standing = evaluate(doc, opts.entityId, trust);
	if (standing.rows.some((m) => m.active && m.member === opts.member)) return;
	// A grant only counts when dated within its signer's tenure, and that
	// tenure starts at a time some OTHER owner's clock stamped. Never date one
	// before it because this device's clock runs behind theirs.
	const since = standing.owners.get(addedBy);
	const addedAt =
		since !== undefined && Number.isFinite(since) ? Math.max(opts.now, since) : opts.now;
	const arr = getAccessArray(doc);
	const x25519 = opts.x25519 ?? null;
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
	const sig = signPayload(
		opts.signerSecret,
		grantPayload(opts.entityId, opts.member, opts.role, addedBy, addedAt, x25519, anchor, via),
	);
	// A granter who is not the root tells the new member who is. The member has
	// no other way to learn it that a relaying collaborator could not forge: the
	// root's own genesis grant identifies the root only when the root is the one
	// granting.
	const root = trust.root;
	const attest = root !== null && root !== addedBy;
	doc.transact(() => {
		const entry = entryFor(
			{
				member: opts.member,
				x25519,
				anchor,
				via,
				role: opts.role,
				addedBy,
				addedAt,
				grantSig: bytesToBase64(sig),
			},
			null,
		);
		if (attest) {
			entry.set("root", root);
			entry.set(
				"rootSig",
				bytesToBase64(
					signPayload(
						opts.signerSecret,
						rootAttestationPayload(opts.entityId, opts.member, addedBy, addedAt, root),
					),
				),
			);
		}
		arr.push([entry]);
	});
}

function entryFor(grant: GrantStatement, revoke: RevokeStatement | null): Y.Map<unknown> {
	const entry = new Y.Map<unknown>();
	entry.set("v", ACCESS_RECORD_VERSION);
	entry.set("member", grant.member);
	entry.set("x25519", grant.x25519);
	entry.set("anchor", grant.anchor);
	entry.set("via", grant.via);
	entry.set("role", grant.role);
	entry.set("addedBy", grant.addedBy);
	entry.set("addedAt", grant.addedAt);
	entry.set("grantSig", grant.grantSig);
	entry.set("revokedAt", revoke?.revokedAt ?? null);
	entry.set("revokedBy", revoke?.revokedBy ?? null);
	entry.set("revokeSig", revoke?.revokeSig ?? null);
	return entry;
}

function writeRevoke(entry: Y.Map<unknown>, revoke: RevokeStatement): void {
	entry.set("revokedAt", revoke.revokedAt);
	entry.set("revokedBy", revoke.revokedBy);
	entry.set("revokeSig", revoke.revokeSig);
}

/** Revoke `member`'s effective grant(s) on `entityId`, signed by `signerSecret`.
 *  Writes the revoke onto the entry (the entry stays, as audit). Returns true if
 *  an effective grant was found and a revoke written.
 *
 *  The target is chosen by the POLICY, not by which entries look un-revoked: a
 *  member who scribbles a junk revoke onto her own entry has not revoked
 *  herself, and must not thereby become un-revokable — the junk is overwritten.
 *
 *  Like {@link grantAccess} this signs what it is asked to; a revoke from a
 *  signer without authority is written and ignored. Ask {@link mayRevoke} first
 *  to refuse up front. */
export function revokeAccess(
	doc: Y.Doc,
	opts: {
		entityId: string;
		member: string;
		signerSecret: Uint8Array;
		now: number;
		trust?: AccessTrust;
	},
): boolean {
	const revokedBy = signerPubOf(opts.signerSecret);
	const trust = opts.trust ?? docTrust(doc, opts.entityId, { self: revokedBy });
	const standing = evaluate(doc, opts.entityId, trust);
	const live = new Set<string>();
	for (const m of standing.rows) {
		if (m.active && m.member === opts.member) live.add(targetKey(m.member, m.addedAt));
	}
	if (live.size === 0) return false;
	// The date on a removal is where the removed member's tenure ENDS: what she
	// signed before it stays honoured (the people she removed stay removed),
	// what she signs after it is nothing. So it must not fall before acts of
	// hers this device has already seen merely because her clock ran ahead of
	// ours - but only within a bounded skew, or a member could post-date one
	// statement and keep her authority alive past any removal.
	const since = standing.owners.get(revokedBy);
	const lastAct = standing.lastActOf(opts.member);
	const revokedAt = Math.max(
		opts.now,
		since !== undefined && Number.isFinite(since) ? since : opts.now,
		lastAct === null ? opts.now : Math.min(lastAct + 1, opts.now + MAX_CLOCK_SKEW_MS),
	);
	const array = readAccessArray(doc);
	if (!array) return false;
	let revoked = false;
	doc.transact(() => {
		for (const entry of array.toArray()) {
			if (!(entry instanceof Y.Map)) continue;
			const grant = grantOf(entry as Y.Map<unknown>);
			if (!grant || !live.has(targetKey(grant.member, grant.addedAt))) continue;
			const sig = signPayload(
				opts.signerSecret,
				revokePayload(opts.entityId, grant.member, grant.addedAt, revokedAt, revokedBy),
			);
			writeRevoke(entry as Y.Map<unknown>, {
				member: grant.member,
				addedAt: grant.addedAt,
				revokedAt,
				revokedBy,
				revokeSig: bytesToBase64(sig),
			});
			revoked = true;
		}
	});
	return revoked;
}

/** Write back every remembered statement the doc no longer shows — a grant
 *  whose entry was deleted, a revoke that was overwritten or blanked. Returns
 *  true when it changed the doc. Idempotent; a duplicate entry is harmless
 *  because readers key on the statement, not the slot. */
export function repairAccessRecord(doc: Y.Doc, entityId: string, trust: AccessTrust): boolean {
	const memory = trust.memory;
	if (!memory || (memory.grants.length === 0 && memory.revokes.length === 0)) return false;
	const inDoc = collectStatements(doc, entityId);
	const docGrants = new Set(inDoc.grants.map(grantKey));
	const docRevokes = new Set(inDoc.revokes.map(revokeKey));
	const missingGrants = memory.grants.filter((g) => !docGrants.has(grantKey(g)));
	const missingRevokes = memory.revokes.filter((r) => !docRevokes.has(revokeKey(r)));
	if (missingGrants.length === 0 && missingRevokes.length === 0) return false;
	const revokeFor = new Map<string, RevokeStatement>();
	for (const r of missingRevokes) revokeFor.set(targetKey(r.member, r.addedAt), r);
	const arr = getAccessArray(doc);
	doc.transact(() => {
		const placed = new Set<string>();
		for (const entry of arr.toArray()) {
			if (!(entry instanceof Y.Map)) continue;
			const grant = grantOf(entry);
			if (!grant) continue;
			const key = targetKey(grant.member, grant.addedAt);
			const revoke = revokeFor.get(key);
			if (!revoke) continue;
			writeRevoke(entry, revoke);
			placed.add(key);
		}
		for (const grant of missingGrants) {
			const key = targetKey(grant.member, grant.addedAt);
			arr.push([entryFor(grant, revokeFor.get(key) ?? null)]);
			placed.add(key);
		}
		// A revoke whose grant is in neither place still has to travel: carry it on
		// a copy of the grant it cancels, if memory holds one.
		for (const [key, revoke] of revokeFor) {
			if (placed.has(key)) continue;
			const grant = memory.grants.find((g) => targetKey(g.member, g.addedAt) === key);
			if (grant) arr.push([entryFor(grant, revoke)]);
		}
	});
	return true;
}

/** Resolve the access log into one row per distinct signed grant (the audit
 *  history, revoked ones included), each judged by the policy under `trust`.
 *  A grant whose signature fails — a tampered field, a record copied from
 *  another entity — is not a statement at all and does not appear. Doc order,
 *  then anything only this device's memory still holds. */
export function resolveMembers(doc: Y.Doc, entityId: string, trust: AccessTrust): ResolvedMember[] {
	return evaluate(doc, entityId, trust).rows;
}

/** Collapse the per-grant audit log to ONE row per member — the member's CURRENT
 *  status (F-287: a consumer doing `find(member)` on the audit list hits a stale
 *  revoked row first). An active grant wins over an inactive one; an authorized
 *  one over an unauthorized one; among active grants the most privileged; then
 *  the latest-granted; then a fixed tiebreak so every replica picks the same
 *  row. First-seen member order is preserved. */
export function resolveCurrentMembers(
	doc: Y.Doc,
	entityId: string,
	trust: AccessTrust,
): ResolvedMember[] {
	const byMember = new Map<string, ResolvedMember>();
	for (const m of evaluate(doc, entityId, trust).rows) {
		const prev = byMember.get(m.member);
		if (!prev || prefer(m, prev)) byMember.set(m.member, m);
	}
	return [...byMember.values()];
}

function prefer(next: ResolvedMember, prev: ResolvedMember): boolean {
	if (next.active !== prev.active) return next.active;
	// An entry signed without authority never represents the member while one
	// signed with it exists — otherwise a forged later entry would displace the
	// real (revoked) row from the member list.
	if (next.authorized !== prev.authorized) return next.authorized;
	if (next.active && next.role !== prev.role) return ROLE_RANK[next.role] > ROLE_RANK[prev.role];
	if (next.addedAt !== prev.addedAt) return next.addedAt > prev.addedAt;
	return next.addedBy > prev.addedBy;
}

/** Currently-active members, one row each. */
export function activeMembers(doc: Y.Doc, entityId: string, trust: AccessTrust): ResolvedMember[] {
	return resolveCurrentMembers(doc, entityId, trust).filter((m) => m.active);
}

/** Shared ⇔ more than one active member. */
export function isSharedRecord(doc: Y.Doc, entityId: string, trust: AccessTrust): boolean {
	return activeMembers(doc, entityId, trust).length > 1;
}

/** May `signerB64` issue a grant on `entityId`? Only a current owner may, and
 *  Owner is the top role, so an owner may grant any role. */
export function mayGrant(
	doc: Y.Doc,
	entityId: string,
	signerB64: string,
	trust: AccessTrust,
): boolean {
	return evaluate(doc, entityId, trust).owners.has(signerB64);
}

/** Would a revoke of `memberB64` signed by `signerB64` have effect? The root can
 *  never be revoked; a co-owner only by the root or by themselves; anyone else
 *  by a current owner or by themselves (leaving). */
export function mayRevoke(
	doc: Y.Doc,
	entityId: string,
	signerB64: string,
	memberB64: string,
	trust: AccessTrust,
): boolean {
	if (memberB64 === trust.root) return false;
	const { rows, owners } = evaluate(doc, entityId, trust);
	return rows.some(
		(m) =>
			m.active &&
			m.member === memberB64 &&
			(signerB64 === memberB64 ||
				(m.role === AccessRole.Owner ? signerB64 === trust.root : owners.has(signerB64))),
	);
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
export function isAuthorizedWriter(
	doc: Y.Doc,
	entityId: string,
	senderKey: Uint8Array,
	trust: AccessTrust,
): boolean {
	for (const m of activeMembers(doc, entityId, trust)) {
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

/** How far ahead of this device's clock another member's signed timestamp may
 *  run and still be accommodated when dating a removal (see `revokeAccess`). */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

/** Ceiling on the state a share BOOTSTRAP may carry (see below). Deliberately
 *  generous against a real opening snapshot and still far under anything that
 *  could stall the main process. */
export const MAX_BOOTSTRAP_STATE_BYTES = 4 * 1024 * 1024;

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
 * May `senderKey` write to `entityId` on the strength of the state they are
 * sending, when this device holds no record yet? The FIRST state frame of a new
 * share carries the access record that authorizes it, so a receiver whose local
 * doc is still empty has nothing to check {@link isAuthorizedWriter} against
 * (dogfood collab `009`: a permanent deadlock, not a conservative denial).
 *
 * The offered record is judged by the same owner-rooted policy as any other,
 * with the root taken on first sight from the record itself
 * ({@link deriveAccessRoot}, with the authenticated sender as the hint). It
 * stays fail-closed:
 *
 *   - it applies ONLY when the local doc carries NO access entries at all - a
 *     doc that already holds a record is authoritative, so a later frame can
 *     never re-bootstrap around a revoke;
 *   - the incoming state is merged into a THROWAWAY doc, never the real one, so
 *     a rejected bootstrap leaves nothing behind;
 *   - the sender must resolve to an ACTIVE Editor-or-Owner member in that
 *     state; anything else (including a malformed update) denies.
 */
export function authorizesAsShareBootstrap(
	localDoc: Y.Doc,
	entityId: string,
	senderKey: Uint8Array,
	incomingState: Uint8Array,
): boolean {
	// The real apply of a remote update is delegated to the ydoc WORKER; this
	// probe decodes the same attacker-supplied bytes on the main process, so it
	// gets an explicit ceiling that the worker path does not need.
	if (incomingState.byteLength > MAX_BOOTSTRAP_STATE_BYTES) return false;
	if (hasAccessEntries(localDoc)) return false;
	const probe = new Y.Doc();
	try {
		Y.applyUpdate(probe, incomingState);
		const trust = docTrust(probe, entityId, { sender: bytesToBase64(senderKey) });
		return isAuthorizedWriter(probe, entityId, senderKey, trust);
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
export function isActiveMember(
	doc: Y.Doc,
	entityId: string,
	memberB64: string,
	trust: AccessTrust,
): boolean {
	return activeMembers(doc, entityId, trust).some((m) => m.member === memberB64);
}

/** The active role for `memberB64`, or null if not an active member. Two live
 *  grants (a concurrent grant before a revoke) resolve to the most privileged —
 *  least-surprise for the holder, and a revoke can always demote. */
export function roleOf(
	doc: Y.Doc,
	entityId: string,
	memberB64: string,
	trust: AccessTrust,
): AccessRole | null {
	return activeMembers(doc, entityId, trust).find((m) => m.member === memberB64)?.role ?? null;
}
