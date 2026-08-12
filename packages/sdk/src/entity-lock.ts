/**
 * The one reading of the fleet's **read-only lock** (`properties.locked`).
 *
 * A locked object is read-only. The lock is a normal SYNCED entity property —
 * not per-device chrome — so locking on one device shows up on every device and
 * peer, and it is advisory rather than a permission: any collaborator who can
 * write the object can also unlock it. What it is NOT is decoration: the lock
 * has to hold on EVERY write path or it is a lie (the lesson `Lock-4` /
 * `Lock-5` and the shell's `tools.call` refusal already paid for).
 *
 * Before this module each app spelled the same check inline — `note.locked`,
 * `(row.properties as …).locked === true`, `readOnly` derived three ways — and
 * every new write path was one more chance to forget. One helper, one truth:
 * only the literal `true` locks, so a stray `"false"` / `0` / `null` from an
 * older codec can never read as locked, and a missing property reads unlocked.
 *
 * Pure — no DOM, no service, no React; safe in a worker, a canvas controller or
 * a pure-logic test.
 */

/** The entity property that carries the lock. Referenced by name everywhere so
 *  the key is greppable and a rename is one edit. */
export const LOCKED_PROPERTY_KEY = "locked";

/** Anything that carries a property bag: a live snapshot row, an
 *  `entities.get` result, a decoded app model. */
export type LockablePropertyBag = Readonly<Record<string, unknown>> | null | undefined;

/** Whether a raw property bag marks its object read-only. Only `true` locks. */
export function isLockedProperties(properties: LockablePropertyBag): boolean {
	return properties?.[LOCKED_PROPERTY_KEY] === true;
}

/** Whether an entity (a snapshot row / `entities.get` result) is read-only.
 *  A null / undefined entity is NOT locked — "I could not find it" is a
 *  different answer from "it is locked", and the caller that cares about the
 *  difference (a write gate) already has to handle the missing row. */
export function isEntityLocked(
	entity: { readonly properties?: LockablePropertyBag } | null | undefined,
): boolean {
	return isLockedProperties(entity?.properties);
}

/** The patch that flips an object's lock — the one spelling of the toggle a
 *  `<LockButton>` / object-menu Lock row persists through `entities.update`. */
export function lockTogglePatch(locked: boolean): { locked: boolean } {
	return { [LOCKED_PROPERTY_KEY]: !locked };
}

/** Whether a patch does NOTHING but flip the lock — the one write a locked
 *  object still takes (else a lock could never be undone).
 *
 *  Strictly lock-ONLY: the first spelling of this exemption asked "does the
 *  patch mention `locked`?", so a mixed `{ locked: false, name: "…" }` patch
 *  walked the whole write past the gate — one property key smuggling every
 *  other one through. A caller that genuinely wants to unlock AND edit issues
 *  two writes, in that order. */
export function isLockOnlyPatch(
	patch: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
	if (!patch) return false;
	const keys = Object.keys(patch);
	return keys.length === 1 && keys[0] === LOCKED_PROPERTY_KEY;
}

/** The one reading of "may this write land?", for every gated write path.
 *
 *  `patch` omitted means a NON-property write (delete, merge, destroy): a
 *  locked object refuses it outright — there is no lock-only exemption to
 *  earn, because there is no patch. */
export function lockRefusesWrite(
	locked: boolean,
	patch?: Readonly<Record<string, unknown>> | null,
): boolean {
	if (!locked) return false;
	return patch === undefined || patch === null || !isLockOnlyPatch(patch);
}

/** `lockRefusesWrite` for a write that touches SEVERAL objects — a merge
 *  (patches the survivor, bins the losers), a dedup pass, a multi-select
 *  action. ONE locked participant refuses the whole operation: a half-refused
 *  merge destroys some rows and keeps others, which is worse than no merge.
 *
 *  This is the shape every app was spelling for itself (`contactWriteRefused`
 *  was the first, Bookmarks had none at all and lost data for it), so it lives
 *  next to the single-object reading rather than once per app. */
export function anyLockRefusesWrite(
	isLocked: (id: string) => boolean,
	ids: readonly string[],
	patch?: Readonly<Record<string, unknown>> | null,
): boolean {
	return ids.some((id) => lockRefusesWrite(isLocked(id), patch));
}
