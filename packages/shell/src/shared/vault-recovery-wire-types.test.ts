/**
 * Iteration 12.8 — the renderer-safe corruption wire types. The load-bearing
 * test is the enum-parity guard: the handler casts the main-side
 * `CorruptionRecovery` / `DataStoreKind` straight into the wire enums, so their
 * string values MUST stay identical or a corrupt-vault activate would carry a
 * recovery action the renderer doesn't understand.
 */

import {
	VaultDbKind,
	VaultRecovery,
	corruptionMessage,
} from "@brainstorm-os/protocol/vault-recovery-wire-types";
import { describe, expect, it } from "vitest";
import { CorruptionRecovery } from "../main/storage/recovery-plan";

describe("vault-recovery wire enums", () => {
	it("VaultRecovery values mirror the main CorruptionRecovery enum exactly", () => {
		expect(Object.values(VaultRecovery).sort()).toEqual(Object.values(CorruptionRecovery).sort());
	});

	it("VaultDbKind values are the four domain DB kinds", () => {
		expect(Object.values(VaultDbKind).sort()).toEqual(["entities", "ledger", "registry", "search"]);
	});
});

describe("corruptionMessage", () => {
	it("names the corrupt file and the restore/re-init path for authoritative DBs", () => {
		const msg = corruptionMessage(VaultDbKind.Ledger, VaultRecovery.PromptRestoreOrReinit);
		expect(msg).toContain("ledger.db");
		expect(msg).toMatch(/backup/i);
		expect(msg).toMatch(/re-?initiali[sz]e/i);
	});

	it("mentions rebuild-from-synced-content for the entities DB", () => {
		const msg = corruptionMessage(VaultDbKind.Entities, VaultRecovery.PromptRebuildFromSources);
		expect(msg).toContain("entities.db");
		expect(msg).toMatch(/synced content|rebuilt/i);
	});

	it("has a copy branch for every recovery action (no fallthrough)", () => {
		for (const recovery of Object.values(VaultRecovery)) {
			const msg = corruptionMessage(VaultDbKind.Registry, recovery);
			expect(msg.length).toBeGreaterThan(0);
			expect(msg).toContain("registry.db");
		}
	});
});
