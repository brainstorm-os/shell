/**
 * Member-wraps schema (Stage 10.2) — the per-recipient HPKE-sealed copy of
 * an entity's DEK, stored inside the entity's Yjs doc and replicated to
 * paired devices through the blind relay.
 *
 * Per §3.2:
 *
 *   "Inside the entity's Y.Doc, at root.meta.wraps = Y.Array<WrapPayload>.
 *    Each WrapPayload is {recipientPub, nonce, ciphertext, senderX25519Pub}.
 *    Plaintext serialised JSON — the surrounding Y.Doc is encrypted before
 *    it leaves the device, so the wraps are still ciphertext-on-the-wire."
 *
 * Stage 10.2 ships the schema + codec + HPKE primitives. The wire-side
 * use (encrypted Yjs envelopes that pull the DEK out of a wrap) lands in
 * 10.3, mirroring how 10.1 shipped `EntityDekStore` ahead of its 10.3
 * wire-path consumer.
 *
 * AAD binds each wrap to (a) this scheme version and (b) this specific
 * entity id, so a wrap stolen from entity X cannot be replayed against
 * entity Y. The HPKE `info` value pins the binding name + version into
 * the key schedule so a future "block-DEK wrap" or "attachment-DEK wrap"
 * (different bindings, same suite) cannot cross-confuse.
 *
 * v1 single-device: each entity has exactly one wrap (this device's). When
 * Stage 10.5 (pairing UX) lands, each paired device gets its own wrap and
 * the wraps Y.Array has |devices| entries — the schema is unchanged.
 */

import * as Y from "yjs";
import { base64ToBytes, bytesToBase64 } from "./crypto";
import { openBase, sealBase } from "./hpke";

/** Schema version stamped into every wrap. Bump only on a wire-incompatible
 *  change to the wrap payload or the AAD construction.
 *
 *  - `1` — bare `{recipient, enc, ct}`; AAD = prefix‖entityId. (pre-ROT-3a-i)
 *  - `2` — adds `version` (the DEK's monotonic rotation ordinal) and BINDS it
 *    into the AAD, so the ordinal is authenticated: a relay that replays or
 *    re-labels an old wrap can't forge a higher ordinal without failing AEAD.
 *    This is what makes rotate-on-revoke's accept-strictly-newer install path
 *    rollback-safe. v1 wraps are still readable (unwrap dispatches on `v`).
 */
export const MEMBER_WRAP_VERSION = 2 as const;

/** Schema versions this codec can READ. Writes are always the latest. */
export type MemberWrapSchemaVersion = 1 | 2;

/** The DEK rotation ordinal a wrap conveys — `version` on v2+, else 1 (a v1
 *  wrap predates rotation, so it is the entity's first DEK by definition).
 *  This is the value the install path compares for anti-rollback. */
export function wrapDekVersionOf(wrap: MemberWrapPayload): number {
	return wrap.version ?? 1;
}

/** Algorithm identifier — pins the HPKE suite at the schema layer so a
 *  future codec can detect (and refuse) a wrap minted under a different
 *  suite. The HPKE module owns the actual suite ids; this string is the
 *  human-readable mirror that lives on disk. */
export const MEMBER_WRAP_ALG = "hpke-x25519-hkdf-sha256-chacha20poly1305-v1" as const;

/** Top-level Yjs key for the per-entity meta map. Prefixed to avoid
 *  collision with app-side top-level types (Lexical uses `root`,
 *  CodeMirror its own, etc.). */
export const ENTITY_META_TOP = "brainstorm.meta" as const;

/** Key within the entity meta map for the wraps array. */
export const ENTITY_WRAPS_KEY = "wraps" as const;

/** Domain-separated AAD prefix — bound into every wrap's AEAD AAD so a
 *  wrap minted for entity X cannot be replayed against entity Y. Mirrors
 *  the `ENTITY_DEK_AAD_PREFIX` pattern from entity-dek-store.ts; that one
 *  binds at-rest DEK seals, this one binds on-doc DEK wraps. */
const MEMBER_WRAP_AAD_PREFIX = "brainstorm/entity-wrap/v1:";

/** HPKE `info` value — pins the binding name + version into the key
 *  schedule. Constant across entities (the per-entity binding lives in
 *  the AAD). Future wrap bindings (block, attachment) use a different
 *  info string under the same suite, so the derived key cannot collide. */
const MEMBER_WRAP_INFO = new TextEncoder().encode("brainstorm/entity-wrap/v1");

/** JSON-serialisable on-doc shape of one member wrap. Stored as a plain
 *  object inside a Y.Array so it replicates as part of the entity's doc
 *  state (no nested Y types needed — the wrap is opaque ciphertext that
 *  never edits in place; a rotation appends a new wrap and revokes the
 *  old). */
export type MemberWrapPayload = {
	v: MemberWrapSchemaVersion;
	alg: typeof MEMBER_WRAP_ALG;
	/** Recipient device X25519 pubkey (base64, 32 bytes). The wire-side
	 *  unwrap path resolves this against the local device pubkey to find
	 *  the entry it can open. */
	recipientPubB64: string;
	/** HPKE encapsulation — the ephemeral sender X25519 pubkey (base64,
	 *  32 bytes). Per-call fresh; gives the wrap forward secrecy at the
	 *  sender side (compromise of one wrap's ephemeral key does not
	 *  affect any other wrap). */
	encB64: string;
	/** AEAD ciphertext of the 32-byte DEK with the Poly1305 tag appended
	 *  (base64, 48 bytes). AAD is the entity-bound prefix; see
	 *  `entityWrapAad`. */
	ctB64: string;
	/** The DEK's monotonic rotation ordinal (v2+). AAD-bound, so it can't be
	 *  tampered without breaking the AEAD tag. Absent on a v1 wrap (⇒ ordinal
	 *  1). Read it via {@link wrapDekVersionOf}, never `wrap.version` directly. */
	version?: number;
};

export function isMemberWrapPayload(value: unknown): value is MemberWrapPayload {
	if (!value || typeof value !== "object") return false;
	const w = value as Partial<MemberWrapPayload>;
	const baseOk =
		w.alg === MEMBER_WRAP_ALG &&
		typeof w.recipientPubB64 === "string" &&
		typeof w.encB64 === "string" &&
		typeof w.ctB64 === "string";
	if (!baseOk) return false;
	if (w.v === 1) return w.version === undefined;
	if (w.v === 2)
		return typeof w.version === "number" && Number.isInteger(w.version) && w.version >= 1;
	return false;
}

/** Get-or-create the per-entity meta Y.Map. Top-level types are
 *  idempotent in Yjs, so concurrent callers receive the same instance. */
export function getEntityMetaMap(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap<unknown>(ENTITY_META_TOP);
}

/** Get-or-create the wraps Y.Array nested under `meta`. The first call
 *  on a fresh doc installs an empty array inside a single transaction so
 *  the install is one undo step (and propagates as one Yjs update). */
export function getWrapsArray(doc: Y.Doc): Y.Array<MemberWrapPayload> {
	const meta = getEntityMetaMap(doc);
	const existing = meta.get(ENTITY_WRAPS_KEY);
	if (existing instanceof Y.Array) return existing as Y.Array<MemberWrapPayload>;
	const fresh = new Y.Array<MemberWrapPayload>();
	doc.transact(() => {
		// Re-check inside the transaction — a concurrent installer in the
		// same tick would otherwise lose its entries.
		if (!(meta.get(ENTITY_WRAPS_KEY) instanceof Y.Array)) {
			meta.set(ENTITY_WRAPS_KEY, fresh);
		}
	});
	const after = meta.get(ENTITY_WRAPS_KEY);
	return after as Y.Array<MemberWrapPayload>;
}

/** Read every wrap on the doc. Order matches the Y.Array order; callers
 *  that want a per-recipient lookup should use `findWrapForRecipient`. */
export function listWraps(doc: Y.Doc): MemberWrapPayload[] {
	const arr = getWrapsArray(doc);
	const out: MemberWrapPayload[] = [];
	for (const item of arr) if (isMemberWrapPayload(item)) out.push(item);
	return out;
}

/** Find a wrap addressed to `recipientPub`. Returns null if no entry
 *  matches — the caller's device hasn't been added to this entity yet. */
export function findWrapForRecipient(
	doc: Y.Doc,
	recipientPub: Uint8Array,
): MemberWrapPayload | null {
	const target = bytesToBase64(recipientPub);
	for (const w of listWraps(doc)) {
		if (w.recipientPubB64 === target) return w;
	}
	return null;
}

/** Append a wrap to the doc's wraps array, in one Yjs transaction. The
 *  caller is responsible for producing the wrap with `wrapDekForRecipient`
 *  (or any RFC 9180-compliant equivalent under the same suite). */
export function appendWrap(doc: Y.Doc, wrap: MemberWrapPayload): void {
	const arr = getWrapsArray(doc);
	doc.transact(() => {
		arr.push([wrap]);
	});
}

/**
 * HPKE-wrap a 32-byte DEK for `recipientPub`, bound to `entityId`. The
 * returned payload is JSON-ready and can be appended to the doc with
 * `appendWrap`.
 *
 * AAD = `brainstorm/entity-wrap/v1:` || UTF-8(entityId) — domain-separated
 * prefix + entity instance binding, mirroring the entity-dek AAD pattern.
 * HPKE `info` = `brainstorm/entity-wrap/v1` (binding name + version, no
 * per-call data) so the key schedule is pinned but the AAD is the per-call
 * binding.
 *
 * **Stage 10.14 — optional `type`.** A cold/restoring device recovers a DEK
 * from this wrap (the durable node serves wraps first in backfill), but the
 * entity's reverse-DNS `type` lives only in the `entities.db` row — not in the
 * Yjs doc, and never on the relay-blind wire. So the type is sealed *inside*
 * the HPKE ciphertext here, as a framed `[typeLen:1][typeUtf8][dek:32]`
 * plaintext, keeping it confidential from the node while letting the restoring
 * device materialize the row. Omitting `type` seals the bare 32-byte DEK (the
 * pre-10.14 layout) — the unwrap path disambiguates by plaintext length.
 */
export function wrapDekForRecipient(
	dek: Uint8Array,
	recipientPub: Uint8Array,
	entityId: string,
	type?: string,
	version?: number,
): MemberWrapPayload {
	assertDek(dek);
	assertNonEmptyEntityId(entityId);
	if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
		throw new Error("wrapDekForRecipient: version must be a positive integer");
	}
	const framed = type ? frameTypeAndDek(type, dek) : null;
	const plaintext = framed ?? dek;
	try {
		const sealed = sealBase(
			recipientPub,
			MEMBER_WRAP_INFO,
			entityWrapAad(entityId, version),
			plaintext,
		);
		const base = {
			alg: MEMBER_WRAP_ALG,
			recipientPubB64: bytesToBase64(recipientPub),
			encB64: bytesToBase64(sealed.enc),
			ctB64: bytesToBase64(sealed.ct),
		} as const;
		// v1 (no ordinal) stays wire-identical for existing shared entities; a
		// caller that passes `version` opts into the AAD-authenticated v2 form.
		return version === undefined ? { v: 1, ...base } : { v: 2, version, ...base };
	} finally {
		framed?.fill(0); // the framed copy held the DEK bytes
	}
}

/**
 * Unwrap a member wrap with `recipientSecret`, returning ONLY the 32-byte DEK
 * (the recovered `type`, if any, is discarded — see
 * `unwrapDekAndTypeForRecipient` for the restore path). Throws on:
 *   - Schema mismatch (wrong `v` or `alg`)
 *   - AAD mismatch (wrap was bound to a different entity id)
 *   - Recipient mismatch (the wrap isn't addressed to this device's key)
 *   - Tampered ciphertext (Poly1305 auth tag fails)
 *
 * The caller MUST zero the returned DEK when finished — this module does not
 * retain a reference.
 */
export function unwrapDekForRecipient(
	wrap: MemberWrapPayload,
	recipientSecret: Uint8Array,
	entityId: string,
): Uint8Array {
	return unwrapDekAndTypeForRecipient(wrap, recipientSecret, entityId).dek;
}

/**
 * Stage 10.14 — unwrap a member wrap, recovering BOTH the 32-byte DEK and the
 * entity `type` sealed alongside it. `type` is `null` for a pre-10.14 wrap that
 * sealed the bare DEK. The caller MUST zero the returned `dek`.
 */
export function unwrapDekAndTypeForRecipient(
	wrap: MemberWrapPayload,
	recipientSecret: Uint8Array,
	entityId: string,
): { dek: Uint8Array; type: string | null } {
	if (!isMemberWrapPayload(wrap)) {
		throw new Error("unwrapDekForRecipient: invalid MemberWrapPayload");
	}
	assertNonEmptyEntityId(entityId);
	const enc = base64ToBytes(wrap.encB64);
	const ct = base64ToBytes(wrap.ctB64);
	// A v2 wrap binds its `version` into the AAD; opening reconstructs the same
	// AAD from the (declared) version, so a tampered ordinal fails the AEAD tag.
	const aad = wrap.v === 2 ? entityWrapAad(entityId, wrap.version) : entityWrapAad(entityId);
	const plaintext = openBase(enc, recipientSecret, MEMBER_WRAP_INFO, aad, ct);
	return deframeTypeAndDek(plaintext);
}

/** Canonical wrap AAD for `entityId`, optionally binding the DEK rotation
 *  `version` (v2 wraps). Centralised so seal + open paths cannot drift. The
 *  no-version form is the v1 AAD — unchanged, so existing v1 wraps still open.
 *  Changing either form invalidates the corresponding wraps in existence. */
function entityWrapAad(entityId: string, version?: number): Uint8Array {
	const suffix = version === undefined ? "" : `:dekv:${version}`;
	return new TextEncoder().encode(MEMBER_WRAP_AAD_PREFIX + entityId + suffix);
}

/** Frame an entity `type` ahead of the DEK as `[typeLen:1][typeUtf8][dek:32]`
 *  (Stage 10.14). A 1-byte length suffices — entity types are short reverse-DNS
 *  strings. The framed length is always ≥ 34 (a non-empty type), so it never
 *  collides with the bare 32-byte (no-type) layout. The caller zeroes the
 *  returned buffer (it holds the DEK). */
function frameTypeAndDek(type: string, dek: Uint8Array): Uint8Array {
	const typeBytes = new TextEncoder().encode(type);
	if (typeBytes.length > 255) {
		throw new Error("member-wraps: type too long to frame (max 255 bytes)");
	}
	const out = new Uint8Array(1 + typeBytes.length + 32);
	out[0] = typeBytes.length;
	out.set(typeBytes, 1);
	out.set(dek, 1 + typeBytes.length);
	return out;
}

/** Inverse of {@link frameTypeAndDek}. A bare 32-byte plaintext is a pre-10.14
 *  wrap (`type: null`); otherwise split the frame. Returns a fresh DEK copy and
 *  zeroes the framed source buffer. Throws on a malformed frame. */
function deframeTypeAndDek(plaintext: Uint8Array): { dek: Uint8Array; type: string | null } {
	if (plaintext.length === 32) {
		return { dek: plaintext, type: null };
	}
	const typeLen = plaintext[0] ?? 0;
	if (plaintext.length !== 1 + typeLen + 32) {
		plaintext.fill(0);
		throw new Error("member-wraps: malformed wrap plaintext");
	}
	const type = new TextDecoder().decode(plaintext.subarray(1, 1 + typeLen));
	const dek = plaintext.slice(1 + typeLen);
	plaintext.fill(0);
	return { dek, type };
}

function assertDek(dek: Uint8Array): void {
	if (!(dek instanceof Uint8Array) || dek.length !== 32) {
		throw new Error("wrapDekForRecipient: dek must be a 32-byte Uint8Array");
	}
}

function assertNonEmptyEntityId(entityId: string): void {
	if (entityId === "") throw new Error("member-wraps: entityId must be non-empty");
}
