/**
 * Vault corruption-recovery prompt (12.8, doc 28 §Recovery "Corrupted SQLite
 * file"). When `activate`/`recover` reports a corrupt domain DB the storage
 * layer won't auto-repair, the vault context raises a `recoveryPrompt`; this
 * surfaces an actionable modal instead of a dead-end error toast.
 *
 * The user has two honest paths (per the doc): restore the file from a backup
 * and reopen (Dismiss — no mutation), or let the shell archive the corrupt DB
 * aside and recreate it (Re-initialize for ledger/registry, Rebuild from
 * content for entities, which repopulates from the synced sources). The
 * recover path is destructive, so the keyboard contract fails safe exactly like
 * the capability prompt: NO global Enter-confirm, Escape/backdrop dismisses
 * (the safe action via Popover `onClose`), and initial focus lands on **Dismiss**
 * (`initialFocusRef`) — re-initializing requires deliberately activating it.
 *
 * Split into a pure presentational `<VaultRecoveryPrompt>` (so the copy +
 * fail-safe focus are unit-testable without the context) and a thin
 * `<VaultRecoveryPromptHost>` that wires it to `useVault`.
 */

import {
	VaultRecovery,
	corruptionMessage,
} from "@brainstorm-os/protocol/vault-recovery-wire-types";
import { AnimatePresence } from "framer-motion";
import { useRef } from "react";
import { t } from "../i18n/t";
import { Button, ButtonVariant } from "../ui/button";
import { Popover } from "../ui/popover";
import { PopoverSize } from "../ui/popover-types";
import type { VaultRecoveryPrompt as VaultRecoveryPromptData } from "../vault-context";
import { useVault } from "../vault-context";

export type VaultRecoveryPromptProps = {
	prompt: VaultRecoveryPromptData;
	onRecover: () => void;
	onDismiss: () => void;
};

export function VaultRecoveryPrompt({ prompt, onRecover, onDismiss }: VaultRecoveryPromptProps) {
	const dismissRef = useRef<HTMLButtonElement | null>(null);
	const recoverLabel =
		prompt.recovery === VaultRecovery.PromptRebuildFromSources
			? t("shell.vaultRecovery.rebuild")
			: t("shell.vaultRecovery.reinitialize");

	return (
		<Popover
			title={t("shell.vaultRecovery.title")}
			onClose={onDismiss}
			size={PopoverSize.Medium}
			initialFocusRef={dismissRef}
			testId="vault-recovery-prompt"
		>
			<p className="vault-recovery__message">{corruptionMessage(prompt.kind, prompt.recovery)}</p>
			<div className="vault-recovery__actions">
				<Button ref={dismissRef} onClick={onDismiss}>
					{t("shell.vaultRecovery.dismiss")}
				</Button>
				<Button variant={ButtonVariant.Destructive} onClick={onRecover}>
					{recoverLabel}
				</Button>
			</div>
		</Popover>
	);
}

export function VaultRecoveryPromptHost() {
	const { recoveryPrompt, recoverCorruption, dismissRecovery } = useVault();
	return (
		<AnimatePresence mode="wait">
			{recoveryPrompt && (
				<VaultRecoveryPrompt
					key={`${recoveryPrompt.id}:${recoveryPrompt.kind}`}
					prompt={recoveryPrompt}
					onRecover={() => {
						void recoverCorruption();
					}}
					onDismiss={dismissRecovery}
				/>
			)}
		</AnimatePresence>
	);
}
