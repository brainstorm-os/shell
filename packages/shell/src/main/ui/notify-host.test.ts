import {
	DEFAULT_NOTIFICATIONS,
	type NotificationRecord,
} from "@brainstorm-os/protocol/shell-prefs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	UiNotifyHost,
	coerceKind,
	getUiNotifyHost,
	normalizeNotification,
	resetUiNotifyHost,
} from "./notify-host";

afterEach(() => {
	resetUiNotifyHost();
	vi.restoreAllMocks();
});

describe("normalizeNotification", () => {
	it("accepts a minimal { title } and defaults kind to info", () => {
		expect(normalizeNotification("app.a", { title: "Hi" })).toEqual({
			appId: "app.a",
			title: "Hi",
			kind: "info",
		});
	});

	it("keeps a valid kind + body and stamps the verified app id", () => {
		expect(normalizeNotification("app.b", { title: "Done", body: "saved", kind: "success" })).toEqual(
			{ appId: "app.b", title: "Done", body: "saved", kind: "success" },
		);
	});

	it("rejects a missing / empty / non-string title as Invalid", () => {
		for (const bad of [{}, { title: "" }, { title: "   " }, { title: 5 }, null, [], "x"]) {
			expect(() => normalizeNotification("a", bad)).toThrowError(
				expect.objectContaining({ name: "Invalid" }),
			);
		}
	});

	it("rejects a non-string body as Invalid", () => {
		expect(() => normalizeNotification("a", { title: "t", body: 9 })).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});

	it("drops an empty/whitespace body rather than emitting it", () => {
		const n = normalizeNotification("a", { title: "t", body: "   " });
		expect("body" in n).toBe(false);
	});

	it("falls back to info for an unknown kind", () => {
		expect(normalizeNotification("a", { title: "t", kind: "boom" }).kind).toBe("info");
	});

	it("carries a string dedupeKey through and drops an empty one", () => {
		expect(normalizeNotification("a", { title: "t", dedupeKey: "task1#42" }).dedupeKey).toBe(
			"task1#42",
		);
		expect("dedupeKey" in normalizeNotification("a", { title: "t", dedupeKey: "   " })).toBe(false);
		expect("dedupeKey" in normalizeNotification("a", { title: "t" })).toBe(false);
	});

	it("rejects a non-string dedupeKey as Invalid", () => {
		expect(() => normalizeNotification("a", { title: "t", dedupeKey: 9 })).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});

	it("carries a string entityId through, drops an empty one, rejects a non-string", () => {
		expect(normalizeNotification("a", { title: "t", entityId: "ent_1" }).entityId).toBe("ent_1");
		expect("entityId" in normalizeNotification("a", { title: "t", entityId: "   " })).toBe(false);
		expect("entityId" in normalizeNotification("a", { title: "t" })).toBe(false);
		expect(() => normalizeNotification("a", { title: "t", entityId: 9 })).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});

	it("trims and clamps an over-long title/body with an ellipsis", () => {
		const n = normalizeNotification("a", { title: `  ${"x".repeat(500)}  `, body: "y".repeat(5000) });
		expect(n.title.length).toBe(200);
		expect(n.title.endsWith("…")).toBe(true);
		expect((n.body ?? "").length).toBe(1000);
	});
});

describe("coerceKind", () => {
	it("passes through the four known kinds, info otherwise", () => {
		expect(coerceKind("warning")).toBe("warning");
		expect(coerceKind("error")).toBe("error");
		expect(coerceKind(undefined)).toBe("info");
		expect(coerceKind(42)).toBe("info");
	});
});

describe("UiNotifyHost", () => {
	it("always records to history and raises OS-native when not suppressed", () => {
		const history: NotificationRecord[] = [];
		const osNotified: string[] = [];
		const host = new UiNotifyHost();
		host.setDeps({
			getPreferences: () => DEFAULT_NOTIFICATIONS,
			recordHistory: (r) => history.push(r),
			osNotify: (n) => osNotified.push(n.title),
			now: () => 1000,
		});
		const result = host.post({ appId: "a", title: "Saved", kind: "success" });
		expect(result).toEqual({ recorded: true, osNotified: true, suppressed: false, deduped: false });
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			appId: "a",
			title: "Saved",
			kind: "success",
			read: false,
			ts: 1000,
		});
		expect(osNotified).toEqual(["Saved"]);
	});

	it("carries entityId into the history record (center click → intent.open)", () => {
		const history: NotificationRecord[] = [];
		const host = new UiNotifyHost();
		host.setDeps({
			getPreferences: () => DEFAULT_NOTIFICATIONS,
			recordHistory: (r) => history.push(r),
			osNotify: () => {},
			now: () => 1000,
		});
		host.post({ appId: "a", title: "Due", kind: "info", entityId: "ent_1" });
		host.post({ appId: "a", title: "Plain", kind: "info" });
		expect(history[0]?.entityId).toBe("ent_1");
		expect(history[1] && "entityId" in history[1]).toBe(false);
	});

	it("suppresses OS-native for a muted app but still records", () => {
		const history: NotificationRecord[] = [];
		const osNotified: string[] = [];
		const host = new UiNotifyHost();
		host.setDeps({
			getPreferences: () => ({ ...DEFAULT_NOTIFICATIONS, mutes: { a: true } }),
			recordHistory: (r) => history.push(r),
			osNotify: (n) => osNotified.push(n.title),
			now: () => 1000,
		});
		const result = host.post({ appId: "a", title: "Quiet", kind: "info" });
		expect(result).toEqual({ recorded: true, osNotified: false, suppressed: true, deduped: false });
		expect(history).toHaveLength(1);
		expect(osNotified).toEqual([]);
	});

	it("suppresses presentation during a DND window but still records", () => {
		const history: NotificationRecord[] = [];
		const osNotified: string[] = [];
		const host = new UiNotifyHost();
		// DND 22:00–08:00; post at 23:00 local.
		const at2300 = new Date(2026, 0, 1, 23, 0).getTime();
		host.setDeps({
			getPreferences: () => ({
				...DEFAULT_NOTIFICATIONS,
				dnd: { enabled: true, start: "22:00", end: "08:00" },
			}),
			recordHistory: (r) => history.push(r),
			osNotify: (n) => osNotified.push(n.title),
			now: () => at2300,
		});
		const result = host.post({ appId: "a", title: "Night", kind: "info" });
		expect(result.suppressed).toBe(true);
		expect(result.osNotified).toBe(false);
		expect(history).toHaveLength(1);
		expect(osNotified).toEqual([]);
	});

	it("does not raise OS-native when the global toggle is off", () => {
		const osNotified: string[] = [];
		const host = new UiNotifyHost();
		host.setDeps({
			getPreferences: () => ({ ...DEFAULT_NOTIFICATIONS, osNative: false }),
			recordHistory: () => {},
			osNotify: (n) => osNotified.push(n.title),
			now: () => 1000,
		});
		const result = host.post({ appId: "a", title: "NoOs", kind: "info" });
		expect(result).toEqual({ recorded: true, osNotified: false, suppressed: false, deduped: false });
		expect(osNotified).toEqual([]);
	});
});

describe("UiNotifyHost dedupe", () => {
	function makeHost(history: NotificationRecord[], clock: { t: number }) {
		const host = new UiNotifyHost();
		host.setDeps({
			getPreferences: () => DEFAULT_NOTIFICATIONS,
			recordHistory: (r) => history.push(r),
			osNotify: () => {},
			now: () => clock.t,
		});
		return host;
	}

	it("records the same (appId, dedupeKey) once within the window", () => {
		const history: NotificationRecord[] = [];
		const clock = { t: 1000 };
		const host = makeHost(history, clock);

		const first = host.post({ appId: "a", title: "Due", kind: "info", dedupeKey: "t1#5" });
		clock.t = 2000; // a sibling window's scheduler fires ~1s later
		const second = host.post({ appId: "a", title: "Due", kind: "info", dedupeKey: "t1#5" });

		expect(first).toMatchObject({ recorded: true, deduped: false });
		expect(second).toEqual({ recorded: false, osNotified: false, suppressed: false, deduped: true });
		expect(history).toHaveLength(1);
	});

	it("records different dedupeKeys both, and the same key in different apps both", () => {
		const history: NotificationRecord[] = [];
		const host = makeHost(history, { t: 1000 });

		host.post({ appId: "a", title: "Due A", kind: "info", dedupeKey: "t1#5" });
		host.post({ appId: "a", title: "Due B", kind: "info", dedupeKey: "t2#9" });
		host.post({ appId: "b", title: "Due C", kind: "info", dedupeKey: "t1#5" });

		expect(history).toHaveLength(3);
	});

	it("does not dedupe notifications without a dedupeKey", () => {
		const history: NotificationRecord[] = [];
		const host = makeHost(history, { t: 1000 });

		const first = host.post({ appId: "a", title: "Saved", kind: "info" });
		const second = host.post({ appId: "a", title: "Saved", kind: "info" });

		expect(first.recorded).toBe(true);
		expect(second.recorded).toBe(true);
		expect(history).toHaveLength(2);
	});

	it("re-records the same key once the dedupe window has elapsed", () => {
		const history: NotificationRecord[] = [];
		const clock = { t: 1000 };
		const host = makeHost(history, clock);

		host.post({ appId: "a", title: "Due", kind: "info", dedupeKey: "t1#5" });
		clock.t = 1000 + 5 * 60_000 + 1; // just past the 5-min window
		const later = host.post({ appId: "a", title: "Due", kind: "info", dedupeKey: "t1#5" });

		expect(later.deduped).toBe(false);
		expect(history).toHaveLength(2);
	});
});

describe("getUiNotifyHost", () => {
	it("is a stable singleton until reset", () => {
		const a = getUiNotifyHost();
		expect(getUiNotifyHost()).toBe(a);
		resetUiNotifyHost();
		expect(getUiNotifyHost()).not.toBe(a);
	});
});
