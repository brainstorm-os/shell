import { track } from "@brainstorm-os/sdk/analytics";
import { useEffect, useRef } from "react";
import { useVault } from "../vault-context";

/** Observes shell routing + vault lifecycle and emits Amplitude events. */
export function ShellTracking() {
	const { loading, current } = useVault();
	const lastVaultId = useRef<string | null>(null);

	useEffect(() => {
		if (loading) return;
		if (current) {
			if (lastVaultId.current !== current.id) {
				// Event name only — never send vault / identity ids to analytics.
				track("Vault Opened");
				lastVaultId.current = current.id;
			}
			return;
		}
		if (lastVaultId.current) {
			track("Vault Closed");
			lastVaultId.current = null;
		}
		track("Welcome Viewed");
	}, [loading, current]);

	return null;
}
