import type { ReminderDef } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { ReminderRunner, type ReminderStore } from "./reminder-runner";

const T0 = Date.UTC(2026, 5, 6, 9, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function reminder(over: Partial<ReminderDef> = {}): ReminderDef {
	return { subject: "Stand-up", dueAt: iso(T0), ...over };
}

function fakeStore(initial: Record<string, ReminderDef> = {}): ReminderStore & {
	saved: Record<string, ReminderDef>;
} {
	const saved: Record<string, ReminderDef> = { ...initial };
	return {
		saved,
		load: vi.fn(async (id) => saved[id] ?? null),
		save: vi.fn(async (id, r) => {
			saved[id] = r;
		}),
	};
}

describe("ReminderRunner", () => {
	it("fires a due reminder by posting its notification", async () => {
		const store = fakeStore({ r1: reminder({ target: "e1" }) });
		const notify = vi.fn(async () => {});
		const runner = new ReminderRunner({ store, notify });
		expect(await runner.fire("r1")).toBe(true);
		expect(notify).toHaveBeenCalledWith({ title: "Stand-up", target: "e1" });
	});

	it("does not fire a missing reminder", async () => {
		const store = fakeStore();
		const notify = vi.fn(async () => {});
		const runner = new ReminderRunner({ store, notify });
		expect(await runner.fire("gone")).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("does not fire a completed one-shot (defensive against a stale fire)", async () => {
		const store = fakeStore({ r1: reminder({ completedAt: iso(T0) }) });
		const notify = vi.fn(async () => {});
		const runner = new ReminderRunner({ store, notify });
		expect(await runner.fire("r1")).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("snooze persists the transition and returns the new reminder", async () => {
		const store = fakeStore({ r1: reminder({ completedAt: iso(T0) }) });
		const runner = new ReminderRunner({ store, notify: vi.fn() });
		const next = await runner.snooze("r1", T0 + DAY);
		expect(next?.snoozedUntil).toBe(iso(T0 + DAY));
		expect(next?.completedAt).toBeUndefined();
		expect(store.saved.r1?.snoozedUntil).toBe(iso(T0 + DAY));
	});

	it("complete persists the transition", async () => {
		const store = fakeStore({ r1: reminder() });
		const runner = new ReminderRunner({ store, notify: vi.fn() });
		const next = await runner.complete("r1", T0 + DAY);
		expect(next?.completedAt).toBe(iso(T0 + DAY));
		expect(store.saved.r1?.completedAt).toBe(iso(T0 + DAY));
	});

	it("configFor exposes the reminder's schedule (null when stopped)", async () => {
		const runner = new ReminderRunner({ store: fakeStore(), notify: vi.fn() });
		expect(runner.configFor(reminder())).toEqual({ oneShotAt: T0 });
		expect(runner.configFor(reminder({ completedAt: iso(T0) }))).toBeNull();
	});
});
