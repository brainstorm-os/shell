/**
 * EntityDekStore — per-entity Data Encryption Key management (Stage 10.1).
 *
 * Per §3.1 and
 *  §"Per-entity DEK":
 *
 *   - The DEK is generated locally on entity create (`generateSymmetricKey`
 *     → 32 random bytes; XChaCha20-Poly1305 256-bit per OQ-25).
 *   - The DEK is sealed under the vault master key (`sealSecret`,
 *     XChaCha20-Poly1305 with a per-call random 24-byte nonce) and
 *     persisted in `entity_deks`. AAD = a domain-separated tag
 *     (`brainstorm/entity-dek/v1:` || UTF-8(entityId)) so the wrap is
 *     bound to (a) this specific binding (per-entity DEK), (b) this
 *     scheme version, and (c) this specific entity id. Flipping
 *     `entity_deks.entity_id` for a stolen wrap row invalidates the
 *     AEAD tag on unwrap; future bindings that reuse XChaCha (e.g.
 *     block/attachment DEKs in later stages) won't cross-confuse.
 *   - The plaintext DEK never crosses IPC. Lifetime is open-entity-session;
 *     callers MUST `close(dek)` to zero the buffer.
 *
 * 10.1 ladder boundary: this store mints + persists DEKs; the unwrap path
 * exists (`open`) but is *unused by the wire path*. Stage 10.3 wires
 * encrypted Yjs update envelopes that pull the DEK from here. **Forward
 * contract for 10.3**: the wire path MUST recompute AAD from the resolved
 * row's `entity_id` (never the caller-supplied id) AND verify
 * `row.entity_id === requestedEntityId` before unwrap — otherwise a
 * `entities.dek_id` repoint attack reopens the swap risk this AAD closes.
 * The forward-pin test in `entity-dek-store.test.ts` documents this.
 */

import { randomUUID } from "node:crypto";
import { generateSymmetricKey, openSecret, sealSecret } from "../credentials/crypto";
import type { EntityDeksRepository } from "../storage/entities-repo";

/** A live entity-session DEK + its identifier. The caller MUST zero
 *  `dek` when it's no longer needed (via `EntityDekStore.close`); the
 *  store does not retain a reference. */
export type EntityDekHandle = {
	dekId: string;
	dek: Uint8Array;
	/** The DEK's monotonic rotation ordinal (1 for an entity's first DEK,
	 *  incremented on each rotate-on-revoke). Stamped into the member wrap so
	 *  the recipient's install path can order it (ROT-3a-i). */
	version: number;
};

/** Domain-separation prefix for the per-entity DEK AAD. Combined with the
 *  entity id, this defines the binding contract: changing it invalidates
 *  every wrap in existence, so version is encoded inline. */
const ENTITY_DEK_AAD_PREFIX = "brainstorm/entity-dek/v1:";

export class EntityDekStore {
	readonly #deks: EntityDeksRepository;
	readonly #masterKey: Uint8Array;
	readonly #clock: () => number;
	readonly #newDekId: () => string;

	constructor(
		deks: EntityDeksRepository,
		masterKey: Uint8Array,
		clock: () => number = () => Date.now(),
		newDekId: () => string = randomUUID,
	) {
		this.#deks = deks;
		this.#masterKey = masterKey;
		this.#clock = clock;
		this.#newDekId = newDekId;
	}

	/**
	 * Forward-allocate a dekId without producing the DEK or the wrap row.
	 * The entities service uses this to stamp `entities.dek_id` *before*
	 * the wrap row is written — the FK on `entity_deks.entity_id`
	 * (`REFERENCES entities(id)`) requires the parent to exist first, but
	 * we want the entity row to carry its eventual dek_id from the very
	 * first insert (no second UPDATE).
	 */
	nextDekId(): string {
		return this.#newDekId();
	}

	/**
	 * Mint a fresh 32-byte DEK, seal it under the vault master key
	 * (AAD-bound to `entityId` via the domain-separated prefix), and
	 * persist the wrap row in `entity_deks` under the pre-allocated
	 * `dekId`. The caller MUST `close(dek)` when finished. If the seal or
	 * the wrap-row INSERT throws, the freshly-minted DEK is zeroed before
	 * the throw propagates — no plaintext DEK survives a failed persist.
	 *
	 * **Ordering**: the parent `entities` row must already exist in
	 * `entities.db` before this call — `entity_deks.entity_id` is an
	 * FK with `ON DELETE CASCADE`. The entities service stamps the entity
	 * row first (carrying the `dek_id` minted via `nextDekId`) and then
	 * calls `persist`. For atomicity it wraps both writes in a single
	 * SQLite transaction; if `persist` throws, the entity-row INSERT
	 * rolls back so no orphan stays behind.
	 *
	 * 10.1 writes exactly one row per entity at create. Rotation (10.2)
	 * and the encrypted-update wire path (10.3) build on this primitive.
	 */
	persist(entityId: string, dekId: string): EntityDekHandle {
		assertNonEmptyEntityId(entityId);
		const dek = generateSymmetricKey();
		const version = this.#deks.maxVersionForEntity(entityId) + 1;
		try {
			const sealed = sealSecret(this.#masterKey, dek, entityIdAad(entityId));
			this.#deks.create({ dekId, entityId, version, sealedDek: sealed, now: this.#clock() });
			return { dekId, dek, version };
		} catch (error) {
			dek.fill(0);
			throw error;
		}
	}

	/**
	 * Persist a *caller-supplied* DEK under `dekId`. Used by the 10.9e soak
	 * harness — both shell instances need to install the same DEK bytes so
	 * they can decrypt each other's typed-update envelopes without the full
	 * wrap-bootstrap protocol round-trip (which is tested separately at
	 * `new-device-join.test.ts`). Production callers always go through
	 * `persist` to mint a fresh DEK — there is no other use case for
	 * forcing a known DEK.
	 *
	 * The caller is responsible for zeroing `dek` after the returned handle
	 * is closed. This method does NOT take ownership of the passed bytes.
	 *
	 * `version` is the DEK's rotation ordinal. On the survivor install path
	 * (ROT-3a-i) it MUST be the owner-assigned ordinal recovered from the
	 * (AAD-authenticated) wrap — never a locally-recomputed one — so a replayed
	 * old wrap can't masquerade as newest. Omitted ⇒ `maxVersion + 1` (the soak
	 * harness, which just needs monotonicity, not a specific ordinal).
	 */
	persistWithDek(
		entityId: string,
		dekId: string,
		dek: Uint8Array,
		version?: number,
	): EntityDekHandle {
		assertNonEmptyEntityId(entityId);
		if (!(dek instanceof Uint8Array) || dek.length !== 32) {
			throw new Error("EntityDekStore.persistWithDek: dek must be a 32-byte Uint8Array");
		}
		const ordinal = version ?? this.#deks.maxVersionForEntity(entityId) + 1;
		const copy = new Uint8Array(dek);
		try {
			const sealed = sealSecret(this.#masterKey, copy, entityIdAad(entityId));
			this.#deks.create({ dekId, entityId, version: ordinal, sealedDek: sealed, now: this.#clock() });
			return { dekId, dek: copy, version: ordinal };
		} catch (error) {
			copy.fill(0);
			throw error;
		}
	}

	/**
	 * Unwrap the persisted DEK for `entityId`. Returns null when no row
	 * exists (entities pre-10.1 / shell-internal singletons / legacy paths).
	 * Throws on:
	 *   - AAD mismatch (the wrap was bound to a different entity id —
	 *     defense vs. DEK-swap)
	 *   - master-key mismatch (different vault, or master rotated)
	 *   - tampered ciphertext (Poly1305 auth tag fails)
	 *
	 * No in-memory cache in 10.1 — every call re-unwraps from disk. The
	 * caller MUST `close(dek)` when finished. If a future caller adds work
	 * between unwrap and return, the plaintext is zeroed before any throw
	 * escapes.
	 */
	open(entityId: string): EntityDekHandle | null {
		assertNonEmptyEntityId(entityId);
		const row = this.#deks.getByEntityId(entityId);
		if (!row) return null;
		const dek = openSecret(this.#masterKey, row.sealedDek, entityIdAad(entityId));
		try {
			return { dekId: row.dekId, dek, version: row.version };
		} catch (error) {
			dek.fill(0);
			throw error;
		}
	}

	/** Zero a DEK buffer in place. Idempotent on an already-zeroed buffer. */
	close(dek: Uint8Array): void {
		dek.fill(0);
	}
}

/** Stable AAD for a per-entity DEK wrap: domain-separated prefix + UTF-8
 *  bytes of the entity id. Binds the sealed DEK to (a) this specific
 *  binding (per-entity DEK), (b) this scheme version (v1), and (c) this
 *  specific entity row. Centralised so the seal + open paths can't drift. */
function entityIdAad(entityId: string): Uint8Array {
	return new TextEncoder().encode(ENTITY_DEK_AAD_PREFIX + entityId);
}

function assertNonEmptyEntityId(entityId: string): void {
	if (entityId === "") throw new Error("EntityDekStore: entityId must be non-empty");
}
