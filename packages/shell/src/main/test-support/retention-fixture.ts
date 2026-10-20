import { VersionCause } from "@brainstorm-os/sdk-types";
import type { RetentionCandidate, RetentionPolicy } from "../history/retention-policy";
import { DAY_MS, HOUR_MS } from "../history/retention-policy";

export const RETENTION_FIXTURE_NOW = 1_000 * 7 * DAY_MS;

/** Tight enough that every pass drops something on the default fixture. */
export const RETENTION_FIXTURE_POLICY: RetentionPolicy = {
	capBytes: 60 * 1024 * 1024,
	agentPrincipalCapBytes: 4 * 1024 * 1024,
	agentPrincipalCapCount: 400,
};

/** mulberry32 — a seeded PRNG so the fixture is identical on every run. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const AGENTS = ["agent:looper", "agent:tidy", "agent:scribe"];

/** A deterministic vault-sized candidate list: Idle checkpoints spread over
 *  90 days (so every tier is populated), change-set rows, agent-charged rows
 *  (one agent far over its cap), and some frames shared by two checkpoints. */
export function retentionFixture(entities: number, versionsPer: number): RetentionCandidate[] {
	const rand = prng(entities * 31 + versionsPer);
	const out: RetentionCandidate[] = [];
	let seq = 0;
	for (let e = 0; e < entities; e += 1) {
		const entityId = `e${e.toString(36).padStart(6, "0")}`;
		let previousFrame: string | null = null;
		for (let k = 0; k < versionsPer; k += 1) {
			seq += 1;
			const versionId = `v${seq.toString(36).padStart(8, "0")}`;
			const age = Math.floor(rand() * 90 * DAY_MS + rand() * HOUR_MS);
			const roll = rand();
			const agent = roll < 0.15 ? (roll < 0.1 ? AGENTS[0] : AGENTS[1 + (seq % 2)]) : null;
			const inChangeSet = agent !== null || roll > 0.95;
			const frameKey: string =
				previousFrame !== null && rand() < 0.2 ? previousFrame : `${entityId}\u0000${seq}`;
			previousFrame = frameKey;
			out.push({
				versionId,
				entityId,
				at: RETENTION_FIXTURE_NOW - age,
				cause: agent !== null ? VersionCause.AgentRun : VersionCause.Idle,
				changeSetId: inChangeSet ? `cs${Math.floor(seq / 7)}` : null,
				agentPrincipal: agent ?? null,
				frameKey,
				frameBytes: 2_048 + Math.floor(rand() * 8_192),
				ownBytes: 200 + Math.floor(rand() * 400),
			});
		}
	}
	return out;
}
