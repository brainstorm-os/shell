import { VersionCause } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DAY_MS,
	HOUR_MS,
	MIN_HISTORY_CAP_BYTES,
	type RetentionCandidate,
	RetentionDropReason,
	type RetentionPolicy,
	WEEK_MS,
	defaultHistoryCapBytes,
	defaultRetentionPolicy,
	planRetention,
} from "./retention-policy";

const NOW = 1_000 * WEEK_MS;
const ROOMY: RetentionPolicy = {
	capBytes: Number.MAX_SAFE_INTEGER,
	agentPrincipalCapBytes: Number.MAX_SAFE_INTEGER,
	agentPrincipalCapCount: Number.MAX_SAFE_INTEGER,
};

let seq = 0;
function cp(over: Partial<RetentionCandidate> & { at: number }): RetentionCandidate {
	seq += 1;
	const versionId = over.versionId ?? `v${String(seq).padStart(5, "0")}`;
	return {
		versionId,
		entityId: "e1",
		cause: VersionCause.Idle,
		changeSetId: null,
		agentPrincipal: null,
		frameKey: `f-${versionId}`,
		frameBytes: 100,
		ownBytes: 10,
		...over,
	};
}

function kept(cands: RetentionCandidate[], policy = ROOMY, now = NOW): string[] {
	const plan = planRetention(cands, now, policy);
	return cands.filter((c) => !plan.drop.has(c.versionId)).map((c) => c.versionId);
}

describe("default cap (OQ-VH-3)", () => {
	it("is 500 MB for a small or unknown vault", () => {
		expect(defaultHistoryCapBytes(0)).toBe(MIN_HISTORY_CAP_BYTES);
		expect(defaultHistoryCapBytes(1024)).toBe(MIN_HISTORY_CAP_BYTES);
		expect(defaultHistoryCapBytes(Number.NaN)).toBe(MIN_HISTORY_CAP_BYTES);
		expect(defaultHistoryCapBytes(-5)).toBe(MIN_HISTORY_CAP_BYTES);
	});
	it("is 10% of the vault once that exceeds 500 MB", () => {
		expect(defaultHistoryCapBytes(10 * MIN_HISTORY_CAP_BYTES)).toBe(MIN_HISTORY_CAP_BYTES);
		expect(defaultHistoryCapBytes(20 * MIN_HISTORY_CAP_BYTES)).toBe(2 * MIN_HISTORY_CAP_BYTES);
	});
	it("gives each agent a tenth of the cap", () => {
		const p = defaultRetentionPolicy(0);
		expect(p.agentPrincipalCapBytes).toBe(Math.floor(MIN_HISTORY_CAP_BYTES / 10));
		expect(p.agentPrincipalCapCount).toBeGreaterThan(0);
	});
});

describe("tiers", () => {
	it("keeps every checkpoint under 24 h", () => {
		const cands = Array.from({ length: 50 }, (_, i) => cp({ at: NOW - i * 60_000 }));
		expect(kept(cands)).toHaveLength(50);
	});

	it("keeps one per hour between 24 h and 7 days — the newest in each hour", () => {
		const hourStart = Math.floor((NOW - 2 * DAY_MS) / HOUR_MS) * HOUR_MS;
		const a = cp({ at: hourStart + 1_000 });
		const b = cp({ at: hourStart + 2_000 });
		const c = cp({ at: hourStart + HOUR_MS + 1 });
		expect(kept([a, b, c]).sort()).toEqual([b.versionId, c.versionId].sort());
		expect(planRetention([a, b, c], NOW, ROOMY).drop.get(a.versionId)).toBe(
			RetentionDropReason.Thinned,
		);
	});

	it("keeps one per day between 7 and 30 days", () => {
		const dayStart = Math.floor((NOW - 10 * DAY_MS) / DAY_MS) * DAY_MS;
		const cands = Array.from({ length: 5 }, (_, i) => cp({ at: dayStart + i * HOUR_MS }));
		const next = cp({ at: dayStart + DAY_MS + 5 });
		expect(kept([...cands, next]).sort()).toEqual([cands[4]?.versionId, next.versionId].sort());
	});

	it("keeps one per week after 30 days", () => {
		const weekStart = Math.floor((NOW - 60 * DAY_MS) / WEEK_MS) * WEEK_MS;
		const cands = Array.from({ length: 6 }, (_, i) => cp({ at: weekStart + i * DAY_MS }));
		expect(kept(cands)).toEqual([cands[5]?.versionId]);
	});

	it("thins per entity, never across entities", () => {
		const t = Math.floor((NOW - 3 * DAY_MS) / HOUR_MS) * HOUR_MS;
		const a = cp({ at: t + 1, entityId: "a" });
		const b = cp({ at: t + 2, entityId: "b" });
		expect(kept([a, b])).toHaveLength(2);
	});

	it("exempts change-set checkpoints so a revert keeps its pre-state", () => {
		const t = Math.floor((NOW - 3 * DAY_MS) / HOUR_MS) * HOUR_MS;
		const idle = cp({ at: t + 10 });
		const bulk = cp({ at: t + 1, cause: VersionCause.BeforeBulk, changeSetId: "cs1" });
		const old = cp({ at: NOW - 400 * DAY_MS, cause: VersionCause.BeforeBulk, changeSetId: "cs2" });
		expect(kept([idle, bulk, old]).sort()).toEqual(
			[idle.versionId, bulk.versionId, old.versionId].sort(),
		);
	});

	it("treats a future-dated checkpoint (clock skew) as recent", () => {
		const a = cp({ at: NOW + DAY_MS });
		const b = cp({ at: NOW + DAY_MS + 1 });
		expect(kept([a, b])).toHaveLength(2);
	});
});

describe("per-principal AgentRun cap", () => {
	const agentRun = (agent: string, at: number, over: Partial<RetentionCandidate> = {}) =>
		cp({ at, cause: VersionCause.AgentRun, changeSetId: `run-${agent}`, agentPrincipal: agent, ...over });

	it("caps an agent by count, newest first", () => {
		const runs = Array.from({ length: 10 }, (_, i) => agentRun("bot", NOW - i * 1_000));
		const plan = planRetention(runs, NOW, { ...ROOMY, agentPrincipalCapCount: 3 });
		expect(runs.filter((r) => !plan.drop.has(r.versionId))).toEqual(runs.slice(0, 3));
		expect(plan.drop.get(runs[9]?.versionId ?? "")).toBe(RetentionDropReason.AgentPrincipalCap);
	});

	it("caps an agent by bytes", () => {
		const runs = Array.from({ length: 5 }, (_, i) => agentRun("bot", NOW - i * 1_000));
		expect(kept(runs, { ...ROOMY, agentPrincipalCapBytes: 230 })).toEqual([
			runs[0]?.versionId,
			runs[1]?.versionId,
		]);
	});

	it("counts a shared frame once inside one agent's budget", () => {
		const a = agentRun("bot", NOW - 1, { frameKey: "shared" });
		const b = agentRun("bot", NOW - 2, { frameKey: "shared" });
		expect(kept([a, b], { ...ROOMY, agentPrincipalCapBytes: 120 })).toHaveLength(2);
	});

	it("a looping agent never evicts another agent or the user's history", () => {
		const loop = Array.from({ length: 500 }, (_, i) => agentRun("looper", NOW - i));
		const other = agentRun("polite", NOW - 10_000);
		const user = Array.from({ length: 20 }, (_, i) => cp({ at: NOW - i * 60_000, entityId: `u${i}` }));
		const policy: RetentionPolicy = {
			capBytes: 100_000,
			agentPrincipalCapBytes: 1_100,
			agentPrincipalCapCount: 10,
		};
		const result = new Set(kept([...loop, other, ...user], policy));
		expect(loop.filter((l) => result.has(l.versionId))).toHaveLength(10);
		expect(result.has(other.versionId)).toBe(true);
		for (const u of user) expect(result.has(u.versionId)).toBe(true);
	});

	it("does not cap AgentRun rows with no resolvable agent, nor other causes", () => {
		const orphan = cp({ at: NOW, cause: VersionCause.AgentRun, changeSetId: "x" });
		const bulk = cp({ at: NOW - 1, cause: VersionCause.BeforeBulk, changeSetId: "y" });
		expect(kept([orphan, bulk], { ...ROOMY, agentPrincipalCapCount: 0 })).toHaveLength(2);
	});
});

describe("vault byte cap", () => {
	it("drops nothing under the cap", () => {
		const cands = Array.from({ length: 5 }, (_, i) => cp({ at: NOW - i }));
		const plan = planRetention(cands, NOW, { ...ROOMY, capBytes: 550 });
		expect(plan.drop.size).toBe(0);
		expect(plan.keptBytes).toBe(550);
	});

	it("drops oldest first until under the cap", () => {
		const cands = Array.from({ length: 5 }, (_, i) => cp({ at: NOW - i * 1_000 }));
		const plan = planRetention(cands, NOW, { ...ROOMY, capBytes: 330 });
		expect(cands.filter((c) => !plan.drop.has(c.versionId))).toEqual(cands.slice(0, 3));
		expect(plan.drop.get(cands[4]?.versionId ?? "")).toBe(RetentionDropReason.ByteCap);
		expect(plan.keptBytes).toBe(330);
	});

	it("goes after the oldest weekly checkpoints before recent ones", () => {
		const weekly = cp({ at: NOW - 200 * DAY_MS });
		const recent = cp({ at: NOW - 1_000 });
		const newest = cp({ at: NOW });
		expect(kept([weekly, recent, newest], { ...ROOMY, capBytes: 220 })).toEqual([
			recent.versionId,
			newest.versionId,
		]);
	});

	it("never drops an entity's newest checkpoint, even over the cap", () => {
		const cands = ["a", "b", "c"].map((e) => cp({ at: NOW - 1, entityId: e }));
		const plan = planRetention(cands, NOW, { ...ROOMY, capBytes: 1 });
		expect(plan.drop.size).toBe(0);
	});

	it("frees a shared frame only when its last checkpoint goes", () => {
		const a = cp({ at: NOW - 3_000, frameKey: "s" });
		const b = cp({ at: NOW - 2_000, frameKey: "s" });
		const c = cp({ at: NOW - 1_000 });
		// a+b share 100 frame bytes: a(10) + b(10) + 100 + c(110) = 230
		const plan = planRetention([a, b, c], NOW, { ...ROOMY, capBytes: 220 });
		expect(plan.drop.has(a.versionId)).toBe(true);
		expect(plan.drop.has(b.versionId)).toBe(false);
		expect(plan.keptBytes).toBe(220);
	});
});

describe("plan properties", () => {
	function randomCands(n: number, seed: number): RetentionCandidate[] {
		let s = seed;
		const rnd = () => {
			s = (s * 1103515245 + 12345) % 2 ** 31;
			return s / 2 ** 31;
		};
		const causes = Object.values(VersionCause);
		return Array.from({ length: n }, () => {
			const cause = causes[Math.floor(rnd() * causes.length)] ?? VersionCause.Idle;
			const inSet = cause !== VersionCause.Idle && cause !== VersionCause.Manual;
			return cp({
				at: NOW - Math.floor(rnd() * 400 * DAY_MS),
				entityId: `e${Math.floor(rnd() * 8)}`,
				cause,
				changeSetId: inSet ? `cs${Math.floor(rnd() * 5)}` : null,
				agentPrincipal: cause === VersionCause.AgentRun ? `agent${Math.floor(rnd() * 3)}` : null,
				frameKey: `f${Math.floor(rnd() * n * 0.8)}`,
				frameBytes: 50 + Math.floor(rnd() * 500),
				ownBytes: Math.floor(rnd() * 40),
			});
		});
	}

	it("is deterministic regardless of input order", () => {
		const cands = randomCands(300, 7);
		const policy = { capBytes: 20_000, agentPrincipalCapBytes: 3_000, agentPrincipalCapCount: 15 };
		const a = [...planRetention(cands, NOW, policy).drop.keys()].sort();
		const b = [...planRetention([...cands].reverse(), NOW, policy).drop.keys()].sort();
		expect(a).toEqual(b);
	});

	it("is idempotent — re-planning the survivors drops nothing more", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const cands = randomCands(250, seed);
			const policy = { capBytes: 15_000, agentPrincipalCapBytes: 2_000, agentPrincipalCapCount: 10 };
			const first = planRetention(cands, NOW, policy);
			const survivors = cands.filter((c) => !first.drop.has(c.versionId));
			expect(planRetention(survivors, NOW, policy).drop.size).toBe(0);
		}
	});

	it("ends under the cap, or with only each entity's newest left", () => {
		for (const seed of [11, 12, 13]) {
			const cands = randomCands(400, seed);
			const policy = { capBytes: 5_000, agentPrincipalCapBytes: 1_000, agentPrincipalCapCount: 5 };
			const plan = planRetention(cands, NOW, policy);
			const survivors = cands.filter((c) => !plan.drop.has(c.versionId));
			const perEntity = new Map<string, number>();
			for (const s of survivors) perEntity.set(s.entityId, (perEntity.get(s.entityId) ?? 0) + 1);
			const onlyNewest = [...perEntity.values()].every((n) => n === 1);
			expect(plan.keptBytes <= policy.capBytes || onlyNewest).toBe(true);
		}
	});
});
