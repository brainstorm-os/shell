/**
 * 11.8 — per-call AI provenance log (doc 22 §Provenance + budgets).
 *
 * Every model-calling AI broker verb (`generate` / `transform` / `extract`)
 * lands one JSON-lines record: which app called, which verb, which
 * provider/model answered, the token usage, and the outcome. Per-device
 * diagnostics only — the shell records it; nothing app-facing reads it (the
 * raw log never crosses IPC). The QUERYABLE accounting substrate (the panel's
 * usage view + 14.8 budget enforcement) is the per-vault `ai_usage` table
 * (`ai-usage-repo.ts`), fed from the same broker hook.
 *
 * Metadata only — never the prompt, never the completion. Reuses the network
 * audit's generic file sink (append + size rotation) so there's one JSONL
 * machine, not two. `cost` is NOT recorded: it's a pre-send estimate, not a
 * model call.
 */

import { readFile } from "node:fs/promises";
import { rotatedPathFor } from "../network/audit-log";

export enum AiUsageOutcome {
	/** The provider returned a completion. */
	Ok = "ok",
	/** The verb failed (no provider, provider threw, invalid output). */
	Error = "error",
}

export type AiUsageRecord = {
	/** Wall-clock ms since epoch when the record was written. */
	readonly ts: number;
	/** Calling app's stable id (the broker envelope's `app`). */
	readonly appId: string;
	/** AI verb: `generate` | `transform` | `extract`. */
	readonly verb: string;
	/** Resolved provider id, or `""` when the call failed before/at resolve. */
	readonly provider: string;
	/** Resolved model id, or `""` when unknown (failure / provider omitted it). */
	readonly model: string;
	/** Prompt (input) tokens the provider reported, `0` when unknown. */
	readonly promptTokens: number;
	/** Completion (output) tokens the provider reported, `0` when unknown. */
	readonly completionTokens: number;
	/** Total tokens (prompt + completion), `0` when unknown. */
	readonly totalTokens: number;
	/** Whether the call succeeded. */
	readonly outcome: AiUsageOutcome;
	/** Wall-clock ms from verb entry to outcome. */
	readonly durationMs: number;
};

/** Append-only sink shape — a JSONL line writer. The production path uses the
 *  network audit's `makeFileAuditSink` (append + rotate); tests inject a buffer. */
export type AiUsageSink = (line: string) => Promise<void> | void;

/**
 * Write one usage record. Best-effort: a sink throw is logged + swallowed so a
 * full disk never breaks an AI call (the user gets the completion; the gap is
 * visible as a missing row).
 */
export async function recordAiUsage(sink: AiUsageSink, record: AiUsageRecord): Promise<void> {
	try {
		await sink(JSON.stringify(record));
	} catch (error) {
		console.warn(`[ai/usage] sink failed: ${(error as Error).message}`);
	}
}

/** Read the usage log + its rotated sibling, newest-first. Fail-soft: missing
 *  files → [], malformed lines skipped, any read error → []. Off the hot path
 *  (Settings panel open / budget check), so it reads both files into memory. */
export async function readAiUsage(usagePath: string): Promise<readonly AiUsageRecord[]> {
	const [current, archive] = await Promise.all([
		readUsageFile(usagePath),
		readUsageFile(rotatedPathFor(usagePath)),
	]);
	return [...archive, ...current].sort((a, b) => b.ts - a.ts);
}

function isValidUsageRecord(input: unknown): input is AiUsageRecord {
	if (!input || typeof input !== "object") return false;
	const raw = input as Record<string, unknown>;
	if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return false;
	if (typeof raw.appId !== "string") return false;
	if (typeof raw.verb !== "string") return false;
	if (typeof raw.provider !== "string") return false;
	if (typeof raw.model !== "string") return false;
	if (typeof raw.promptTokens !== "number") return false;
	if (typeof raw.completionTokens !== "number") return false;
	if (typeof raw.totalTokens !== "number") return false;
	if (typeof raw.outcome !== "string") return false;
	if (typeof raw.durationMs !== "number") return false;
	return true;
}

async function readUsageFile(path: string): Promise<readonly AiUsageRecord[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		console.warn(`[ai/usage] read failed for ${path}: ${(error as Error).message}`);
		return [];
	}
	if (text.length === 0) return [];
	const out: AiUsageRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (isValidUsageRecord(parsed)) out.push(parsed);
	}
	return out;
}
