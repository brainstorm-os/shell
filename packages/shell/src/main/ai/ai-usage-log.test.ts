import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFileAuditSink } from "../network/audit-log";
import { AiUsageOutcome, type AiUsageRecord, readAiUsage, recordAiUsage } from "./ai-usage-log";

function rec(over: Partial<AiUsageRecord> = {}): AiUsageRecord {
	return {
		ts: 1000,
		appId: "io.brainstorm.agent",
		verb: "generate",
		provider: "anthropic",
		model: "claude-opus-4-8",
		promptTokens: 10,
		completionTokens: 5,
		totalTokens: 15,
		outcome: AiUsageOutcome.Ok,
		durationMs: 42,
		...over,
	};
}

describe("ai-usage-log (11.8)", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "brainstorm-ai-usage-"));
		path = join(dir, "ai-usage.jsonl");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips records through the file sink, newest-first", async () => {
		const sink = makeFileAuditSink(path);
		await recordAiUsage(sink, rec({ ts: 1000 }));
		await recordAiUsage(sink, rec({ ts: 3000 }));
		await recordAiUsage(sink, rec({ ts: 2000 }));
		const read = await readAiUsage(path);
		expect(read.map((r) => r.ts)).toEqual([3000, 2000, 1000]);
	});

	it("returns [] for a missing file and skips malformed lines", async () => {
		expect(await readAiUsage(path)).toEqual([]);
		await appendFile(path, `${JSON.stringify(rec())}\nnot json\n{"partial":\n`, "utf8");
		const read = await readAiUsage(path);
		expect(read).toHaveLength(1);
		expect(read[0]?.provider).toBe("anthropic");
	});
});
