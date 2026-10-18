/**
 * Version-history retention (doc `version-history.md` §Retention) — PURE.
 *
 * Three passes, in order:
 *
 *  1. **Tiers**, per entity: every checkpoint under 24 h; one per hour under
 *     7 days; one per day under 30 days; one per week after that. The newest
 *     checkpoint in each bucket survives. A checkpoint that belongs to a change
 *     set is exempt — thinning it would silently break "Revert this change".
 *  2. **Per-principal cap** for `AgentRun` checkpoints: each agent keeps at most
 *     `agentPrincipalCapCount` checkpoints / `agentPrincipalCapBytes` bytes,
 *     newest first. Without it a looping agent could fill the vault cap and
 *     evict the user's own history (an eviction attack).
 *  3. **Vault byte cap**: while over `capBytes`, drop the oldest checkpoint —
 *     after pass 1 those are the weekly ones. An entity's newest checkpoint is
 *     never dropped here, so every object keeps at least one version.
 *
 * Bytes are frame bytes (deduplicated: several checkpoints may share one
 * frame) plus each checkpoint's own properties JSON.
 */

import { VersionCause } from "@brainstorm-os/sdk-types";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** OQ-VH-3 — the floor of the default vault cap. */
export const MIN_HISTORY_CAP_BYTES = 500 * 1024 * 1024;
/** OQ-VH-3 — the default cap's share of the vault's on-disk size. */
export const HISTORY_CAP_VAULT_FRACTION = 0.1;
export const AGENT_PRINCIPAL_CAP_FRACTION = 0.1;
export const AGENT_PRINCIPAL_CAP_COUNT = 2000;

export type RetentionPolicy = {
	capBytes: number;
	agentPrincipalCapBytes: number;
	agentPrincipalCapCount: number;
};

/** OQ-VH-3: the larger of 500 MB and 10% of the vault's size on disk. */
export function defaultHistoryCapBytes(vaultBytes: number): number {
	const share = Number.isFinite(vaultBytes) && vaultBytes > 0 ? vaultBytes : 0;
	return Math.max(MIN_HISTORY_CAP_BYTES, Math.floor(share * HISTORY_CAP_VAULT_FRACTION));
}

export function defaultRetentionPolicy(vaultBytes: number): RetentionPolicy {
	const capBytes = defaultHistoryCapBytes(vaultBytes);
	return {
		capBytes,
		agentPrincipalCapBytes: Math.floor(capBytes * AGENT_PRINCIPAL_CAP_FRACTION),
		agentPrincipalCapCount: AGENT_PRINCIPAL_CAP_COUNT,
	};
}

export type RetentionCandidate = {
	versionId: string;
	entityId: string;
	at: number;
	cause: VersionCause;
	changeSetId: string | null;
	/** For an `AgentRun` checkpoint: the agent its change set acts as. */
	agentPrincipal: string | null;
	/** Identity of the stored frame; equal keys share bytes. */
	frameKey: string;
	frameBytes: number;
	/** Bytes this checkpoint owns outright (its properties JSON). */
	ownBytes: number;
};

export enum RetentionDropReason {
	Thinned = "thinned",
	AgentPrincipalCap = "agent-principal-cap",
	ByteCap = "byte-cap",
}

export type RetentionPlan = {
	drop: Map<string, RetentionDropReason>;
	keptBytes: number;
};

enum Tier {
	Recent = "recent",
	Hourly = "hourly",
	Daily = "daily",
	Weekly = "weekly",
}

function tierOf(ageMs: number): Tier {
	if (ageMs < DAY_MS) return Tier.Recent;
	if (ageMs < WEEK_MS) return Tier.Hourly;
	if (ageMs < 30 * DAY_MS) return Tier.Daily;
	return Tier.Weekly;
}

const BUCKET_MS: Readonly<Record<Exclude<Tier, Tier.Recent>, number>> = {
	[Tier.Hourly]: HOUR_MS,
	[Tier.Daily]: DAY_MS,
	[Tier.Weekly]: WEEK_MS,
};

/** Newest first; ties broken by id so the plan is deterministic. */
function newestFirst(a: RetentionCandidate, b: RetentionCandidate): number {
	return b.at - a.at || (a.versionId < b.versionId ? 1 : a.versionId > b.versionId ? -1 : 0);
}

export function planRetention(
	candidates: readonly RetentionCandidate[],
	now: number,
	policy: RetentionPolicy,
): RetentionPlan {
	const drop = new Map<string, RetentionDropReason>();
	const sorted = [...candidates].sort(newestFirst);

	const seenBuckets = new Set<string>();
	for (const c of sorted) {
		if (c.changeSetId !== null) continue;
		const tier = tierOf(Math.max(0, now - c.at));
		if (tier === Tier.Recent) continue;
		const bucket = `${c.entityId}\u0000${tier}\u0000${Math.floor(c.at / BUCKET_MS[tier])}`;
		if (seenBuckets.has(bucket)) drop.set(c.versionId, RetentionDropReason.Thinned);
		else seenBuckets.add(bucket);
	}

	const byAgent = new Map<string, { count: number; bytes: number; frames: Set<string> }>();
	for (const c of sorted) {
		if (drop.has(c.versionId) || c.cause !== VersionCause.AgentRun || c.agentPrincipal === null) {
			continue;
		}
		let usage = byAgent.get(c.agentPrincipal);
		if (!usage) {
			usage = { count: 0, bytes: 0, frames: new Set() };
			byAgent.set(c.agentPrincipal, usage);
		}
		const addBytes = c.ownBytes + (usage.frames.has(c.frameKey) ? 0 : c.frameBytes);
		if (
			usage.count + 1 > policy.agentPrincipalCapCount ||
			usage.bytes + addBytes > policy.agentPrincipalCapBytes
		) {
			drop.set(c.versionId, RetentionDropReason.AgentPrincipalCap);
			continue;
		}
		usage.count += 1;
		usage.bytes += addBytes;
		usage.frames.add(c.frameKey);
	}

	const kept = sorted.filter((c) => !drop.has(c.versionId));
	const frameRefs = new Map<string, number>();
	const frameBytes = new Map<string, number>();
	let total = 0;
	for (const c of kept) {
		total += c.ownBytes;
		const refs = frameRefs.get(c.frameKey) ?? 0;
		if (refs === 0) {
			total += c.frameBytes;
			frameBytes.set(c.frameKey, c.frameBytes);
		}
		frameRefs.set(c.frameKey, refs + 1);
	}

	if (total > policy.capBytes) {
		const newestPerEntity = new Set<string>();
		const seenEntities = new Set<string>();
		for (const c of kept) {
			if (seenEntities.has(c.entityId)) continue;
			seenEntities.add(c.entityId);
			newestPerEntity.add(c.versionId);
		}
		for (let i = kept.length - 1; i >= 0 && total > policy.capBytes; i -= 1) {
			const c = kept[i];
			if (!c || newestPerEntity.has(c.versionId)) continue;
			drop.set(c.versionId, RetentionDropReason.ByteCap);
			total -= c.ownBytes;
			const refs = (frameRefs.get(c.frameKey) ?? 1) - 1;
			frameRefs.set(c.frameKey, refs);
			if (refs === 0) total -= frameBytes.get(c.frameKey) ?? 0;
		}
	}

	return { drop, keptBytes: total };
}
