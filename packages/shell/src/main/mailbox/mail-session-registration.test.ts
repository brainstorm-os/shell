/**
 * Tests for the vault-session mail sync registration — injected timers, so
 * the schedule (initial delay → pass → interval → pass) is asserted without
 * waiting, plus the per-account error isolation and `stop()` semantics.
 */

import { MAIL_ACCOUNT_TYPE_URL } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { listEnabledMailAccountIds, startMailSessionSync } from "./mail-session-registration";

type Scheduled = { fn: () => void; ms: number; cancelled: boolean };

function makeTimers() {
	const scheduled: Scheduled[] = [];
	return {
		scheduled,
		schedule: (fn: () => void, ms: number): unknown => {
			const entry: Scheduled = { fn, ms, cancelled: false };
			scheduled.push(entry);
			return entry;
		},
		cancel: (handle: unknown): void => {
			(handle as Scheduled).cancelled = true;
		},
		/** Fire the most recently scheduled (un-cancelled) timer and let the
		 *  async pass settle. */
		async fireNext(): Promise<void> {
			const next = scheduled[scheduled.length - 1];
			if (!next || next.cancelled) throw new Error("nothing scheduled");
			next.fn();
			await vi.waitFor(() => {
				if (scheduled[scheduled.length - 1] === next) throw new Error("pass not finished");
			});
		},
	};
}

describe("listEnabledMailAccountIds", () => {
	it("returns only enabled MailAccount rows", () => {
		const rows = new Map([
			["a", { id: "a", properties: { enabled: true } }],
			["b", { id: "b", properties: { enabled: false } }],
			["c", { id: "c", properties: {} }],
		]);
		const repo = {
			idsByTypes: (types: readonly string[]) =>
				types.includes(MAIL_ACCOUNT_TYPE_URL) ? [...rows.keys()] : [],
			get: (id: string) => rows.get(id) ?? null,
		};
		expect(listEnabledMailAccountIds(repo)).toEqual(["a"]);
	});
});

describe("startMailSessionSync", () => {
	it("runs an initial pass after the delay, then reschedules on the interval", async () => {
		const timers = makeTimers();
		const syncAccount = vi.fn().mockResolvedValue({});
		const handle = startMailSessionSync({
			listEnabledAccountIds: async () => ["acc-1", "acc-2"],
			syncAccount,
			intervalMs: 900_000,
			initialDelayMs: 5_000,
			schedule: timers.schedule,
			cancel: timers.cancel,
		});
		expect(timers.scheduled[0]?.ms).toBe(5_000);
		expect(syncAccount).not.toHaveBeenCalled();

		await timers.fireNext();
		expect(syncAccount.mock.calls.map((c) => c[0])).toEqual(["acc-1", "acc-2"]);
		expect(timers.scheduled[1]?.ms).toBe(900_000);

		await timers.fireNext();
		expect(syncAccount).toHaveBeenCalledTimes(4);
		handle.stop();
	});

	it("isolates per-account failures and keeps the loop alive", async () => {
		const timers = makeTimers();
		const log = vi.fn();
		const syncAccount = vi.fn().mockRejectedValueOnce(new Error("imap down")).mockResolvedValue({});
		const handle = startMailSessionSync({
			listEnabledAccountIds: async () => ["bad", "good"],
			syncAccount,
			schedule: timers.schedule,
			cancel: timers.cancel,
			log,
		});
		await timers.fireNext();
		expect(syncAccount).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("bad"));
		// The next interval is still scheduled despite the failure.
		expect(timers.scheduled).toHaveLength(2);
		handle.stop();
	});

	it("survives a listing failure", async () => {
		const timers = makeTimers();
		const log = vi.fn();
		const handle = startMailSessionSync({
			listEnabledAccountIds: () => Promise.reject(new Error("no session")),
			syncAccount: vi.fn(),
			schedule: timers.schedule,
			cancel: timers.cancel,
			log,
		});
		await timers.fireNext();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("listing accounts failed"));
		expect(timers.scheduled).toHaveLength(2);
		handle.stop();
	});

	it("stop() cancels the pending timer and halts mid-pass account iteration", async () => {
		const timers = makeTimers();
		const handle = startMailSessionSync({
			listEnabledAccountIds: async () => ["a", "b"],
			syncAccount: vi.fn(async (id: string) => {
				if (id === "a") handle.stop();
			}),
			schedule: timers.schedule,
			cancel: timers.cancel,
		});
		const initial = timers.scheduled[0];
		expect(initial).toBeDefined();
		initial?.fn();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Stopped during "a": "b" never synced, nothing rescheduled, the
		// (already-fired) initial timer is marked cancelled by stop().
		expect(timers.scheduled).toHaveLength(1);
	});

	it("stop() before the initial delay cancels the first pass entirely", () => {
		const timers = makeTimers();
		const syncAccount = vi.fn();
		const handle = startMailSessionSync({
			listEnabledAccountIds: async () => ["a"],
			syncAccount,
			schedule: timers.schedule,
			cancel: timers.cancel,
		});
		handle.stop();
		expect(timers.scheduled[0]?.cancelled).toBe(true);
		expect(syncAccount).not.toHaveBeenCalled();
	});
});
