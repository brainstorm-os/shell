import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreditEntryKind, CreditLedgerRepository } from "../billing/credit-ledger-repo";
import { DataStores } from "../storage/data-stores";
import {
	AI_BUDGET_WINDOW_MS,
	AI_USAGE_RETENTION_MS,
	AiBudgetUnit,
	AiQuotaService,
} from "./ai-quota";
import { AiUsageOutcome, type AiUsageRecord } from "./ai-usage-log";
import { AiUsageRepository } from "./ai-usage-repo";
import { CREDIT_MICROS } from "./model-rates";

const APP = "io.brainstorm.agent";

const record = (overrides: Partial<AiUsageRecord> = {}): AiUsageRecord => ({
	ts: Date.now(),
	appId: APP,
	verb: "generate",
	provider: "anthropic",
	model: "claude-opus-4-8",
	promptTokens: 1000,
	completionTokens: 500,
	totalTokens: 1500,
	outcome: AiUsageOutcome.Ok,
	durationMs: 200,
	...overrides,
});

describe("AiQuotaService", () => {
	let vaultDir: string;
	let stores: DataStores;
	let repo: AiUsageRepository;
	let creditLedger: CreditLedgerRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-ai-quota-"));
		stores = new DataStores(vaultDir);
		const db = await stores.open("account");
		repo = new AiUsageRepository(db);
		creditLedger = new CreditLedgerRepository(db);
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	function service(overrides: Partial<ConstructorParameters<typeof AiQuotaService>[0]> = {}) {
		return new AiQuotaService({
			getUsageRepo: async () => repo,
			getBudgets: async () => ({}),
			...overrides,
		});
	}

	describe("checkBudget", () => {
		it("passes with no budget configured (unlimited by policy)", async () => {
			await expect(service().checkBudget(APP)).resolves.toBeUndefined();
		});

		it("blocks with the distinct AiBudgetExhausted error once tokens hit the ceiling", async () => {
			await service().recordUsage(record({ totalTokens: 1500 }));
			const quota = service({ getBudgets: async () => ({ [APP]: { maxTokens: 1000 } }) });
			await expect(quota.checkBudget(APP)).rejects.toMatchObject({
				name: "AiBudgetExhausted",
				unit: AiBudgetUnit.Tokens,
				used: 1500,
				limit: 1000,
			});
		});

		it("blocks on a credit ceiling (compared in micro units)", async () => {
			// 1M prompt + 1M completion tokens on opus = $30 = 30 credits.
			await service().recordUsage(
				record({ promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }),
			);
			const quota = service({ getBudgets: async () => ({ [APP]: { maxCredits: 30 } }) });
			await expect(quota.checkBudget(APP)).rejects.toMatchObject({
				name: "AiBudgetExhausted",
				unit: AiBudgetUnit.Credits,
				limit: 30,
			});
			// A higher ceiling still passes.
			const roomy = service({ getBudgets: async () => ({ [APP]: { maxCredits: 31 } }) });
			await expect(roomy.checkBudget(APP)).resolves.toBeUndefined();
		});

		it("window rollover: usage older than 30 days frees the budget", async () => {
			const now = Date.now();
			await service().recordUsage(record({ ts: now - AI_BUDGET_WINDOW_MS - 1000, totalTokens: 5000 }));
			const quota = service({ getBudgets: async () => ({ [APP]: { maxTokens: 1000 } }) });
			await expect(quota.checkBudget(APP)).resolves.toBeUndefined();
			// A fresh call inside the window re-blocks.
			await service().recordUsage(record({ ts: now, totalTokens: 5000 }));
			await expect(quota.checkBudget(APP)).rejects.toMatchObject({ name: "AiBudgetExhausted" });
		});

		it("budgets do not bind other apps", async () => {
			await service().recordUsage(record({ totalTokens: 99_999 }));
			const quota = service({ getBudgets: async () => ({ "other.app": { maxTokens: 1 } }) });
			await expect(quota.checkBudget(APP)).resolves.toBeUndefined();
		});

		it("exempts the shell and the reserved _shell.* namespace", async () => {
			const quota = service({
				getBudgets: async () => ({ shell: { maxTokens: 1 }, "_shell.ai": { maxTokens: 1 } }),
				getUsageRepo: async () => {
					throw new Error("must not be consulted for exempt callers");
				},
			});
			await expect(quota.checkBudget("shell")).resolves.toBeUndefined();
			await expect(quota.checkBudget("_shell.ai")).resolves.toBeUndefined();
		});

		it("fails closed (Unavailable) when a budget exists but the usage store is unreadable", async () => {
			const quota = service({
				getBudgets: async () => ({ [APP]: { maxTokens: 1000 } }),
				getUsageRepo: async () => null,
			});
			await expect(quota.checkBudget(APP)).rejects.toMatchObject({ name: "Unavailable" });
			const throwing = service({
				getBudgets: async () => ({ [APP]: { maxTokens: 1000 } }),
				getUsageRepo: async () => {
					throw new Error("db locked");
				},
			});
			await expect(throwing.checkBudget(APP)).rejects.toMatchObject({ name: "Unavailable" });
		});

		it("fails closed (Unavailable) when the budget store itself is unreadable", async () => {
			const quota = service({
				getBudgets: async () => {
					throw new Error("settings corrupted");
				},
			});
			await expect(quota.checkBudget(APP)).rejects.toMatchObject({ name: "Unavailable" });
		});
	});

	describe("recordUsage", () => {
		it("writes one priced accounting row per call", async () => {
			await service().recordUsage(
				record({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }),
			);
			const totals = repo.totalsForApp(APP, 0);
			expect(totals.calls).toBe(1);
			expect(totals.totalTokens).toBe(1_000_000);
			// opus input $5/MTok → 5 credits for 1M prompt tokens.
			expect(totals.creditsMicro).toBe(5 * CREDIT_MICROS);
		});

		it("records error rows with zero credits when the provider never resolved", async () => {
			await service().recordUsage(
				record({
					provider: "",
					model: "",
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					outcome: AiUsageOutcome.Error,
				}),
			);
			const [app] = repo.summarizeByApp(0);
			expect(app).toMatchObject({ calls: 1, errors: 1, creditsMicro: 0 });
		});

		it("is best-effort: an insert failure never throws", async () => {
			const quota = service({
				getUsageRepo: async () => {
					throw new Error("disk full");
				},
			});
			await expect(quota.recordUsage(record())).resolves.toBeUndefined();
		});

		it("prunes rows past retention opportunistically", async () => {
			const now = Date.now();
			repo.insert({
				ts: now - AI_USAGE_RETENTION_MS - 1000,
				appId: APP,
				verb: "generate",
				provider: "ollama",
				model: "llama3.2",
				promptTokens: 1,
				completionTokens: 1,
				totalTokens: 2,
				creditsMicro: 0,
				outcome: AiUsageOutcome.Ok,
				durationMs: 1,
			});
			await service().recordUsage(record({ ts: now }));
			expect(repo.totalsForApp(APP, 0).calls).toBe(1); // ancient row pruned
		});

		describe("bundled-credit debits (14.3 seam)", () => {
			const bundledDeps = (isPlatformBilled: boolean, hasFeature = true) => ({
				getCreditLedger: async () => creditLedger,
				hasBundledCredits: async () => hasFeature,
				isPlatformBilled: () => isPlatformBilled,
			});

			it("debits the ledger for a successful platform-billed call", async () => {
				creditLedger.append({ ts: 1, kind: CreditEntryKind.Grant, creditsMicro: 50 * CREDIT_MICROS });
				await service(bundledDeps(true)).recordUsage(
					record({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }),
				);
				expect(creditLedger.balanceMicro()).toBe(45 * CREDIT_MICROS);
				const [debit] = creditLedger.unsynced().filter((e) => e.kind === CreditEntryKind.Debit);
				expect(debit).toMatchObject({ appId: APP, provider: "anthropic" });
			});

			it("never debits BYO calls (production posture today)", async () => {
				await service(bundledDeps(false)).recordUsage(record());
				expect(creditLedger.balanceMicro()).toBe(0);
			});

			it("never debits without the BundledAiCredits entitlement", async () => {
				await service(bundledDeps(true, false)).recordUsage(record());
				expect(creditLedger.balanceMicro()).toBe(0);
			});

			it("never debits failed calls", async () => {
				await service(bundledDeps(true)).recordUsage(record({ outcome: AiUsageOutcome.Error }));
				expect(creditLedger.balanceMicro()).toBe(0);
			});
		});
	});
});
