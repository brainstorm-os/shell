// @vitest-environment jsdom
import type { CalDavService } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntitiesService, EntityRecord } from "../../storage/runtime";
import { flush, renderInto } from "../../test/render";
import { CALDAV_ACCOUNT_TYPE, CALDAV_CALENDAR_TYPE, CalDavDialog } from "./caldav-dialog";

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	await handle?.unmount();
	handle = null;
	document.body.replaceChildren();
});

function record(id: string, type: string, properties: Record<string, unknown>): EntityRecord {
	return { id, type, properties, createdAt: 0, updatedAt: 0 };
}

function fakeEntities(rows: EntityRecord[]): EntitiesService {
	return {
		get: (id) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
		query: (q) =>
			Promise.resolve(rows.filter((r) => (typeof q.type === "string" ? r.type === q.type : true))),
		create: () => Promise.reject(new Error("not under test")),
		update: () => Promise.reject(new Error("not under test")),
		delete: () => Promise.reject(new Error("not under test")),
	};
}

function fakeCalDav(overrides: Partial<CalDavService> = {}): CalDavService {
	return {
		connect: vi.fn().mockResolvedValue({ accountId: "a1", calendars: [] }),
		listCalendars: vi.fn().mockResolvedValue([]),
		addCalendar: vi.fn().mockResolvedValue({ calendarRef: "c1" }),
		syncNow: vi.fn().mockResolvedValue({
			calendarRef: "c1",
			pulled: 3,
			pushedCreated: 1,
			pushedUpdated: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			conflicts: 1,
			startedAt: "2026-06-11T09:00:00.000Z",
			finishedAt: "2026-06-11T09:00:01.000Z",
		}),
		disconnect: vi.fn().mockResolvedValue({ ok: true }),
		...overrides,
	};
}

describe("CalDavDialog", () => {
	it("shows the connect form when no account exists and never echoes the password", async () => {
		handle = await renderInto(
			<CalDavDialog caldav={fakeCalDav()} entities={fakeEntities([])} onClose={() => {}} />,
		);
		await flush();
		const inputs = handle.container.querySelectorAll("input");
		expect(inputs).toHaveLength(3);
		expect(inputs[2]?.type).toBe("password");
		expect(handle.container.textContent).toContain("Server URL");
	});

	it("lists subscribed calendars and runs syncNow, surfacing the conflict count", async () => {
		const caldav = fakeCalDav();
		const notify = vi.fn();
		const rows = [
			record("a1", CALDAV_ACCOUNT_TYPE, {
				displayName: "Fastmail",
				username: "mira",
				enabled: true,
			}),
			record("c1", CALDAV_CALENDAR_TYPE, {
				accountRef: "a1",
				url: "https://dav.example.com/cal/work/",
				displayName: "Work",
			}),
		];
		handle = await renderInto(
			<CalDavDialog
				caldav={caldav}
				entities={fakeEntities(rows)}
				onClose={() => {}}
				notify={notify}
			/>,
		);
		await flush();
		expect(handle.container.textContent).toContain("Work");

		const syncButton = [...handle.container.querySelectorAll("button")].find(
			(b) => b.textContent === "Sync now",
		);
		expect(syncButton).toBeDefined();
		syncButton?.click();
		await flush();
		expect(caldav.syncNow).toHaveBeenCalledWith({ calendarRef: "c1" });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("3 pulled"));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("1 conflict resolved"));
	});

	it("a disabled account falls back to the connect form", async () => {
		const rows = [
			record("a1", CALDAV_ACCOUNT_TYPE, {
				displayName: "Old",
				username: "mira",
				enabled: false,
			}),
		];
		handle = await renderInto(
			<CalDavDialog caldav={fakeCalDav()} entities={fakeEntities(rows)} onClose={() => {}} />,
		);
		await flush();
		expect(handle.container.querySelectorAll("input")).toHaveLength(3);
	});
});
