import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../storage/data-stores";
import { CreditEntryKind, CreditLedgerRepository } from "./credit-ledger-repo";

describe("CreditLedgerRepository", () => {
	let vaultDir: string;
	let stores: DataStores;
	let ledger: CreditLedgerRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-credit-ledger-"));
		stores = new DataStores(vaultDir);
		ledger = new CreditLedgerRepository(await stores.open("account"));
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("starts at zero balance", () => {
		expect(ledger.balanceMicro()).toBe(0);
	});

	it("balance = grants − debits", () => {
		ledger.append({ ts: 1, kind: CreditEntryKind.Grant, creditsMicro: 10_000_000 });
		ledger.append({
			ts: 2,
			kind: CreditEntryKind.Debit,
			creditsMicro: 1_500_000,
			appId: "io.brainstorm.agent",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
		});
		ledger.append({ ts: 3, kind: CreditEntryKind.Debit, creditsMicro: 500_000 });
		expect(ledger.balanceMicro()).toBe(8_000_000);
	});

	it("rejects non-positive amounts (accounting fail-closed)", () => {
		expect(() => ledger.append({ ts: 1, kind: CreditEntryKind.Grant, creditsMicro: 0 })).toThrow();
		expect(() => ledger.append({ ts: 1, kind: CreditEntryKind.Debit, creditsMicro: -5 })).toThrow();
		expect(() =>
			ledger.append({ ts: 1, kind: CreditEntryKind.Debit, creditsMicro: Number.NaN }),
		).toThrow();
	});

	it("unsynced returns oldest-first and markSynced stamps the receipt", () => {
		const a = ledger.append({ ts: 1, kind: CreditEntryKind.Debit, creditsMicro: 1 });
		const b = ledger.append({ ts: 2, kind: CreditEntryKind.Debit, creditsMicro: 2 });
		const pending = ledger.unsynced();
		expect(pending.map((e) => e.id)).toEqual([a, b]);
		expect(pending.every((e) => !e.synced)).toBe(true);

		ledger.markSynced([a], "ingest-receipt-1");
		const rest = ledger.unsynced();
		expect(rest.map((e) => e.id)).toEqual([b]);
	});

	it("markSynced with no ids is a no-op", () => {
		expect(() => ledger.markSynced([], "x")).not.toThrow();
	});

	it("round-trips debit metadata (app/provider/model)", () => {
		ledger.append({
			ts: 9,
			kind: CreditEntryKind.Debit,
			creditsMicro: 42,
			appId: "io.brainstorm.agent",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
		});
		const [entry] = ledger.unsynced();
		expect(entry).toMatchObject({
			kind: CreditEntryKind.Debit,
			creditsMicro: 42,
			appId: "io.brainstorm.agent",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			remoteRef: null,
		});
	});
});
