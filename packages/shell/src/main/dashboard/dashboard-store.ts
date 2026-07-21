/**
 * Dashboard state store per §Dashboard.
 *
 * The dashboard surface is a Yjs doc owned by the shell. Schema (top-level):
 *
 *   appearance : Y.Map<string, unknown>   — { mode, light: Y.Map, dark: Y.Map }
 *   icons      : Y.Map<string, Y.Map>     — iconId → IconRecord
 *   widgets    : Y.Map<string, Y.Map>     — widgetId → WidgetRecord
 *
 * `appearance.{light|dark}` is a nested Y.Map with keys `theme`, `wp_kind`,
 * `wp_value`. Mode is per-vault in v1; per-device-override is deferred to
 * OQ-156 (the design note resolves the slot dimension here and parks the
 * device-scoped half).
 *
 * Legacy keys (still read on open, never written from v1 onwards):
 *   wallpaper       : Y.Map<string, unknown> — { kind, value }    [pre-pairs]
 *   appearance.theme: string                                       [pre-pairs]
 *
 * Migration on open: if no pair slot is populated and a legacy key exists,
 * seed the matching slot from the legacy pair and the opposite slot from
 * the built-in default for that scheme — see `readAppearance`.
 *
 * The store persists via the existing YDocStore (one file per entity sharded
 * by id-prefix); the dashboard uses a fixed id `brainstorm-Dashboard` so its
 * file lives at `<vault>/data/`.
 *
 * Stage 9 will migrate this to the entities service as
 * `brainstorm/Dashboard/v1` via a one-shot read-and-store — the on-disk shape
 * doesn't change.
 *
 * This module is pure (no Electron imports) so it can be unit-tested under
 * Bun's Vitest.
 */

import { OsHandoffConsent } from "@brainstorm-os/sdk-types";
import {
	DEFAULT_THEME_BY_APPEARANCE,
	ThemeAppearance,
	type ThemeName,
	isThemeName,
	themeAppearance,
} from "@brainstorm-os/tokens";
import * as Y from "yjs";
import {
	AppearanceMode,
	type AppearancePair,
	AppearanceSlot,
	type AppearanceState,
	effectiveSlotFor,
	isAppearanceMode,
	slotForTheme,
} from "../../shared/appearance";
import {
	type ChromeState,
	type ClockPrefs,
	DEFAULT_CLOCK_PREFS,
	DEFAULT_DND,
	DEFAULT_LANGUAGE,
	DEFAULT_NOTIFICATIONS,
	DEFAULT_REGIONAL,
	DateStylePref,
	type DndPrefs,
	FIRST_DAY_AUTO,
	type FirstDayOfWeek,
	type HeaderControlId,
	HourCyclePref,
	type LocaleState,
	NOTIFICATION_HISTORY_CAP,
	type NotificationRecord,
	type NotificationsState,
	REGIONAL_AUTO,
	type RegionalState,
	isHeaderControlId,
	isNotificationKind,
} from "../../shared/shell-prefs";
import type { YDocStore } from "../storage/ydoc-store";

export const DASHBOARD_DOC_ID = "brainstorm-Dashboard";

export type WallpaperKind = "image" | "gradient" | "solid";
export type Wallpaper = {
	kind: WallpaperKind;
	/**
	 * Image: vault-relative path. Gradient: CSS gradient string. Solid: a
	 * hex / rgb literal. (A leading `--` is still resolved as a CSS var for
	 * backward compat with any wallpaper stored before wallpapers were
	 * decoupled from the active theme — no new presets use that form.)
	 */
	value: string;
};

export type IconTargetKind = "app" | "entity" | "view" | "shell-surface";

export type IconRecord = {
	x: number;
	y: number;
	kind: IconTargetKind;
	/** App id, entity id, or saved-view id depending on kind. */
	target: string;
	label: string;
	/** Optional override; otherwise the renderer resolves from app/entity. */
	icon?: string;
};

export type WidgetRecord = {
	appId: string;
	kind: string;
	x: number;
	y: number;
	w: number;
	h: number;
	/** Set true when the widget is off-screen / pinned to a paused state. */
	paused: boolean;
	/** Set true when the user has collapsed the card to its header. */
	collapsed: boolean;
};

export type DashboardSnapshot = {
	/** Mirrors the active pair's wallpaper. Computed by the IPC enrich
	 *  step from `appearance` + the OS prefers-color-scheme reading;
	 *  callers that don't care about modes (most of the codebase) keep
	 *  reading this field. */
	wallpaper: Wallpaper;
	/** Mirrors the active pair's theme. Same enrichment as `wallpaper`. */
	theme: ThemeName;
	/** Raw appearance state: the user's chosen mode + both pair slots.
	 *  Persisted in the dashboard doc; the Settings UI reads/writes here. */
	appearance: AppearanceState;
	icons: Record<string, IconRecord>;
	widgets: Record<string, WidgetRecord>;
	/** Settings → Defaults: the user's chosen handler app per
	 *  `(verb, entityType)`, keyed `"<verb>:<entityType>"` → appId. Empty
	 *  until the user overrides a default; the intents bus reads this to
	 *  override its built-in handler pick (doc 37 §Default handlers). */
	defaultHandlers: Record<string, string>;
	/** OpenRes-1b: first-use-per-protocol OS-handoff consent memory (doc
	 *  57 §System default, OQ-OR-1 per-scheme). Keyed by the target
	 *  signature (`scheme:https` / `ext:pdf`) → `OsHandoffConsent.Granted`
	 *  | `.Denied`. Absent ⇒ `FirstUse` (the resolver must ask). Persisted
	 *  + broadcast like every other dashboard mutation; reviewable/
	 *  clearable in Settings → Defaults (the UI is OpenRes-1c). */
	osHandoffConsent: Record<string, OsHandoffConsent>;
	/** Feedback-3 — the last changelog version this vault has seen on its
	 *  Settings → What's new view. `null` means the user has never opened
	 *  the changelog (so every release counts as unseen — the auto-popup
	 *  path in a follow-up iteration uses this to decide whether to
	 *  surface "what's new" on app start). */
	lastSeenChangelogVersion: string | null;
	/** Whether the one-shot pre-8px → 8px icon-grid re-pack has already run for
	 *  this vault. Persisted (not re-derived from coordinates) because a valid
	 *  8px layout clustered top-left is indistinguishable from the old coarse
	 *  format by position alone — re-deriving would re-pack (reset) the user's
	 *  arrangement on every launch. */
	iconGridMigrated: boolean;
	/** Chosen UI language (BCP-47). Drives runtime language switching for
	 *  in-vault surfaces; per-vault so a second device inherits it. */
	locale: LocaleState;
	/** Regional formatting overrides (date/time/first-day/number/timezone).
	 *  All "auto" by default ⇒ behaviour identical to the OS locale. */
	regional: RegionalState;
	/** Shell-interface settings: header-control visibility + clock options. */
	chrome: ChromeState;
	/** Notification preferences: OS-native toggle, DND window, per-app mutes. */
	notifications: NotificationsState;
	/** Notification center history (newest last), capped + drop-oldest. */
	notificationHistory: NotificationRecord[];
	/** The action surface (doc 63 / AS-4): app ids whose contributed actions the
	 *  user has disabled wholesale (Settings → an app's contributions). The
	 *  intents bus drops every contribution from a listed app from `suggestActions`.
	 *  Empty until the user disables one. Per-vault; synced like every other
	 *  dashboard setting. */
	disabledContributors: string[];
};

/** Compose the `defaultHandlers` map key. Single source of truth so the
 *  store, the bus resolver and the Settings UI never drift on the format. */
export function defaultHandlerKey(verb: string, entityType: string): string {
	return `${verb}:${entityType}`;
}

/** Compose the OS-handoff-consent map key from a target signature
 *  (`scheme:https`, `ext:pdf`, `ext:` for an extension-less file). Single
 *  source of truth shared by the store, the resolver and the future
 *  Settings UI so the format never drifts. */
export function osHandoffConsentKey(signature: string): string {
	return signature;
}

const DEFAULT_LIGHT_WALLPAPER: Wallpaper = { kind: "solid", value: "#f5f3ef" };
const DEFAULT_DARK_WALLPAPER: Wallpaper = { kind: "solid", value: "#161616" };

const DEFAULT_LIGHT_PAIR: AppearancePair = {
	theme: DEFAULT_THEME_BY_APPEARANCE[ThemeAppearance.Light],
	wallpaper: DEFAULT_LIGHT_WALLPAPER,
};
const DEFAULT_DARK_PAIR: AppearancePair = {
	theme: DEFAULT_THEME_BY_APPEARANCE[ThemeAppearance.Dark],
	wallpaper: DEFAULT_DARK_WALLPAPER,
};

export type DashboardStoreOptions = {
	docId?: string;
};

/**
 * Reactive wrapper around the dashboard Yjs doc. Persists every committed
 * update to the YDocStore tail (compacting past 256KB) and surfaces a
 * `subscribe(listener)` for renderer/main consumers that want a typed
 * snapshot stream.
 *
 * Construct via `DashboardStore.open(yStore)` — the static factory loads any
 * existing file before wiring observers, which prevents the constructor from
 * persisting the initial empty state.
 */
export class DashboardStore {
	private readonly doc: Y.Doc;
	private readonly yStore: YDocStore;
	private readonly docId: string;
	private readonly listeners = new Set<(snap: DashboardSnapshot) => void>();
	private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
	private pendingPersist: Promise<void> = Promise.resolve();
	private closed = false;
	private notifySuspended = 0;
	private notifyPending = false;

	private constructor(doc: Y.Doc, yStore: YDocStore, docId: string) {
		this.doc = doc;
		this.yStore = yStore;
		this.docId = docId;
	}

	/**
	 * Open (or create) the dashboard store. Loads any persisted state, then
	 * wires the update observer so subsequent changes flow back to disk.
	 */
	static async open(
		yStore: YDocStore,
		options: DashboardStoreOptions = {},
	): Promise<DashboardStore> {
		const docId = options.docId ?? DASHBOARD_DOC_ID;
		const { doc } = await yStore.load(docId);
		const store = new DashboardStore(doc, yStore, docId);
		store.wireObservers();
		return store;
	}

	private wireObservers(): void {
		const handler = (update: Uint8Array, origin: unknown) => {
			if (origin === "load") return;
			this.pendingPersist = this.pendingPersist.then(async () => {
				if (this.closed) return;
				try {
					await this.yStore.appendAndMaybeCompact(this.docId, update);
				} catch (err) {
					// A failed tail append (disk error, or the vault dir torn
					// down while close() drains in the background — dispose()
					// fire-and-forgets close()) must not poison the persist
					// chain into an unhandled rejection. The in-memory doc keeps
					// the update; surface it as a log, not a process crash.
					console.warn(`[shell/dashboard-store] persist failed for ${this.docId}:`, err);
				}
			});
			this.notify();
		};
		this.updateHandler = handler;
		this.doc.on("update", handler);
	}

	/** Subscribe to typed snapshots. Returns an unsubscribe function. */
	subscribe(listener: (snap: DashboardSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Wait for any in-flight persist to settle — useful in tests. */
	async flush(): Promise<void> {
		await this.pendingPersist;
	}

	/** Release observers; persist queue is drained by the caller via flush(). */
	async close(): Promise<void> {
		this.closed = true;
		if (this.updateHandler) {
			this.doc.off("update", this.updateHandler);
			this.updateHandler = null;
		}
		this.listeners.clear();
		await this.pendingPersist;
	}

	/**
	 * Snapshot of the dashboard state. `theme` / `wallpaper` mirror the
	 * **active** pair (decided by `effectiveSlot` if passed, else the
	 * mode's explicit slot for Light/Dark and Dark for Auto — the IPC
	 * enrich step overrides this with the real OS preference via
	 * `nativeTheme.shouldUseDarkColors`). All other consumers see the same
	 * shape they always did.
	 */
	snapshot(effectiveSlot?: AppearanceSlot): DashboardSnapshot {
		const appearance = this.readAppearance();
		const slot = effectiveSlot ?? defaultEffectiveSlot(appearance.mode);
		const pair = slot === AppearanceSlot.Dark ? appearance.dark : appearance.light;
		return {
			wallpaper: pair.wallpaper,
			theme: pair.theme,
			appearance,
			icons: this.readIcons(),
			widgets: this.readWidgets(),
			defaultHandlers: this.readDefaultHandlers(),
			osHandoffConsent: this.readOsHandoffConsent(),
			lastSeenChangelogVersion: this.readLastSeenChangelogVersion(),
			iconGridMigrated: this.readIconGridMigrated(),
			locale: this.readLocale(),
			regional: this.readRegional(),
			chrome: this.readChrome(),
			notifications: this.readNotifications(),
			notificationHistory: this.readNotificationHistory(),
			disabledContributors: this.readDisabledContributors(),
		};
	}

	/** Resolve just the active theme name for the current appearance + OS
	 *  dark preference. The launch path needs only this — building a full
	 *  `snapshot()` (icons, widgets, default-handlers, consent) on every
	 *  window open is pure latency on the critical path. Reads the
	 *  appearance map once. */
	activeTheme(osPrefersDark: boolean): ThemeName {
		const appearance = this.readAppearance();
		const slot = effectiveSlotFor(appearance.mode, osPrefersDark);
		return (slot === AppearanceSlot.Dark ? appearance.dark : appearance.light).theme;
	}

	/** Write the wallpaper into the slot matching `slot`; if omitted, the
	 *  slot is decided by the current mode (Light/Dark explicit, Auto
	 *  defaults to the Dark slot — the renderer that knows the real OS
	 *  preference can pass `slot` explicitly). The legacy top-level
	 *  `wallpaper` map is no longer written. */
	setWallpaper(next: Wallpaper, slot?: AppearanceSlot): void {
		const target = slot ?? defaultEffectiveSlot(this.readAppearanceMode());
		this.doc.transact(() => {
			this.writePair(target, { wallpaper: next });
		});
	}

	/** Activating a theme writes it into the slot matching the theme's own
	 *  `ThemeAppearance` declaration — a dark theme can't corrupt the
	 *  light slot. Settings UI and marketplace activation both go through
	 *  here, so the invariant holds regardless of caller. */
	setTheme(name: ThemeName): void {
		const target = slotForTheme(name);
		this.doc.transact(() => {
			this.writePair(target, { theme: name });
		});
	}

	/** Update both halves of a pair in one transaction (used by the
	 *  Settings UI when picking a theme + wallpaper together so subscribers
	 *  see one coalesced snapshot). */
	setAppearancePair(slot: AppearanceSlot, pair: AppearancePair): void {
		this.doc.transact(() => {
			this.writePair(slot, pair);
		});
	}

	setAppearanceMode(mode: AppearanceMode): void {
		const appearance = this.doc.getMap<unknown>("appearance");
		this.doc.transact(() => {
			appearance.set("mode", mode);
		});
	}

	private writePair(slot: AppearanceSlot, partial: Partial<AppearancePair>): void {
		const appearance = this.doc.getMap<unknown>("appearance");
		const key = slot === AppearanceSlot.Dark ? "dark" : "light";
		let map = appearance.get(key);
		if (!(map instanceof Y.Map)) {
			map = new Y.Map<unknown>();
			appearance.set(key, map);
		}
		const yMap = map as Y.Map<unknown>;
		if (partial.theme !== undefined) yMap.set("theme", partial.theme);
		if (partial.wallpaper !== undefined) {
			yMap.set("wp_kind", partial.wallpaper.kind);
			yMap.set("wp_value", partial.wallpaper.value);
		}
	}

	/** Set (or, when `appId` is null, clear) the user's default handler
	 *  app for a `(verb, entityType)` pair. Persisted on the dashboard doc
	 *  and broadcast like every other dashboard mutation. */
	setDefaultHandler(verb: string, entityType: string, appId: string | null): void {
		const map = this.doc.getMap<string>("defaultHandlers");
		const key = defaultHandlerKey(verb, entityType);
		this.doc.transact(() => {
			if (appId) map.set(key, appId);
			else map.delete(key);
		});
	}

	/** Record (or, when `decision` is null, clear) the user's first-use
	 *  OS-handoff answer for a target signature. The interactive prompt
	 *  that calls this is OpenRes-1c; the resolver + tests read it now. */
	setOsHandoffConsent(signature: string, decision: OsHandoffConsent | null): void {
		const map = this.doc.getMap<string>("osHandoffConsent");
		const key = osHandoffConsentKey(signature);
		this.doc.transact(() => {
			// FirstUse is the *absence* of a record — never stored.
			if (decision && decision !== OsHandoffConsent.FirstUse) map.set(key, decision);
			else map.delete(key);
		});
	}

	/** Feedback-3 — record the changelog version the user has seen on
	 *  their Settings → What's new view. `null` clears the marker (next
	 *  open shows every release as unseen). The renderer calls this when
	 *  the user opens the view, OR when they explicitly dismiss the
	 *  auto-popup (the popup path is the slice-2 follow-up). */
	setLastSeenChangelogVersion(version: string | null): void {
		const map = this.doc.getMap<string>("changelogState");
		this.doc.transact(() => {
			if (typeof version === "string" && version.length > 0) {
				map.set("version", version);
			} else {
				map.delete("version");
			}
		});
	}

	/** Mark the one-shot pre-8px → 8px icon-grid re-pack as done for this vault. */
	setIconGridMigrated(): void {
		const map = this.doc.getMap<boolean>("iconGridState");
		this.doc.transact(() => {
			map.set("migrated", true);
		});
	}

	/** Set the active UI language (BCP-47 tag). */
	setLanguage(language: string): void {
		const map = this.doc.getMap<string>("locale");
		this.doc.transact(() => {
			map.set("language", language);
		});
	}

	/** Patch any subset of the regional-format overrides in one transaction. */
	setRegional(partial: Partial<RegionalState>): void {
		const map = this.doc.getMap<unknown>("regional");
		this.doc.transact(() => {
			if (partial.hourCycle !== undefined) map.set("hourCycle", partial.hourCycle);
			if (partial.dateStyle !== undefined) map.set("dateStyle", partial.dateStyle);
			if (partial.firstDayOfWeek !== undefined) map.set("firstDayOfWeek", partial.firstDayOfWeek);
			if (partial.numberLocale !== undefined) map.set("numberLocale", partial.numberLocale);
			if (partial.timezone !== undefined) map.set("timezone", partial.timezone);
		});
	}

	/** Show/hide a single header control. */
	setHeaderControlVisible(id: HeaderControlId, visible: boolean): void {
		const chrome = this.doc.getMap<unknown>("chrome");
		this.doc.transact(() => {
			const vis = this.subMap(chrome, "visibility");
			vis.set(id, visible);
		});
	}

	/** Patch the header clock options. */
	setClockPrefs(partial: Partial<ClockPrefs>): void {
		const chrome = this.doc.getMap<unknown>("chrome");
		this.doc.transact(() => {
			const clock = this.subMap(chrome, "clock");
			if (partial.show !== undefined) clock.set("show", partial.show);
			if (partial.showSeconds !== undefined) clock.set("showSeconds", partial.showSeconds);
			if (partial.hourCycle !== undefined) clock.set("hourCycle", partial.hourCycle);
		});
	}

	/** Reset all interface (chrome) settings to their defaults. */
	resetChrome(): void {
		const chrome = this.doc.getMap<unknown>("chrome");
		this.doc.transact(() => {
			chrome.delete("visibility");
			chrome.delete("clock");
		});
	}

	/** Toggle OS-native notifications on/off. */
	setNotificationsOsNative(osNative: boolean): void {
		const map = this.doc.getMap<unknown>("notifications");
		this.doc.transact(() => {
			map.set("osNative", osNative);
		});
	}

	/** Patch the do-not-disturb window. */
	setDnd(partial: Partial<DndPrefs>): void {
		const map = this.doc.getMap<unknown>("notifications");
		this.doc.transact(() => {
			const dnd = this.subMap(map, "dnd");
			if (partial.enabled !== undefined) dnd.set("enabled", partial.enabled);
			if (partial.start !== undefined) dnd.set("start", partial.start);
			if (partial.end !== undefined) dnd.set("end", partial.end);
		});
	}

	/** Mute / unmute notifications from a single app. */
	setAppNotificationMuted(appId: string, muted: boolean): void {
		const map = this.doc.getMap<unknown>("notifications");
		this.doc.transact(() => {
			const mutes = this.subMap(map, "mutes");
			if (muted) mutes.set(appId, true);
			else mutes.delete(appId);
		});
	}

	/** Append a notification to the center history, capped drop-oldest. The
	 *  caller mints the id + timestamp (the store is OS/clock-free). */
	pushNotification(record: NotificationRecord): void {
		const arr = this.doc.getArray<Y.Map<unknown>>("notificationHistory");
		this.doc.transact(() => {
			const entry = new Y.Map<unknown>();
			entry.set("id", record.id);
			entry.set("appId", record.appId);
			entry.set("title", record.title);
			if (record.body !== undefined) entry.set("body", record.body);
			entry.set("kind", record.kind);
			entry.set("ts", record.ts);
			entry.set("read", record.read);
			arr.push([entry]);
			const overflow = arr.length - NOTIFICATION_HISTORY_CAP;
			if (overflow > 0) arr.delete(0, overflow);
		});
	}

	/** Flip a single history entry's read flag to true. */
	markNotificationRead(id: string): void {
		const arr = this.doc.getArray<Y.Map<unknown>>("notificationHistory");
		this.doc.transact(() => {
			for (let i = 0; i < arr.length; i += 1) {
				const entry = arr.get(i);
				if (entry.get("id") === id) {
					entry.set("read", true);
					return;
				}
			}
		});
	}

	/** Mark every history entry read. */
	markAllNotificationsRead(): void {
		const arr = this.doc.getArray<Y.Map<unknown>>("notificationHistory");
		this.doc.transact(() => {
			for (let i = 0; i < arr.length; i += 1) arr.get(i).set("read", true);
		});
	}

	/** Empty the notification center. */
	clearNotificationHistory(): void {
		const arr = this.doc.getArray<Y.Map<unknown>>("notificationHistory");
		if (arr.length === 0) return;
		this.doc.transact(() => {
			arr.delete(0, arr.length);
		});
	}

	/** Get-or-create a nested Y.Map under a parent map key. */
	private subMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
		let map = parent.get(key);
		if (!(map instanceof Y.Map)) {
			map = new Y.Map<unknown>();
			parent.set(key, map);
		}
		return map as Y.Map<unknown>;
	}

	upsertIcon(id: string, record: IconRecord): void {
		const icons = this.doc.getMap<Y.Map<unknown>>("icons");
		this.doc.transact(() => {
			let entry = icons.get(id);
			if (!entry) {
				entry = new Y.Map<unknown>();
				icons.set(id, entry);
			}
			entry.set("x", record.x);
			entry.set("y", record.y);
			entry.set("kind", record.kind);
			entry.set("target", record.target);
			entry.set("label", record.label);
			if (record.icon !== undefined) {
				entry.set("icon", record.icon);
			} else {
				entry.delete("icon");
			}
			// Explicitly pinning an app (app grid) un-dismisses it: the user
			// wants it on the dashboard again, so the seeder may re-pin it later.
			if (record.kind === "app") {
				this.doc.getMap<string>("dismissedAppIcons").delete(record.target);
			}
		});
	}

	moveIcon(id: string, x: number, y: number): void {
		const icons = this.doc.getMap<Y.Map<unknown>>("icons");
		const entry = icons.get(id);
		if (!entry) return;
		this.doc.transact(() => {
			entry.set("x", x);
			entry.set("y", y);
		});
	}

	removeIcon(id: string): void {
		const icons = this.doc.getMap<Y.Map<unknown>>("icons");
		const entry = icons.get(id);
		if (!entry) return;
		const record = readIconRecord(entry);
		this.doc.transact(() => {
			icons.delete(id);
			// A user-removed APP icon stays removed. The first-party seeder
			// re-pins any app that has no icon on every boot (the dev loop
			// uninstalls+reinstalls each app per launch), so without a record
			// of the intentional removal the icon resurrects on next restart —
			// "Remove from dashboard does nothing" for first-party apps.
			if (record?.kind === "app") {
				this.doc.getMap<string>("dismissedAppIcons").set(record.target, "1");
			}
		});
	}

	/** True when the user removed this app's dashboard icon and hasn't re-pinned
	 *  it since — the seeder must not resurrect it. */
	isAppIconDismissed(appId: string): boolean {
		return this.doc.getMap<string>("dismissedAppIcons").get(appId) === "1";
	}

	/** Clear the dismissal so the seeder may pin the app again — used by the
	 *  explicit "reinstall from marketplace" path (an explicit user request for
	 *  the app back). Idempotent. */
	clearAppIconDismissed(appId: string): void {
		const map = this.doc.getMap<string>("dismissedAppIcons");
		if (!map.has(appId)) return;
		this.doc.transact(() => map.delete(appId));
	}

	upsertWidget(id: string, record: WidgetRecord): void {
		const widgets = this.doc.getMap<Y.Map<unknown>>("widgets");
		this.doc.transact(() => {
			let entry = widgets.get(id);
			if (!entry) {
				entry = new Y.Map<unknown>();
				widgets.set(id, entry);
			}
			entry.set("appId", record.appId);
			entry.set("kind", record.kind);
			entry.set("x", record.x);
			entry.set("y", record.y);
			entry.set("w", record.w);
			entry.set("h", record.h);
			entry.set("paused", record.paused);
			entry.set("collapsed", record.collapsed);
		});
	}

	setWidgetPaused(id: string, paused: boolean): void {
		const widgets = this.doc.getMap<Y.Map<unknown>>("widgets");
		const entry = widgets.get(id);
		if (!entry) return;
		this.doc.transact(() => {
			entry.set("paused", paused);
		});
	}

	removeWidget(id: string): void {
		const widgets = this.doc.getMap<Y.Map<unknown>>("widgets");
		if (!widgets.has(id)) return;
		this.doc.transact(() => {
			widgets.delete(id);
		});
	}

	private readAppearance(): AppearanceState {
		const appearance = this.doc.getMap<unknown>("appearance");
		const mode = appearance.get("mode");
		const legacyTheme = appearance.get("theme");
		const legacyWallpaper = this.readLegacyWallpaper();

		const light = this.readPair(appearance, "light");
		const dark = this.readPair(appearance, "dark");

		// Migration: if a slot is empty AND a legacy single-theme record
		// exists, seed the matching slot from the legacy pair and let the
		// opposite slot fall to its built-in default. Subsequent writes go
		// straight to the pair maps; legacy keys are read-only from here.
		const legacyName = isThemeName(legacyTheme) ? legacyTheme : null;
		const migrated = applyLegacyMigration({ light, dark }, legacyName, legacyWallpaper);

		return {
			mode: isAppearanceMode(mode) ? mode : AppearanceMode.Auto,
			light: migrated.light,
			dark: migrated.dark,
		};
	}

	private readAppearanceMode(): AppearanceMode {
		const value = this.doc.getMap<unknown>("appearance").get("mode");
		return isAppearanceMode(value) ? value : AppearanceMode.Auto;
	}

	/**
	 * Read a pair slot, composing any partial state on top of the slot's
	 * built-in default. A partial write (e.g. `setTheme` touches only the
	 * theme half) must still produce a complete pair on read, otherwise
	 * subsequent reads silently revert to the all-default fallback.
	 * Returns null only when the slot has never been touched AND no key is
	 * present — that's the signal `readAppearance` uses to gate migration.
	 */
	private readPair(appearance: Y.Map<unknown>, key: "light" | "dark"): AppearancePair | null {
		const entry = appearance.get(key);
		if (!(entry instanceof Y.Map)) return null;
		const themeName = entry.get("theme");
		const kind = entry.get("wp_kind");
		const value = entry.get("wp_value");
		const hasTheme = isThemeName(themeName);
		const hasWallpaper =
			typeof kind === "string" && isWallpaperKind(kind) && typeof value === "string";
		if (!hasTheme && !hasWallpaper) return null;
		const fallback = key === "light" ? DEFAULT_LIGHT_PAIR : DEFAULT_DARK_PAIR;
		return {
			theme: hasTheme ? themeName : fallback.theme,
			wallpaper: hasWallpaper ? { kind, value } : fallback.wallpaper,
		};
	}

	private readLegacyWallpaper(): Wallpaper | null {
		const wp = this.doc.getMap<unknown>("wallpaper");
		const kind = wp.get("kind");
		const value = wp.get("value");
		if (typeof kind === "string" && typeof value === "string" && isWallpaperKind(kind)) {
			return { kind, value };
		}
		return null;
	}

	private readDefaultHandlers(): Record<string, string> {
		const map = this.doc.getMap<string>("defaultHandlers");
		const out: Record<string, string> = {};
		for (const [key, value] of map.entries()) {
			if (typeof value === "string" && value.length > 0) out[key] = value;
		}
		return out;
	}

	private readOsHandoffConsent(): Record<string, OsHandoffConsent> {
		const map = this.doc.getMap<string>("osHandoffConsent");
		const out: Record<string, OsHandoffConsent> = {};
		for (const [key, value] of map.entries()) {
			if (value === OsHandoffConsent.Granted || value === OsHandoffConsent.Denied) {
				out[key] = value;
			}
		}
		return out;
	}

	/** The action surface (AS-4): app ids whose contributions are disabled. A
	 *  Y.Map keyed by appId → "1" (set membership; the value is a marker). Sorted
	 *  for a deterministic snapshot. */
	private readDisabledContributors(): string[] {
		const map = this.doc.getMap<string>("disabledContributors");
		const out: string[] = [];
		for (const [key, value] of map.entries()) {
			if (value === "1" && key.length > 0) out.push(key);
		}
		return out.sort();
	}

	/** The action surface (AS-4): disable or re-enable an app's contributions
	 *  wholesale. Disabling drops every contribution from `appId` from
	 *  `suggestActions`; re-enabling restores them. Idempotent. */
	setContributorDisabled(appId: string, disabled: boolean): void {
		const map = this.doc.getMap<string>("disabledContributors");
		this.doc.transact(() => {
			if (disabled) map.set(appId, "1");
			else map.delete(appId);
		});
	}

	private readLastSeenChangelogVersion(): string | null {
		// Single scalar lives on a tiny Y.Map keyed by `"version"` so the
		// store doesn't need a `Y.Doc.getText`-on-a-string-root. Empty /
		// missing reads as `null` so the future auto-popup path treats
		// first-launch as "everything is new".
		const map = this.doc.getMap<string>("changelogState");
		const raw = map.get("version");
		return typeof raw === "string" && raw.length > 0 ? raw : null;
	}

	private readIconGridMigrated(): boolean {
		return this.doc.getMap<boolean>("iconGridState").get("migrated") === true;
	}

	private readLocale(): LocaleState {
		const map = this.doc.getMap<unknown>("locale");
		const language = map.get("language");
		return {
			language: typeof language === "string" && language.length > 0 ? language : DEFAULT_LANGUAGE,
		};
	}

	private readRegional(): RegionalState {
		const map = this.doc.getMap<unknown>("regional");
		const hourCycle = map.get("hourCycle");
		const dateStyle = map.get("dateStyle");
		const firstDay = map.get("firstDayOfWeek");
		const numberLocale = map.get("numberLocale");
		const timezone = map.get("timezone");
		return {
			hourCycle: isHourCycle(hourCycle) ? hourCycle : DEFAULT_REGIONAL.hourCycle,
			dateStyle: isDateStyle(dateStyle) ? dateStyle : DEFAULT_REGIONAL.dateStyle,
			firstDayOfWeek: isFirstDay(firstDay) ? firstDay : DEFAULT_REGIONAL.firstDayOfWeek,
			numberLocale: typeof numberLocale === "string" ? numberLocale : REGIONAL_AUTO,
			timezone: typeof timezone === "string" ? timezone : REGIONAL_AUTO,
		};
	}

	private readChrome(): ChromeState {
		const chrome = this.doc.getMap<unknown>("chrome");
		const visEntry = chrome.get("visibility");
		const visibility: Partial<Record<HeaderControlId, boolean>> = {};
		if (visEntry instanceof Y.Map) {
			for (const [key, value] of visEntry.entries()) {
				if (isHeaderControlId(key) && typeof value === "boolean") visibility[key] = value;
			}
		}
		const clockEntry = chrome.get("clock");
		const clock: ClockPrefs = { ...DEFAULT_CLOCK_PREFS };
		if (clockEntry instanceof Y.Map) {
			const show = clockEntry.get("show");
			const showSeconds = clockEntry.get("showSeconds");
			const hourCycle = clockEntry.get("hourCycle");
			if (typeof show === "boolean") clock.show = show;
			if (typeof showSeconds === "boolean") clock.showSeconds = showSeconds;
			if (isHourCycle(hourCycle)) clock.hourCycle = hourCycle;
		}
		return { visibility, clock };
	}

	private readNotifications(): NotificationsState {
		const map = this.doc.getMap<unknown>("notifications");
		const osNative = map.get("osNative");
		const dndEntry = map.get("dnd");
		const dnd: DndPrefs = { ...DEFAULT_DND };
		if (dndEntry instanceof Y.Map) {
			const enabled = dndEntry.get("enabled");
			const start = dndEntry.get("start");
			const end = dndEntry.get("end");
			if (typeof enabled === "boolean") dnd.enabled = enabled;
			if (typeof start === "string") dnd.start = start;
			if (typeof end === "string") dnd.end = end;
		}
		const mutesEntry = map.get("mutes");
		const mutes: Record<string, boolean> = {};
		if (mutesEntry instanceof Y.Map) {
			for (const [key, value] of mutesEntry.entries()) {
				if (value === true) mutes[key] = true;
			}
		}
		return {
			osNative: typeof osNative === "boolean" ? osNative : DEFAULT_NOTIFICATIONS.osNative,
			dnd,
			mutes,
		};
	}

	private readNotificationHistory(): NotificationRecord[] {
		const arr = this.doc.getArray<Y.Map<unknown>>("notificationHistory");
		const out: NotificationRecord[] = [];
		for (let i = 0; i < arr.length; i += 1) {
			const record = readNotificationRecord(arr.get(i));
			if (record) out.push(record);
		}
		return out;
	}

	private readIcons(): Record<string, IconRecord> {
		const icons = this.doc.getMap<Y.Map<unknown>>("icons");
		const out: Record<string, IconRecord> = {};
		for (const [id, entry] of icons.entries()) {
			const record = readIconRecord(entry);
			if (record) out[id] = record;
		}
		return out;
	}

	private readWidgets(): Record<string, WidgetRecord> {
		const widgets = this.doc.getMap<Y.Map<unknown>>("widgets");
		const out: Record<string, WidgetRecord> = {};
		for (const [id, entry] of widgets.entries()) {
			const record = readWidgetRecord(entry);
			if (record) out[id] = record;
		}
		return out;
	}

	private notify(): void {
		// While a batch is open, coalesce: persistence still runs per update,
		// but subscribers (the dashboard renderer) see a single snapshot when
		// the batch closes — so a multi-app seed paints every icon at once
		// instead of popping them in one broadcast at a time.
		if (this.notifySuspended > 0) {
			this.notifyPending = true;
			return;
		}
		if (this.listeners.size === 0) return;
		const snap = this.snapshot();
		for (const listener of this.listeners) listener(snap);
	}

	/**
	 * Run `fn` with subscriber notifications coalesced: every mutation still
	 * persists to the tail, but listeners are notified at most once, after
	 * `fn` settles. Used by the app seeder so first-party icons appear as one
	 * batch rather than one-by-one. Re-entrant (depth-counted).
	 */
	async batch<T>(fn: () => Promise<T> | T): Promise<T> {
		this.notifySuspended += 1;
		try {
			return await fn();
		} finally {
			this.notifySuspended -= 1;
			if (this.notifySuspended === 0 && this.notifyPending) {
				this.notifyPending = false;
				this.notify();
			}
		}
	}
}

function isWallpaperKind(value: string): value is WallpaperKind {
	return value === "image" || value === "gradient" || value === "solid";
}

/** Pick a slot for an effective resolution when the OS preference isn't
 *  known — used inside the store itself (which is OS-free by design). The
 *  IPC enrich step always overrides this with the real `nativeTheme`
 *  reading; this helper exists so the snapshot is well-formed even before
 *  enrichment (e.g. tests, first paint). For Auto we default to Dark to
 *  match the project's historical default vibe. */
function defaultEffectiveSlot(mode: AppearanceMode): AppearanceSlot {
	switch (mode) {
		case AppearanceMode.Light:
			return AppearanceSlot.Light;
		case AppearanceMode.Dark:
			return AppearanceSlot.Dark;
		case AppearanceMode.Auto:
			return AppearanceSlot.Dark;
	}
}

/** Materialise the pair slots from whatever combination of new + legacy
 *  state the doc has on disk. Both slots are always returned populated;
 *  the legacy single-theme + single-wallpaper feeds the slot that matches
 *  the theme's declared scheme, the other slot falls to the built-in
 *  default. Pure — exported for unit tests below. */
export function applyLegacyMigration(
	current: { light: AppearancePair | null; dark: AppearancePair | null },
	legacyTheme: ThemeName | null,
	legacyWallpaper: Wallpaper | null,
): { light: AppearancePair; dark: AppearancePair } {
	let light = current.light;
	let dark = current.dark;

	if ((!light || !dark) && legacyTheme) {
		const legacySlot = slotForTheme(legacyTheme);
		const legacyPair: AppearancePair = {
			theme: legacyTheme,
			wallpaper: legacyWallpaper ?? defaultWallpaperForSlot(legacySlot),
		};
		if (legacySlot === AppearanceSlot.Light) {
			light = light ?? legacyPair;
		} else {
			dark = dark ?? legacyPair;
		}
	} else if ((!light || !dark) && legacyWallpaper) {
		// No legacy theme but a legacy wallpaper exists (older builds set
		// wallpaper before this field migration). Drop it into the dark
		// slot to preserve the user's wallpaper choice, since pre-migration
		// the default theme was Dark.
		if (!dark) {
			dark = { theme: DEFAULT_DARK_PAIR.theme, wallpaper: legacyWallpaper };
		}
	}

	return {
		light: light ?? DEFAULT_LIGHT_PAIR,
		dark: dark ?? DEFAULT_DARK_PAIR,
	};
}

function defaultWallpaperForSlot(slot: AppearanceSlot): Wallpaper {
	return slot === AppearanceSlot.Light ? DEFAULT_LIGHT_WALLPAPER : DEFAULT_DARK_WALLPAPER;
}

function isIconTargetKind(value: string): value is IconTargetKind {
	return value === "app" || value === "entity" || value === "view" || value === "shell-surface";
}

function readIconRecord(map: Y.Map<unknown>): IconRecord | null {
	const x = map.get("x");
	const y = map.get("y");
	const kind = map.get("kind");
	const target = map.get("target");
	const label = map.get("label");
	const icon = map.get("icon");
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof kind !== "string" ||
		!isIconTargetKind(kind) ||
		typeof target !== "string" ||
		typeof label !== "string"
	) {
		return null;
	}
	const out: IconRecord = { x, y, kind, target, label };
	if (typeof icon === "string") out.icon = icon;
	return out;
}

function isHourCycle(value: unknown): value is HourCyclePref {
	return value === HourCyclePref.Auto || value === HourCyclePref.H12 || value === HourCyclePref.H23;
}

function isDateStyle(value: unknown): value is DateStylePref {
	return (
		value === DateStylePref.Auto ||
		value === DateStylePref.Short ||
		value === DateStylePref.Medium ||
		value === DateStylePref.Long ||
		value === DateStylePref.Full
	);
}

function isFirstDay(value: unknown): value is FirstDayOfWeek {
	return value === FIRST_DAY_AUTO || (typeof value === "number" && value >= 0 && value <= 6);
}

function readNotificationRecord(map: Y.Map<unknown>): NotificationRecord | null {
	const id = map.get("id");
	const appId = map.get("appId");
	const title = map.get("title");
	const body = map.get("body");
	const kind = map.get("kind");
	const ts = map.get("ts");
	const read = map.get("read");
	if (
		typeof id !== "string" ||
		typeof appId !== "string" ||
		typeof title !== "string" ||
		!isNotificationKind(kind) ||
		typeof ts !== "number" ||
		typeof read !== "boolean"
	) {
		return null;
	}
	const out: NotificationRecord = { id, appId, title, kind, ts, read };
	if (typeof body === "string") out.body = body;
	return out;
}

function readWidgetRecord(map: Y.Map<unknown>): WidgetRecord | null {
	const appId = map.get("appId");
	const kind = map.get("kind");
	const x = map.get("x");
	const y = map.get("y");
	const w = map.get("w");
	const h = map.get("h");
	const paused = map.get("paused");
	const collapsed = map.get("collapsed");
	if (
		typeof appId !== "string" ||
		typeof kind !== "string" ||
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof w !== "number" ||
		typeof h !== "number" ||
		typeof paused !== "boolean"
	) {
		return null;
	}
	// `collapsed` was added after the first widgets shipped — records written
	// before it default to expanded.
	return { appId, kind, x, y, w, h, paused, collapsed: collapsed === true };
}
