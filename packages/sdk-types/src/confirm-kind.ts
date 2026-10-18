/**
 * Confirmation prompt kinds + the remember-my-choice policy (6.15).
 *
 * A destructive prompt may offer "Don't ask again" only when the action it
 * guards can be undone. That is a property of the prompt KIND, declared once
 * here, never a flag a call site passes — so an irreversible prompt (emptying
 * the Bin, purging from it, deleting a vault, removing a key or credential)
 * cannot grow a skip checkbox by accident, and the shell's settings service
 * refuses to store a skip for one even if asked directly.
 *
 * Remembered choices are per vault, per device (the `settings` store), keyed
 * `confirmSkipKey(kind)` in the asking app's own namespace; Settings →
 * Interface → "Reset confirmations" clears every app's.
 */

export enum ConfirmReversibility {
	/** The action can be undone (e.g. restored from the Bin). */
	Reversible = "reversible",
	/** The action destroys data or keys for good. */
	Irreversible = "irreversible",
}

export enum ConfirmKind {
	MoveToBin = "move-to-bin",
	EmptyBin = "empty-bin",
	PurgeFromBin = "purge-from-bin",
	DeleteVault = "delete-vault",
	RemoveCredential = "remove-credential",
}

export const CONFIRM_KIND_REVERSIBILITY: Readonly<Record<ConfirmKind, ConfirmReversibility>> =
	Object.freeze({
		[ConfirmKind.MoveToBin]: ConfirmReversibility.Reversible,
		[ConfirmKind.EmptyBin]: ConfirmReversibility.Irreversible,
		[ConfirmKind.PurgeFromBin]: ConfirmReversibility.Irreversible,
		[ConfirmKind.DeleteVault]: ConfirmReversibility.Irreversible,
		[ConfirmKind.RemoveCredential]: ConfirmReversibility.Irreversible,
	});

export function isConfirmKind(value: unknown): value is ConfirmKind {
	return typeof value === "string" && (Object.values(ConfirmKind) as string[]).includes(value);
}

/** True only for a known, reversible kind — the single gate every surface
 *  (shell dialog, SDK helper, settings service) asks before offering or
 *  storing a skip. Unknown values are refused. */
export function canRememberConfirm(kind: unknown): kind is ConfirmKind {
	return isConfirmKind(kind) && CONFIRM_KIND_REVERSIBILITY[kind] === ConfirmReversibility.Reversible;
}

/** Reserved `settings` key prefix for remembered confirmation skips. */
export const CONFIRM_SKIP_KEY_PREFIX = "bs.confirm-skip/";

export function confirmSkipKey(kind: ConfirmKind): string {
	return `${CONFIRM_SKIP_KEY_PREFIX}${kind}`;
}

/** The kind a reserved skip key names, `null` for any other key (and for a
 *  reserved-prefix key naming no known kind). */
export function confirmKindFromSkipKey(key: string): ConfirmKind | null {
	if (!key.startsWith(CONFIRM_SKIP_KEY_PREFIX)) return null;
	const kind = key.slice(CONFIRM_SKIP_KEY_PREFIX.length);
	return isConfirmKind(kind) ? kind : null;
}
