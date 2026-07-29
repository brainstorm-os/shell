import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppearanceMode, AppearanceSlot } from "@brainstorm-os/protocol/appearance";
import {
	DateStylePref,
	HeaderControlId,
	HourCyclePref,
	isHeaderControlVisible,
	isWithinDnd,
} from "@brainstorm-os/protocol/shell-prefs";
import { OsHandoffConsent } from "@brainstorm-os/sdk-types";
import { ThemeName } from "@brainstorm-os/tokens";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ICON_FOOTPRINT_H,
	ICON_FOOTPRINT_W,
	footprintsOverlap,
} from "../../shared/dashboard-icon-grid";
import { placeDashboardIcon } from "../dev/seed-demo-apps";
import { YDocStore } from "../storage/ydoc-store";
import { DASHBOARD_DOC_ID, DashboardStore, applyLegacyMigration } from "./dashboard-store";

describe("DashboardStore", () => {
	let vaultDir: string;
	let yStore: YDocStore;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-dashboard-"));
		yStore = new YDocStore(vaultDir);
	});

	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("opens with the dark slot active by default (Auto mode + Dark fallback)", async () => {
		const store = await DashboardStore.open(yStore);
		const snap = store.snapshot();
		expect(snap.wallpaper).toEqual({ kind: "solid", value: "#161616" });
		expect(snap.theme).toBe(ThemeName.DefaultDark);
		expect(snap.appearance.mode).toBe(AppearanceMode.Auto);
		expect(snap.appearance.light.theme).toBe(ThemeName.DefaultLight);
		expect(snap.appearance.dark.theme).toBe(ThemeName.DefaultDark);
		expect(snap.icons).toEqual({});
		expect(snap.widgets).toEqual({});
		await store.close();
	});

	it("snapshot(slot) returns the requested slot's pair as the active mirror", async () => {
		const store = await DashboardStore.open(yStore);
		const light = store.snapshot(AppearanceSlot.Light);
		const dark = store.snapshot(AppearanceSlot.Dark);
		expect(light.theme).toBe(ThemeName.DefaultLight);
		expect(light.wallpaper.value).toBe("#f5f3ef");
		expect(dark.theme).toBe(ThemeName.DefaultDark);
		expect(dark.wallpaper.value).toBe("#161616");
		await store.close();
	});

	it("setTheme routes a dark theme into the dark slot regardless of mode", async () => {
		const store = await DashboardStore.open(yStore);
		store.setTheme(ThemeName.Midnight);
		await store.flush();
		await store.close();

		const reopened = await DashboardStore.open(yStore);
		const snap = reopened.snapshot();
		expect(snap.appearance.dark.theme).toBe(ThemeName.Midnight);
		// Light slot stays at the built-in default — a dark theme cannot
		// corrupt the light slot.
		expect(snap.appearance.light.theme).toBe(ThemeName.DefaultLight);
		await reopened.close();
	});

	it("setTheme routes a light theme into the light slot regardless of mode", async () => {
		const store = await DashboardStore.open(yStore);
		store.setTheme(ThemeName.Sepia);
		await store.flush();
		const snap = store.snapshot(AppearanceSlot.Light);
		expect(snap.appearance.light.theme).toBe(ThemeName.Sepia);
		expect(snap.appearance.dark.theme).toBe(ThemeName.DefaultDark);
		await store.close();
	});

	it("batch() coalesces many mutations into a single subscriber notification", async () => {
		const store = await DashboardStore.open(yStore);
		let notifications = 0;
		const unsubscribe = store.subscribe(() => {
			notifications += 1;
		});
		// subscribe() fires once synchronously with the initial snapshot.
		expect(notifications).toBe(1);

		await store.batch(async () => {
			store.upsertIcon("a", { x: 0, y: 0, kind: "app", target: "app.a", label: "A" });
			store.upsertIcon("b", { x: 1, y: 0, kind: "app", target: "app.b", label: "B" });
			store.upsertIcon("c", { x: 2, y: 0, kind: "app", target: "app.c", label: "C" });
		});

		// One coalesced notification for the whole batch, not one per upsert.
		expect(notifications).toBe(2);
		expect(Object.keys(store.snapshot().icons).sort()).toEqual(["a", "b", "c"]);

		unsubscribe();
		await store.flush();
		await store.close();
	});

	it("setAppearanceMode persists and re-reads", async () => {
		const store = await DashboardStore.open(yStore);
		store.setAppearanceMode(AppearanceMode.Light);
		await store.flush();
		await store.close();

		const reopened = await DashboardStore.open(yStore);
		expect(reopened.snapshot().appearance.mode).toBe(AppearanceMode.Light);
		await reopened.close();
	});

	it("setAppearancePair writes theme+wallpaper into the chosen slot atomically", async () => {
		const store = await DashboardStore.open(yStore);
		store.setAppearancePair(AppearanceSlot.Light, {
			theme: ThemeName.Sepia,
			wallpaper: { kind: "gradient", value: "linear-gradient(0deg,#fff,#eee)" },
		});
		await store.flush();
		const snap = store.snapshot(AppearanceSlot.Light);
		expect(snap.appearance.light.theme).toBe(ThemeName.Sepia);
		expect(snap.appearance.light.wallpaper).toEqual({
			kind: "gradient",
			value: "linear-gradient(0deg,#fff,#eee)",
		});
		// The dark slot is untouched.
		expect(snap.appearance.dark.theme).toBe(ThemeName.DefaultDark);
		await store.close();
	});

	it("setOsHandoffConsent persists granted/denied, clears on null, re-reads", async () => {
		const store = await DashboardStore.open(yStore);
		expect(store.snapshot().osHandoffConsent).toEqual({});
		store.setOsHandoffConsent("scheme:https", OsHandoffConsent.Granted);
		store.setOsHandoffConsent("ext:pdf", OsHandoffConsent.Denied);
		store.setOsHandoffConsent("scheme:bogus", OsHandoffConsent.Granted);
		store.setOsHandoffConsent("scheme:bogus", null); // clear
		await store.flush();
		await store.close();

		const reopened = await DashboardStore.open(yStore);
		expect(reopened.snapshot().osHandoffConsent).toEqual({
			"scheme:https": OsHandoffConsent.Granted,
			"ext:pdf": OsHandoffConsent.Denied,
		});
		await reopened.close();
	});

	it("setContributorDisabled toggles the action-surface disabled set (doc 63 / AS-4)", async () => {
		const store = await DashboardStore.open(yStore);
		expect(store.snapshot().disabledContributors).toEqual([]);
		store.setContributorDisabled("io.example.agent", true);
		store.setContributorDisabled("io.example.other", true);
		store.setContributorDisabled("io.example.other", false); // re-enable
		await store.flush();
		await store.close();

		const reopened = await DashboardStore.open(yStore);
		expect(reopened.snapshot().disabledContributors).toEqual(["io.example.agent"]);
		await reopened.close();
	});

	it("setTheme broadcasts a snapshot update to subscribers", async () => {
		const store = await DashboardStore.open(yStore);
		const seen: string[] = [];
		const unsubscribe = store.subscribe((snap) => seen.push(snap.appearance.light.theme));
		store.setTheme(ThemeName.Sepia);
		await store.flush();
		expect(seen).toContain(ThemeName.Sepia);
		unsubscribe();
		await store.close();
	});

	it("unknown theme values stored under the legacy key fall back to slot defaults", async () => {
		const store = await DashboardStore.open(yStore);
		// Simulate a corrupted on-disk value by writing directly to the Y.Map
		// the store reads from. Pre-pair-slots builds wrote `appearance.theme`;
		// migration should ignore the garbage and use the built-in defaults.
		(store as unknown as { doc: import("yjs").Doc }).doc
			.getMap<unknown>("appearance")
			.set("theme", "not-a-real-theme");
		await store.flush();
		const snap = store.snapshot();
		expect(snap.theme).toBe(ThemeName.DefaultDark);
		expect(snap.appearance.light.theme).toBe(ThemeName.DefaultLight);
		expect(snap.appearance.dark.theme).toBe(ThemeName.DefaultDark);
		await store.close();
	});

	it("setWallpaper(no slot) targets the dark slot by default (Auto fallback)", async () => {
		const store = await DashboardStore.open(yStore);
		store.setWallpaper({ kind: "gradient", value: "linear-gradient(0deg,#fff,#000)" });
		await store.flush();
		await store.close();

		const reopened = await DashboardStore.open(yStore);
		const snap = reopened.snapshot();
		expect(snap.appearance.dark.wallpaper).toEqual({
			kind: "gradient",
			value: "linear-gradient(0deg,#fff,#000)",
		});
		// The light slot keeps its default wallpaper.
		expect(reopened.snapshot(AppearanceSlot.Light).wallpaper.value).toBe("#f5f3ef");
		await reopened.close();
	});

	it("setWallpaper(slot) writes only into that slot", async () => {
		const store = await DashboardStore.open(yStore);
		store.setWallpaper({ kind: "image", value: "wallpapers/forest.jpg" }, AppearanceSlot.Light);
		await store.flush();
		const snap = store.snapshot(AppearanceSlot.Light);
		expect(snap.appearance.light.wallpaper.value).toBe("wallpapers/forest.jpg");
		// Dark slot wallpaper is untouched.
		expect(snap.appearance.dark.wallpaper.value).toBe("#161616");
		await store.close();
	});

	it("upsertIcon stores all fields and moveIcon updates coordinates", async () => {
		const store = await DashboardStore.open(yStore);
		store.upsertIcon("icon_notes", {
			x: 40,
			y: 80,
			kind: "app",
			target: "brainstorm.notes",
			label: "Notes",
		});
		store.moveIcon("icon_notes", 120, 200);
		await store.flush();
		expect(store.snapshot().icons.icon_notes).toEqual({
			x: 120,
			y: 200,
			kind: "app",
			target: "brainstorm.notes",
			label: "Notes",
		});
		await store.close();
	});

	it("removeIcon erases the record", async () => {
		const store = await DashboardStore.open(yStore);
		store.upsertIcon("icon_x", {
			x: 0,
			y: 0,
			kind: "entity",
			target: "ent_42",
			label: "Plan",
		});
		store.removeIcon("icon_x");
		await store.flush();
		expect(store.snapshot().icons).toEqual({});
		await store.close();
	});

	it("removing an APP icon dismisses it so the seeder can't resurrect it", async () => {
		const store = await DashboardStore.open(yStore);
		store.upsertIcon("icon_io.brainstorm.agent_demo", {
			x: 0,
			y: 0,
			kind: "app",
			target: "io.brainstorm.agent",
			label: "Agent",
		});
		expect(store.isAppIconDismissed("io.brainstorm.agent")).toBe(false);

		store.removeIcon("icon_io.brainstorm.agent_demo");
		expect(store.snapshot().icons).toEqual({});
		expect(store.isAppIconDismissed("io.brainstorm.agent")).toBe(true);

		// The seeder re-pins via placeDashboardIcon; once dismissed it no-ops.
		const repinned = placeDashboardIcon(store, "io.brainstorm.agent", "Agent");
		expect(repinned).toBe(false);
		expect(store.snapshot().icons).toEqual({});
		await store.close();
	});

	it("the dismissal survives a reload and explicit re-pin clears it", async () => {
		const store = await DashboardStore.open(yStore);
		store.upsertIcon("icon_io.brainstorm.agent_demo", {
			x: 0,
			y: 0,
			kind: "app",
			target: "io.brainstorm.agent",
			label: "Agent",
		});
		store.removeIcon("icon_io.brainstorm.agent_demo");
		await store.flush();
		await store.close();

		const reopened = await DashboardStore.open(yStore);
		expect(reopened.isAppIconDismissed("io.brainstorm.agent")).toBe(true);

		// Pinning the app again (app grid) is an explicit "I want it back".
		reopened.upsertIcon("icon_io.brainstorm.agent_pin", {
			x: 0,
			y: 0,
			kind: "app",
			target: "io.brainstorm.agent",
			label: "Agent",
		});
		expect(reopened.isAppIconDismissed("io.brainstorm.agent")).toBe(false);
		expect(placeDashboardIcon(reopened, "io.brainstorm.agent", "Agent")).toBe(false);
		await reopened.close();
	});

	it("removing an entity pin does not dismiss any app", async () => {
		const store = await DashboardStore.open(yStore);
		store.upsertIcon("icon_pin", {
			x: 0,
			y: 0,
			kind: "entity",
			target: "ent_42",
			label: "Plan",
		});
		store.removeIcon("icon_pin");
		expect(store.isAppIconDismissed("ent_42")).toBe(false);
		await store.close();
	});

	it("iconGridMigrated defaults false and persists once set", async () => {
		const store = await DashboardStore.open(yStore);
		expect(store.snapshot().iconGridMigrated).toBe(false);
		store.setIconGridMigrated();
		await store.flush();
		expect(store.snapshot().iconGridMigrated).toBe(true);
		await store.close();

		// Survives a reload from the persisted tail.
		const reopened = await DashboardStore.open(yStore);
		expect(reopened.snapshot().iconGridMigrated).toBe(true);
		await reopened.close();
	});

	it("upsertWidget + setWidgetPaused", async () => {
		const store = await DashboardStore.open(yStore);
		store.upsertWidget("w1", {
			appId: "brainstorm.clock",
			kind: "clock",
			x: 10,
			y: 10,
			w: 200,
			h: 80,
			paused: false,
			collapsed: false,
		});
		store.setWidgetPaused("w1", true);
		await store.flush();
		expect(store.snapshot().widgets.w1?.paused).toBe(true);
		await store.close();
	});

	it("upsertWidget persists collapsed across re-open", async () => {
		const first = await DashboardStore.open(yStore);
		first.upsertWidget("w1", {
			appId: "brainstorm.clock",
			kind: "clock",
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			paused: false,
			collapsed: true,
		});
		await first.flush();
		await first.close();

		const reopened = await DashboardStore.open(yStore);
		expect(reopened.snapshot().widgets.w1?.collapsed).toBe(true);
		await reopened.close();
	});

	it("removeWidget erases the record", async () => {
		const store = await DashboardStore.open(yStore);
		store.upsertWidget("w1", {
			appId: "a",
			kind: "k",
			x: 0,
			y: 0,
			w: 1,
			h: 1,
			paused: false,
			collapsed: false,
		});
		store.removeWidget("w1");
		await store.flush();
		expect(store.snapshot().widgets).toEqual({});
		await store.close();
	});

	it("subscribe replays current snapshot and fires on subsequent changes", async () => {
		const store = await DashboardStore.open(yStore);
		const snapshots: Array<ReturnType<typeof store.snapshot>> = [];
		const unsubscribe = store.subscribe((snap) => snapshots.push(snap));
		store.upsertIcon("icon_a", {
			x: 0,
			y: 0,
			kind: "app",
			target: "x",
			label: "X",
		});
		await store.flush();
		expect(snapshots.length).toBeGreaterThanOrEqual(2);
		expect(snapshots[0]?.icons.icon_a).toBeUndefined();
		expect(snapshots[snapshots.length - 1]?.icons.icon_a?.label).toBe("X");
		unsubscribe();
		await store.close();
	});

	it("persists changes via the YDocStore (re-open recovers state)", async () => {
		const first = await DashboardStore.open(yStore);
		first.upsertIcon("a", { x: 1, y: 2, kind: "app", target: "io.x", label: "X" });
		first.upsertWidget("w", {
			appId: "io.x",
			kind: "list",
			x: 0,
			y: 0,
			w: 100,
			h: 100,
			paused: false,
			collapsed: false,
		});
		first.setWallpaper({ kind: "image", value: "wallpapers/forest.jpg" });
		await first.flush();
		await first.close();

		// Inspect the on-disk file via the YDocStore directly — wallpapers
		// live in the dark slot's pair map now (Auto default fallback).
		const reload = await yStore.load(DASHBOARD_DOC_ID);
		const darkPair = reload.doc.getMap("appearance").get("dark");
		expect((darkPair as import("yjs").Map<unknown>).get("wp_kind")).toBe("image");

		const second = await DashboardStore.open(yStore);
		const snap = second.snapshot();
		expect(snap.wallpaper.value).toBe("wallpapers/forest.jpg");
		expect(snap.icons.a?.label).toBe("X");
		expect(snap.widgets.w?.appId).toBe("io.x");
		await second.close();
	});

	it("legacy single-theme state migrates into the matching pair slot", async () => {
		// Seed a doc with the pre-pair-slots shape: top-level wallpaper
		// map + appearance.theme. Build a fresh store, set up the legacy
		// keys directly on the underlying doc, close, then re-open and
		// confirm `readAppearance()` placed them into the right slot and
		// did NOT overwrite either slot's default fallback.
		const first = await DashboardStore.open(yStore);
		const doc = (first as unknown as { doc: import("yjs").Doc }).doc;
		doc.transact(() => {
			const wp = doc.getMap("wallpaper");
			wp.set("kind", "gradient");
			wp.set("value", "linear-gradient(180deg, #fff, #eee)");
			doc.getMap("appearance").set("theme", ThemeName.Sepia);
		});
		await first.flush();
		await first.close();

		const reopened = await DashboardStore.open(yStore);
		const snap = reopened.snapshot(AppearanceSlot.Light);
		// Legacy theme (Sepia, light scheme) → Light slot.
		expect(snap.appearance.light.theme).toBe(ThemeName.Sepia);
		expect(snap.appearance.light.wallpaper.value).toBe("linear-gradient(180deg, #fff, #eee)");
		// Dark slot falls to the built-in default.
		expect(snap.appearance.dark.theme).toBe(ThemeName.DefaultDark);
		await reopened.close();
	});

	it("applyLegacyMigration: legacy light theme seeds Light, opposite slot stays default (pure)", () => {
		const result = applyLegacyMigration({ light: null, dark: null }, ThemeName.Sepia, {
			kind: "solid",
			value: "#fafafa",
		});
		expect(result.light.theme).toBe(ThemeName.Sepia);
		expect(result.light.wallpaper.value).toBe("#fafafa");
		expect(result.dark.theme).toBe(ThemeName.DefaultDark);
	});

	it("applyLegacyMigration: legacy dark theme seeds Dark, opposite slot stays default", () => {
		const result = applyLegacyMigration({ light: null, dark: null }, ThemeName.Midnight, {
			kind: "solid",
			value: "#0a0a0a",
		});
		expect(result.dark.theme).toBe(ThemeName.Midnight);
		expect(result.dark.wallpaper.value).toBe("#0a0a0a");
		expect(result.light.theme).toBe(ThemeName.DefaultLight);
	});

	it("applyLegacyMigration: legacy wallpaper without a theme lands in Dark", () => {
		const result = applyLegacyMigration({ light: null, dark: null }, null, {
			kind: "image",
			value: "wallpapers/x.jpg",
		});
		expect(result.dark.wallpaper.value).toBe("wallpapers/x.jpg");
		expect(result.dark.theme).toBe(ThemeName.DefaultDark);
		expect(result.light).toEqual({
			theme: ThemeName.DefaultLight,
			wallpaper: { kind: "solid", value: "#f5f3ef" },
		});
	});

	it("applyLegacyMigration: explicit pairs are not overwritten by legacy state", () => {
		const explicitLight = {
			theme: ThemeName.Sepia,
			wallpaper: { kind: "solid" as const, value: "#fff8e0" },
		};
		const explicitDark = {
			theme: ThemeName.Midnight,
			wallpaper: { kind: "solid" as const, value: "#091022" },
		};
		const result = applyLegacyMigration(
			{ light: explicitLight, dark: explicitDark },
			ThemeName.DefaultLight,
			{ kind: "solid", value: "#zzzzz" },
		);
		expect(result.light).toEqual(explicitLight);
		expect(result.dark).toEqual(explicitDark);
	});

	it("close() drops listeners and stops persisting further updates", async () => {
		const store = await DashboardStore.open(yStore);
		let calls = 0;
		store.subscribe(() => calls++);
		await store.close();
		const before = calls;
		// After close, mutating internal doc shouldn't call listeners or persist
		store.upsertIcon("orphan", { x: 0, y: 0, kind: "app", target: "x", label: "y" });
		await store.flush();
		expect(calls).toBe(before);
	});
});

describe("DashboardStore — shell prefs (locale / regional / chrome / notifications)", () => {
	let vaultDir: string;
	let yStore: YDocStore;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-prefs-"));
		yStore = new YDocStore(vaultDir);
	});

	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("defaults: language=en, all regional auto, chrome empty/clock-default, notifications default", async () => {
		const store = await DashboardStore.open(yStore);
		const snap = store.snapshot();
		expect(snap.locale).toEqual({ language: "en" });
		expect(snap.regional).toEqual({
			hourCycle: HourCyclePref.Auto,
			dateStyle: DateStylePref.Auto,
			firstDayOfWeek: "auto",
			numberLocale: "auto",
			timezone: "auto",
		});
		expect(snap.chrome.visibility).toEqual({});
		expect(snap.chrome.clock).toEqual({
			show: true,
			showSeconds: false,
			hourCycle: HourCyclePref.Auto,
		});
		expect(snap.notifications.osNative).toBe(true);
		expect(snap.notifications.dnd.enabled).toBe(false);
		expect(snap.notifications.mutes).toEqual({});
		expect(snap.notificationHistory).toEqual([]);
		await store.close();
	});

	it("setLanguage + setRegional persist across reopen", async () => {
		const store = await DashboardStore.open(yStore);
		store.setLanguage("de-AT");
		store.setRegional({
			hourCycle: HourCyclePref.H23,
			firstDayOfWeek: 1,
			timezone: "Europe/Berlin",
		});
		await store.flush();
		await store.close();

		const reopened = await DashboardStore.open(yStore);
		const snap = reopened.snapshot();
		expect(snap.locale.language).toBe("de-AT");
		expect(snap.regional.hourCycle).toBe(HourCyclePref.H23);
		expect(snap.regional.firstDayOfWeek).toBe(1);
		expect(snap.regional.timezone).toBe("Europe/Berlin");
		expect(snap.regional.dateStyle).toBe(DateStylePref.Auto);
		await reopened.close();
	});

	it("header visibility + clock prefs round-trip; resetChrome restores defaults", async () => {
		const store = await DashboardStore.open(yStore);
		store.setHeaderControlVisible(HeaderControlId.Cheatsheet, false);
		store.setHeaderControlVisible(HeaderControlId.Help, false);
		store.setClockPrefs({ showSeconds: true, hourCycle: HourCyclePref.H12 });
		await store.flush();

		let snap = store.snapshot();
		expect(snap.chrome.visibility[HeaderControlId.Cheatsheet]).toBe(false);
		expect(isHeaderControlVisible(snap.chrome, HeaderControlId.Cheatsheet)).toBe(false);
		expect(isHeaderControlVisible(snap.chrome, HeaderControlId.Settings)).toBe(true);
		expect(snap.chrome.clock.showSeconds).toBe(true);
		expect(snap.chrome.clock.hourCycle).toBe(HourCyclePref.H12);

		store.resetChrome();
		await store.flush();
		snap = store.snapshot();
		expect(snap.chrome.visibility).toEqual({});
		expect(snap.chrome.clock).toEqual({
			show: true,
			showSeconds: false,
			hourCycle: HourCyclePref.Auto,
		});
		await store.close();
	});

	it("notification prefs: osNative toggle, dnd patch, per-app mute add/remove", async () => {
		const store = await DashboardStore.open(yStore);
		store.setNotificationsOsNative(false);
		store.setDnd({ enabled: true, start: "23:00", end: "07:30" });
		store.setAppNotificationMuted("io.example.tasks", true);
		store.setAppNotificationMuted("io.example.calendar", true);
		store.setAppNotificationMuted("io.example.calendar", false);
		await store.flush();

		const snap = store.snapshot();
		expect(snap.notifications.osNative).toBe(false);
		expect(snap.notifications.dnd).toEqual({ enabled: true, start: "23:00", end: "07:30" });
		expect(snap.notifications.mutes).toEqual({ "io.example.tasks": true });
		await store.close();
	});

	it("notification history: push appends, caps at 200 drop-oldest, read flags, clear", async () => {
		const store = await DashboardStore.open(yStore);
		for (let i = 0; i < 205; i += 1) {
			store.pushNotification({
				id: `n${i}`,
				appId: "io.example.tasks",
				title: `Task ${i}`,
				kind: "info",
				ts: 1000 + i,
				read: false,
			});
		}
		await store.flush();

		let history = store.snapshot().notificationHistory;
		expect(history).toHaveLength(200);
		expect(history[0]?.id).toBe("n5");
		expect(history[history.length - 1]?.id).toBe("n204");

		store.markNotificationRead("n10");
		await store.flush();
		history = store.snapshot().notificationHistory;
		expect(history.find((r) => r.id === "n10")?.read).toBe(true);
		expect(history.find((r) => r.id === "n11")?.read).toBe(false);

		store.markAllNotificationsRead();
		await store.flush();
		expect(store.snapshot().notificationHistory.every((r) => r.read)).toBe(true);

		store.clearNotificationHistory();
		await store.flush();
		expect(store.snapshot().notificationHistory).toEqual([]);
		await store.close();
	});

	// POLISH-LAY-6 — the install path, end to end over the real store. Main
	// used to place onto a fictional 12-column grid of 1×1 cells while the
	// renderer stores 8px units and paints an ICON_FOOTPRINT_W × _H box per
	// icon, so a newly installed app landed ON TOP of Notes.
	it("places an installed app's icon clear of every existing icon's footprint", async () => {
		const store = await DashboardStore.open(yStore);
		// The seeded fleet as captured on the real dashboard.
		const seeded = [
			{ id: "io.brainstorm.notes", x: 0, y: 0 },
			{ id: "io.brainstorm.files", x: 11, y: 0 },
			{ id: "io.brainstorm.database", x: 22, y: 0 },
			{ id: "io.brainstorm.books", x: 0, y: 14 },
		];
		for (const app of seeded) {
			store.upsertIcon(`icon_${app.id}_demo`, {
				x: app.x,
				y: app.y,
				kind: "app",
				target: app.id,
				label: app.id,
			});
		}

		expect(placeDashboardIcon(store, "studio.northbound.client-pulse", "Client Pulse")).toBe(true);
		const placed = store.snapshot().icons["icon_studio.northbound.client-pulse_demo"];
		expect(placed).toBeDefined();
		if (!placed) throw new Error("unreachable");
		for (const app of seeded) {
			expect(footprintsOverlap({ col: placed.x, row: placed.y }, { col: app.x, row: app.y })).toBe(
				false,
			);
		}

		// A second install stacks on neither the fleet nor the first newcomer.
		expect(placeDashboardIcon(store, "io.brainstorm.hello", "Hello")).toBe(true);
		const second = store.snapshot().icons["icon_io.brainstorm.hello_demo"];
		if (!second) throw new Error("unreachable");
		for (const other of [...seeded.map((a) => ({ x: a.x, y: a.y })), placed]) {
			expect(footprintsOverlap({ col: second.x, row: second.y }, { col: other.x, row: other.y })).toBe(
				false,
			);
		}
		await store.close();
	});

	it("wraps an install onto the next footprint row once the first row is full", async () => {
		const store = await DashboardStore.open(yStore);
		// Fill the first footprint row wall to wall for a 1440px-wide surface
		// (≈ 16 slots at ICON_FOOTPRINT_W); the placer keeps stepping across
		// (the grid is unbounded) but never overlaps.
		for (let i = 0; i < 16; i++) {
			store.upsertIcon(`icon_seed${i}_demo`, {
				x: i * ICON_FOOTPRINT_W,
				y: 0,
				kind: "app",
				target: `seed${i}`,
				label: `Seed ${i}`,
			});
		}
		// One icon parked on the second footprint row's origin: the newcomer
		// must clear that too.
		store.upsertIcon("icon_seedRow2_demo", {
			x: 0,
			y: ICON_FOOTPRINT_H,
			kind: "app",
			target: "seedRow2",
			label: "Row 2",
		});

		expect(placeDashboardIcon(store, "io.brainstorm.newcomer", "Newcomer")).toBe(true);
		const placed = store.snapshot().icons["icon_io.brainstorm.newcomer_demo"];
		if (!placed) throw new Error("unreachable");
		for (const icon of Object.values(store.snapshot().icons)) {
			if (icon.target === "io.brainstorm.newcomer") continue;
			expect(footprintsOverlap({ col: placed.x, row: placed.y }, { col: icon.x, row: icon.y })).toBe(
				false,
			);
		}
		await store.close();
	});

	it("isWithinDnd handles same-day and wrap-past-midnight windows", () => {
		const at = (h: number, m: number) => new Date(2026, 0, 1, h, m);
		const wrap = { enabled: true, start: "22:00", end: "08:00" };
		expect(isWithinDnd(wrap, at(23, 0))).toBe(true);
		expect(isWithinDnd(wrap, at(3, 0))).toBe(true);
		expect(isWithinDnd(wrap, at(8, 0))).toBe(false);
		expect(isWithinDnd(wrap, at(12, 0))).toBe(false);
		const day = { enabled: true, start: "09:00", end: "17:00" };
		expect(isWithinDnd(day, at(10, 0))).toBe(true);
		expect(isWithinDnd(day, at(18, 0))).toBe(false);
		expect(isWithinDnd({ enabled: false, start: "00:00", end: "23:59" }, at(12, 0))).toBe(false);
	});
});
