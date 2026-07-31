/**
 * Stage 10.x — retro-wrap pass for legacy null-DEK rows.
 *
 * Stage 10.1 added a per-entity DEK on `entities.create` via the IPC
 * service; shell-internal singletons (`ensureRootFolder`,
 * `bindings-entity`, dev-seed `repo.create`)
 * still pass `dekId: null` because they pre-date the entity-session DEK
 * machinery (and in some cases run during boot, before the
 * `entityDekStore` is constructed). The pre-10.1 vault snapshot also
 * contains rows with no wrap.
 *
 * Stage 10.3 (sync wire path) will encrypt every Yjs update envelope
 * under the per-entity DEK. A null-DEK row at that point is ambiguous:
 * either the wire path silently skips it (rows go un-replicated, the
 * partial-state bug) or it leaks the plaintext bytes to the relay (data
 * leak). The de-risk review
 * picked the only safe answer — **every live entity must carry a DEK
 * before 10.3 ships**.
 *
 * This module is that drain. On vault open (after the singleton-creators
 * have had their pass), for every live row whose `dek_id IS NULL`:
 *
 *   1. Reserve a fresh `dekId` (no I/O).
 *   2. Inside one SQLite transaction against `entities.db`:
 *      - `repo.stampDekId(id, dekId)` — UPDATE entities, guarded by
 *        `dek_id IS NULL` so a concurrent writer can't be clobbered.
 *      - `dekStore.persist(entityId, dekId)` — generates the DEK,
 *        seals it under the vault master key (AAD-bound to the entity
 *        id, same shape as 10.1), writes `entity_deks` row.
 *      - Zero the live DEK buffer immediately — the wire path will
 *        re-`open()` it from the wrap row on demand.
 *
 * The pass is **idempotent** by construction: the next call sees no
 * `dek_id IS NULL` rows (so `wrapped=0`). No marker / generation
 * counter is needed — the schema is the marker.
 *
 * **Per-row isolation**: any throw during one row's transaction rolls
 * back that row only (the entity_deks insert + the entities stamp
 * unwind together) and is logged + counted in `skipped`; the rest of
 * the pass continues. A vault with one corrupt row never blocks the
 * other 9999.
 *
 * **Why a separate pass, not a fix to each call site?** Two reasons:
 * (1) the singleton creators are scattered across `vault/session.ts`,
 * `shortcuts/bindings-entity.ts`, and `dev/seed-demo-entities.ts` —
 * making each one DEK-aware would
 * thread the `entityDekStore` through every boot path (vault open
 * sequence + dev seeder), and several of those run before
 * `entityDekStore()` is even constructable. (2) Pre-10.1 snapshots
 * on disk *exist* (the user's running dev vault has them right now).
 * A pass on open handles both forward and backward — and disappears
 * silently once the schema is empty.
 */

import type { EntitiesRepository } from "../storage/entities-repo";
import { isSafeEntityId } from "../storage/entity-id";
import type { EntityDekStore } from "./entity-dek-store";

export type RetroWrapResult = {
	/** Entities that received a fresh DEK wrap row this pass. */
	wrapped: number;
	/** Rows the pass tried to wrap but failed (per-row error logged;
	 *  the pass continued). */
	skipped: number;
};

export type RetroWrapOptions = {
	repo: EntitiesRepository;
	dekStore: EntityDekStore;
	/** Stage 10.3a — install the per-device member wrap on the entity's
	 *  Y.Doc once the DEK row is persisted. Optional so legacy test paths
	 *  that don't need wrap installation keep working; production wires
	 *  this at vault open so the retro-drain covers wraps in the same
	 *  pass it covers DEK rows. */
	installEntityWrap?: (entityId: string, dek: Uint8Array, type?: string) => Promise<void>;
};

/**
 * Drain every live entity with `dek_id IS NULL` by minting a wrap row.
 * Synchronous-by-construction (better-sqlite3 / bun:sqlite are sync,
 * `EntityDekStore.persist` is sync), exposed as `async` only to match
 * the surrounding boot orchestration (`onVaultOpened`). Returns the
 * per-pass tally — a boot log surfaces it.
 */
/** The rotation ordinal a retro-wrapped placeholder DEK is minted at. Below
 *  every genuine wrap (which start at 1), so an owner's first share always
 *  outranks it. See the note at the `persist` call. */
export const RETRO_WRAP_PLACEHOLDER_VERSION = 0;

export async function retroWrapNullDeks(opts: RetroWrapOptions): Promise<RetroWrapResult> {
	const { repo, dekStore, installEntityWrap } = opts;
	const result: RetroWrapResult = { wrapped: 0, skipped: 0 };

	let ids: string[];
	try {
		ids = repo.listMissingDekIds();
	} catch (error) {
		// A failed listing must not abort vault open — log + return zeros.
		console.warn(`[retro-wrap] list failed, skipping pass: ${(error as Error).message}`);
		return result;
	}

	// Shell-internal singletons (the bootstrapped root folder, id
	// `brainstorm/root-folder/v1`) carry non-safe entity ids. The sync wire
	// path rejects those at its trust boundary (`assertSafeEntityId`), so such
	// rows are local-only by construction and can neither need nor receive a
	// per-entity wrap. Drop them up front instead of attempting a wrap that
	// always throws `entityId must match …` on every boot.
	const syncableIds = ids.filter(isSafeEntityId);

	for (const id of syncableIds) {
		try {
			// Stage 10.3a — the Y.Doc wrap install is async (worker round-
			// trip) so it lives OUTSIDE the SQLite transaction. The DEK +
			// row stamp commit synchronously first; on a wrap-install
			// failure the row is hard-deleted to keep the schema in lock-
			// step. A stamped-but-unwrapped row would otherwise look
			// wrapped to the next pass and silently strand without the
			// wrap the wire path needs.
			let stampedHandle: { dekBytes: Uint8Array } | null = null;
			repo.transaction(() => {
				const dekId = dekStore.nextDekId();
				const stamped = repo.stampDekId(id, dekId);
				if (!stamped) {
					// `dek_id` is no longer NULL — a concurrent writer (the
					// entities IPC service in a parallel request) won the
					// race and stamped a real id. The row is wrapped
					// already; not an error, just nothing to do. Throw
					// `RetroWrapStampSkipped` to unwind without writing a
					// stale wrap row, and the outer catch counts it as
					// neither wrapped nor skipped (a concurrent success).
					throw new RetroWrapStampSkipped();
				}
				// F-472 — ordinal 0, deliberately BELOW every real wrap.
				//
				// This DEK is a placeholder: it exists so the wire path never sees a
				// null-DEK row, not because anyone agreed on it. `persist` would
				// otherwise mint ordinal 1, which is exactly what an owner's first
				// share carries, and `installEntityDek` accepts only a STRICTLY
				// newer ordinal — so the owner's wrap was rejected as a replay and
				// the receiver kept a key no one else held. The symptom was a row
				// that looked shared and could not decrypt a single frame from it
				// (`xchacha20poly1305: open failed`), permanently.
				//
				// Anti-rollback is untouched: real wraps still start at 1 and still
				// have to climb. Nothing can install ordinal 0 remotely.
				const handle = dekStore.persist(id, dekId, RETRO_WRAP_PLACEHOLDER_VERSION);
				stampedHandle = { dekBytes: handle.dek };
			});
			if (stampedHandle) {
				const liveDek = (stampedHandle as { dekBytes: Uint8Array }).dekBytes;
				try {
					if (installEntityWrap) await installEntityWrap(id, liveDek, repo.get(id)?.type);
				} catch (error) {
					// Retro-wrap is a forward-only repair; an install failure
					// MUST NOT delete an existing live entity row (the row
					// was authored by the user / shell long before this pass).
					// Surface the row as `skipped` so the next boot retries
					// — the `entity_deks` row stays stamped, so the next
					// pass starts from `stampDekId` returning false and
					// counts the row as a concurrent-stamp skip (the row IS
					// wrapped at the DEK layer; only the Y.Doc wrap is
					// missing, and a later wire-path call can repair).
					dekStore.close(liveDek);
					result.skipped += 1;
					console.warn(`[retro-wrap] entity ${id} wrap-install failed: ${(error as Error).message}`);
					continue;
				}
				dekStore.close(liveDek);
				result.wrapped += 1;
			}
		} catch (error) {
			if (error instanceof RetroWrapStampSkipped) {
				// Concurrent stamp got there first — neither wrapped nor
				// skipped, just a no-op from this pass's perspective.
				continue;
			}
			result.skipped += 1;
			console.warn(`[retro-wrap] entity ${id} failed: ${(error as Error).message}`);
		}
	}
	return result;
}

/**
 * Sentinel for "the stamp guard fired" — `dek_id` was no longer NULL
 * at the moment of UPDATE. Used to unwind the transaction without
 * counting the row as a failure. Internal; not exported.
 */
class RetroWrapStampSkipped extends Error {
	constructor() {
		super("dek_id stamp skipped (already non-null)");
		this.name = "RetroWrapStampSkipped";
	}
}
