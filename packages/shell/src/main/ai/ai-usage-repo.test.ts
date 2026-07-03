import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../storage/data-stores";
import { getSchemaVersion } from "../storage/migrations";
import { AiUsageOutcome } from "./ai-usage-log";
import { AiUsageRepository, type AiUsageRow } from "./ai-usage-repo";

const row = (overrides: Partial<AiUsageRow> = {}): AiUsageRow => ({
	ts: 1_000,
	appId: "io.brainstorm.agent",
	verb: "generate",
	provider: "anthropic",
	model: "claude-sonnet-4-6",
	promptTokens: 100,
	completionTokens: 50,
	totalTokens: 150,
	creditsMicro: 1_050,
	outcome: AiUsageOutcome.Ok,
	durationMs: 300,
	...overrides,
});

describe("AiUsageRepository", () => {
	let vaultDir: string;
	let stores: DataStores;
	let repo: AiUsageRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-ai-usage-"));
		stores = new DataStores(vaultDir);
		repo = new AiUsageRepository(await stores.open("account"));
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("account.db migrates to v2 (ai_usage + ai_credit_ledger land)", async () => {
		const db = await stores.open("account");
		expect(getSchemaVersion(db)).toBe(2);
		// Both tables exist and are queryable.
		expect(db.prepare("SELECT COUNT(*) AS n FROM ai_usage").get()).toEqual({ n: 0 });
		expect(db.prepare("SELECT COUNT(*) AS n FROM ai_credit_ledger").get()).toEqual({ n: 0 });
	});

	it("insert + totalsForApp aggregates one app since a timestamp", () => {
		repo.insert(row({ ts: 10, totalTokens: 100, creditsMicro: 5 }));
		repo.insert(row({ ts: 20, totalTokens: 200, creditsMicro: 10 }));
		repo.insert(row({ ts: 30, appId: "other.app", totalTokens: 999, creditsMicro: 999 }));

		const totals = repo.totalsForApp("io.brainstorm.agent", 0);
		expect(totals).toEqual({ calls: 2, totalTokens: 300, creditsMicro: 15 });
	});

	it("window rollover: rows before sinceTs stop counting", () => {
		repo.insert(row({ ts: 100, totalTokens: 1_000 }));
		repo.insert(row({ ts: 200, totalTokens: 50 }));

		expect(repo.totalsForApp("io.brainstorm.agent", 0).totalTokens).toBe(1_050);
		// The old row rolls out of the window → only the recent one counts.
		expect(repo.totalsForApp("io.brainstorm.agent", 150).totalTokens).toBe(50);
		expect(repo.totalsForApp("io.brainstorm.agent", 201).totalTokens).toBe(0);
	});

	it("summarizeByApp groups per app with a provider/model breakdown", () => {
		repo.insert(row({ ts: 10, provider: "anthropic", model: "claude-sonnet-4-6" }));
		repo.insert(row({ ts: 20, provider: "ollama", model: "llama3.2", creditsMicro: 0 }));
		repo.insert(
			row({ ts: 30, provider: "", model: "", outcome: AiUsageOutcome.Error, totalTokens: 0 }),
		);
		repo.insert(row({ ts: 40, appId: "other.app" }));

		const apps = repo.summarizeByApp(0);
		expect(apps).toHaveLength(2);
		// Most-recently-active first.
		expect(apps[0]?.appId).toBe("other.app");
		const agent = apps[1];
		expect(agent).toMatchObject({
			appId: "io.brainstorm.agent",
			calls: 3,
			errors: 1,
			totalTokens: 300,
			lastSeenMs: 30,
		});
		// The failed-before-resolve row (empty provider) counts in totals but
		// isn't a provider/model slice.
		expect(agent?.byProviderModel).toHaveLength(2);
		expect(agent?.byProviderModel.map((p) => p.provider).sort()).toEqual(["anthropic", "ollama"]);
	});

	it("summarizeByApp respects the window", () => {
		repo.insert(row({ ts: 10 }));
		expect(repo.summarizeByApp(50)).toHaveLength(0);
	});

	it("deleteBefore prunes retention-expired rows only", () => {
		repo.insert(row({ ts: 10 }));
		repo.insert(row({ ts: 500 }));
		expect(repo.deleteBefore(100)).toBe(1);
		expect(repo.totalsForApp("io.brainstorm.agent", 0).calls).toBe(1);
	});
});
