/**
 * Renderer-safe wire mirror of the storage-layer corruption types
 * (`main/storage/recovery-plan.ts`), so the dashboard can react to a
 * corrupt-vault activate result WITHOUT importing main-only storage code (which
 * pulls `node:fs` / electron into the renderer bundle — see
 * `feedback_renderer_value_imports_from_preload`). Values are string-identical
 * to the main-side enums (`DataStoreKind`, `CorruptionRecovery`), so the IPC
 * handler casts across without a translation map; a test pins the parity.
 *
 * Iteration 12.8 (doc 28 §Recovery, "Corrupted SQLite file"): `vaults:activate`
 * resolves to `VaultActivateResult` instead of throwing on corruption, because
 * Electron IPC flattens a thrown Error to its `message` — the structured
 * `{ kind, recovery }` would be lost. Returning it lets the renderer surface an
 * honest, recovery-specific message instead of a cryptic toast.
 */

export enum VaultDbKind {
	Ledger = "ledger",
	Registry = "registry",
	Entities = "entities",
	Search = "search",
}

export enum VaultRecovery {
	/** Derived index — was auto-rebuilt by the storage layer; never reaches the
	 *  renderer as a failure (listed for parity with the main enum). */
	RebuildDerived = "rebuild-derived",
	/** Recoverable from synced CRDT content (the rebuild pass rides 9.3.5). */
	PromptRebuildFromSources = "prompt-rebuild-from-sources",
	/** Authoritative + irrecoverable — restore from backup or re-initialize. */
	PromptRestoreOrReinit = "prompt-restore-or-reinit",
}

export type VaultActivateResult =
	| { ok: true }
	| { ok: false; kind: VaultDbKind; recovery: VaultRecovery };

/**
 * Cross the string boundary from the main-side `DataStoreKind` / `CorruptionRecovery`
 * into these renderer enums. TS treats the two nominal enums as non-overlapping
 * even though their string values are identical (pinned by the parity test), so
 * the IPC handler converts through the shared string value here rather than a
 * smelly double-cast at the call site.
 */
export function toVaultDbKind(value: string): VaultDbKind {
	return value as VaultDbKind;
}

export function toVaultRecovery(value: string): VaultRecovery {
	return value as VaultRecovery;
}

/**
 * Honest, user-facing explanation for a corrupt-vault activate failure, keyed by
 * the recovery action. Pure (no React / no t()) so it's unit-testable; the
 * dashboard shows it in the existing error toast. The automated restore/re-init
 * actions are the filed follow-up — this copy tells the user the safe path now.
 */
export function corruptionMessage(kind: VaultDbKind, recovery: VaultRecovery): string {
	const file = `${kind}.db`;
	switch (recovery) {
		case VaultRecovery.PromptRestoreOrReinit:
			return `This vault's ${file} is corrupted and can't be repaired automatically. Restore it from a backup and reopen the vault, or re-initialize the vault to start fresh.`;
		case VaultRecovery.PromptRebuildFromSources:
			return `This vault's ${file} is corrupted. It can be rebuilt from your synced content, or restored from a backup — reopen the vault once you've restored, or re-initialize to start fresh.`;
		case VaultRecovery.RebuildDerived:
			// The derived index is auto-rebuilt before activate returns, so this
			// branch shouldn't surface — present an honest fallback regardless.
			return `This vault's ${file} was rebuilt after corruption; some cached data may take a moment to reappear.`;
	}
}
