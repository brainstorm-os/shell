import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebEgressHostSummary } from "@brainstorm-os/protocol/web-privacy-wire-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	WebEgressAudit,
	parseWebEgressRows,
	readWebEgressRows,
	writeWebEgressRows,
} from "./web-egress-audit";

function makeAudit(overrides: { maxHosts?: number } = {}) {
	const saves: WebEgressHostSummary[][] = [];
	const timers: Array<() => void> = [];
	let tick = 0;
	const audit = new WebEgressAudit({
		save: (rows) => {
			saves.push(rows.map((r) => ({ ...r })));
		},
		now: () => ++tick,
		setTimer: (fn) => {
			timers.push(fn);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: () => {},
		...(overrides.maxHosts !== undefined ? { maxHosts: overrides.maxHosts } : {}),
	});
	return { audit, saves, timers };
}

describe("WebEgressAudit", () => {
	it("aggregates per host with blocked counted separately", () => {
		const { audit } = makeAudit();
		audit.record("Example.com", false);
		audit.record("example.com", false);
		audit.record("example.com", true);
		audit.record("other.net", false);
		expect(audit.summary()).toEqual([
			{ host: "example.com", count: 2, blockedCount: 1, lastSeenMs: 3 },
			{ host: "other.net", count: 1, blockedCount: 0, lastSeenMs: 4 },
		]);
	});

	it("summary sorts most-contacted-first and respects the limit", () => {
		const { audit } = makeAudit();
		audit.record("a.com", false);
		audit.record("b.com", false);
		audit.record("b.com", false);
		expect(audit.summary(1)).toEqual([{ host: "b.com", count: 2, blockedCount: 0, lastSeenMs: 3 }]);
	});

	it("evicts the least-recently-seen host past the cap", () => {
		const { audit } = makeAudit({ maxHosts: 2 });
		audit.record("old.com", false);
		audit.record("mid.com", false);
		audit.record("new.com", false);
		expect(audit.summary().map((r) => r.host)).toEqual(
			expect.arrayContaining(["mid.com", "new.com"]),
		);
		expect(audit.summary()).toHaveLength(2);
	});

	it("debounces the flush — one timer per burst, save on fire", () => {
		const { audit, saves, timers } = makeAudit();
		audit.record("a.com", false);
		audit.record("a.com", false);
		expect(timers).toHaveLength(1);
		expect(saves).toHaveLength(0);
		timers[0]?.();
		expect(saves).toHaveLength(1);
		expect(saves[0]).toEqual([{ host: "a.com", count: 2, blockedCount: 0, lastSeenMs: 2 }]);
	});

	it("mergeSeed adds counts and keeps the max lastSeen", () => {
		const { audit } = makeAudit();
		audit.record("a.com", false);
		audit.mergeSeed([
			{ host: "a.com", count: 5, blockedCount: 2, lastSeenMs: 100 },
			{ host: "b.com", count: 1, blockedCount: 0, lastSeenMs: 50 },
		]);
		expect(audit.summary()).toEqual([
			{ host: "a.com", count: 6, blockedCount: 2, lastSeenMs: 100 },
			{ host: "b.com", count: 1, blockedCount: 0, lastSeenMs: 50 },
		]);
	});

	it("dispose flushes and stops recording", async () => {
		const { audit, saves } = makeAudit();
		audit.record("a.com", false);
		await audit.dispose();
		expect(saves).toHaveLength(1);
		audit.record("b.com", false);
		expect(audit.summary().map((r) => r.host)).toEqual(["a.com"]);
	});
});

describe("parseWebEgressRows", () => {
	it("drops malformed rows", () => {
		const valid = { host: "a.com", count: 1, blockedCount: 0, lastSeenMs: 9 };
		expect(
			parseWebEgressRows([valid, { host: "", count: 1, blockedCount: 0, lastSeenMs: 1 }, "junk"]),
		).toEqual([valid]);
		expect(parseWebEgressRows("nope")).toEqual([]);
	});
});

describe("egress file round-trip", () => {
	let vault: string;

	beforeEach(async () => {
		vault = await mkdtemp(join(tmpdir(), "bs-webegress-"));
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	it("writes then reads rows back; missing file reads empty", async () => {
		const rows = [{ host: "a.com", count: 2, blockedCount: 1, lastSeenMs: 4 }];
		await writeWebEgressRows(vault, rows);
		expect(await readWebEgressRows(vault)).toEqual(rows);
		await rm(vault, { recursive: true, force: true });
		expect(await readWebEgressRows(vault)).toEqual([]);
	});
});
