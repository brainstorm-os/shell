import { useEffect, useRef } from "react";
import { track } from "@brainstorm/sdk/analytics";
import { useVault } from "../vault-context";

/** Observes shell routing + vault lifecycle and emits Amplitude events. */
export function ShellTracking() {
	const { loading, current } = useVault();
	const lastVaultId = useRef<string | null>(null);

	useEffect(() => {
		if (loading) return;
		if (current) {
			if (lastVaultId.current !== current.id) {
				track("Vault Opened", { vault_id: current.id });
				lastVaultId.current = current.id;
			}
			return;
		}
		if (lastVaultId.current) {
			track("Vault Closed", { vault_id: lastVaultId.current });
			lastVaultId.current = null;
		}
		track("Welcome Viewed");
	}, [loading, current]);

	return null;
}