import { StartupPageKind } from "@brainstorm-os/protocol/shell-prefs";
import { describe, expect, it, vi } from "vitest";
import {
	JOURNAL_APP_ID,
	claimStartupRun,
	runStartupPage,
	todayJournalEntryId,
} from "./startup-page";

function deps(handled: boolean) {
	return {
		openEntity: vi.fn(async () => handled),
		launchApp: vi.fn(async () => undefined),
		now: () => new Date(2026, 9, 18, 9, 30),
	};
}

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => {
			map.set(k, v);
		},
	} as unknown as Storage;
}

describe("startup page runner (7.17)", () => {
	it("opens nothing for the dashboard default (or a missing choice)", async () => {
		const d = deps(true);
		await runStartupPage({ kind: StartupPageKind.Dashboard }, d);
		await runStartupPage(undefined, d);
		expect(d.openEntity).not.toHaveBeenCalled();
		expect(d.launchApp).not.toHaveBeenCalled();
	});

	it("opens a chosen object through intent.open", async () => {
		const d = deps(true);
		await runStartupPage({ kind: StartupPageKind.Object, entityId: "e1", title: "Plan" }, d);
		expect(d.openEntity).toHaveBeenCalledWith("e1");
		expect(d.launchApp).not.toHaveBeenCalled();
	});

	it("opens today's journal entry by its stable local-date id", async () => {
		const d = deps(true);
		await runStartupPage({ kind: StartupPageKind.TodayJournal }, d);
		expect(d.openEntity).toHaveBeenCalledWith("journal-2026-10-18");
		expect(d.launchApp).not.toHaveBeenCalled();
	});

	it("launches Journal fresh (which lands on today) when no handler took the open", async () => {
		const d = deps(false);
		await runStartupPage({ kind: StartupPageKind.TodayJournal }, d);
		expect(d.launchApp).toHaveBeenCalledWith(JOURNAL_APP_ID);
	});

	it("pads the date key and uses local time", () => {
		expect(todayJournalEntryId(new Date(2027, 0, 5, 23, 59))).toBe("journal-2027-01-05");
	});

	it("claims a run once per vault per session", () => {
		const storage = memoryStorage();
		expect(claimStartupRun("v1", storage)).toBe(true);
		expect(claimStartupRun("v1", storage)).toBe(false);
		expect(claimStartupRun("v2", storage)).toBe(true);
		const throwing = {
			getItem: () => {
				throw new Error("blocked");
			},
		} as unknown as Storage;
		expect(claimStartupRun("v1", throwing)).toBe(true);
	});
});
