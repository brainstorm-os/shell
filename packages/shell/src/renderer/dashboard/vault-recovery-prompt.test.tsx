/**
 * Vault corruption-recovery prompt (12.8) — SSR-smoke over the pure
 * `<VaultRecoveryPrompt>`: it renders the honest recovery copy, picks the
 * recover-action label by recovery kind, and offers the safe Dismiss action.
 * The fail-safe focus contract (initial focus on Dismiss, Escape dismisses) is
 * the shared <Popover>'s job, covered by `popover.test.tsx` + the
 * capability-prompt precedent; here we assert the wiring + copy.
 */

import { VaultDbKind, VaultRecovery } from "@brainstorm-os/protocol/vault-recovery-wire-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VaultRecoveryPrompt } from "./vault-recovery-prompt";

describe("VaultRecoveryPrompt", () => {
	it("offers Rebuild from content for a corrupt entities DB", () => {
		const html = renderToStaticMarkup(
			<VaultRecoveryPrompt
				prompt={{
					id: "vlt_1",
					kind: VaultDbKind.Entities,
					recovery: VaultRecovery.PromptRebuildFromSources,
				}}
				onRecover={() => undefined}
				onDismiss={() => undefined}
			/>,
		);
		expect(html).toContain('role="dialog"');
		expect(html).toContain('data-testid="vault-recovery-prompt"');
		expect(html).toContain("Rebuild from content");
		expect(html).toContain("Not now");
		// Honest body copy mentions the recoverable path.
		expect(html).toContain("rebuilt from your synced content");
		expect(html).not.toContain("Re-initialize");
	});

	it("offers Re-initialize for an irrecoverable ledger/registry DB", () => {
		const html = renderToStaticMarkup(
			<VaultRecoveryPrompt
				prompt={{
					id: "vlt_1",
					kind: VaultDbKind.Ledger,
					recovery: VaultRecovery.PromptRestoreOrReinit,
				}}
				onRecover={() => undefined}
				onDismiss={() => undefined}
			/>,
		);
		expect(html).toContain("Re-initialize");
		expect(html).toContain("Not now");
		expect(html).not.toContain("Rebuild from content");
	});
});
