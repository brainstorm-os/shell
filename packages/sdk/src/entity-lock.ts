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
