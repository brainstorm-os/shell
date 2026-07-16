/**
 * Bridge to the shell's app preload. Mirrors `apps/journal/src/runtime.ts`
 * — types only the slice of `window.brainstorm` Calendar uses today
 * (lifecycle `on("ready", …)` + `services.vaultEntities.list` /
 * `onChange`).
 *
 * `getCalendarRuntime()` returns null when the renderer boots outside
 * the shell (`vite preview`, isolated dev) — exactly when the app
 * falls back to the in-memory demo dataset per
 * [[preview-drop-pattern]].
 */

import type {
	CalDavService,
	PropertiesService,
	VaultEntity as SdkVaultEntity,
	SettingsService,
	VaultEntitiesService,
	VaultEntitiesSnapshot,
} from "@brainstorm/sdk-types";

/** Re-exported from sdk-types so the projector + the `useVaultEntities`
 *  React hook (which yields the sdk-types snapshot) share one shape. */
export type VaultEntity = SdkVaultEntity;
export type VaultSnapshot = VaultEntitiesSnapshot;

export type IntentsService = {
	dispatch(intent: { verb: string; payload: Record<string, unknown> }): Promise<unknown>;
};

/** Dashboard pin surface — the shared object menu reads/writes pin state
 *  through this (per [[project_object_menu_and_pins]]). Optional: an
 *  older shell without it just omits the Pin item. */
export type DashboardService = {
	pin?(t: { entityId: string }): Promise<boolean>;
	unpin?(t: { entityId: string }): Promise<boolean>;
	isPinned?(t: { entityId: string }): Promise<boolean>;
};

/** Inbound running-app intent push (9.15e). An intent dispatched against
 *  Event and routed back to this already-open window is re-emitted here
 *  (the launcher focuses the window without re-firing the handshake —
 *  the same channel Tasks consumes). `payload` crossed a structured-
 *  clone boundary, so it's untyped and validated by
 *  `parseComposePayload`. */
export type CalendarIntentEvent = {
	type: "intent";
	intent: { verb: string; payload: Record<string, unknown> };
};

/** Shell notification surface (Stage 7.7 `ui.notify`, cap
 *  `notifications.post`). Optional — a shell without it (or a denied
 *  capability) simply means reminders persist but don't pop while the app
 *  is open. */
export type UiService = {
	notify?(notification: {
		title: string;
		body?: string;
		kind?: string;
		/** Cross-window/scheduler collapse key — see `UiNotification.dedupeKey`. */
		dedupeKey?: string;
		/** Subject entity — clicking the shell notification opens it. */
		entityId?: string;
	}): Promise<void> | void;
};

export type CalendarRuntime = {
	on(event: "ready", handler: () => void): void;
	on(event: "intent", handler: (event: CalendarIntentEvent) => void): void;
	capabilities?: readonly string[];
	services?: {
		vaultEntities?: VaultEntitiesService;
		intents?: IntentsService;
		dashboard?: DashboardService;
		ui?: UiService;
		/** CalDAV two-way sync (9.15.19) — shell-side custody + engine;
		 *  this renderer only ever holds entity refs. */
		caldav?: CalDavService;
		/** Vault property catalog (cap `properties.read`) — used to discover
		 *  which property keys are `Date`-typed so any entity carrying one
		 *  projects onto the calendar (9.15f). */
		properties?: PropertiesService;
		/** Per-device, vault-scoped settings — persists the source-filter
		 *  visibility (9.15f). */
		settings?: SettingsService;
	};
};

declare global {
	interface Window {
		brainstorm?: CalendarRuntime | undefined;
	}
}

export function getCalendarRuntime(): CalendarRuntime | null {
	return (window as Window).brainstorm ?? null;
}

export const TASK_ENTITY_TYPE = "brainstorm/Task/v1";

/** Canonical Contacts type (Database 9.12.13). A `Person/v1` row with a
 *  numeric `birthday` (epoch ms, UTC midnight) projects to an all-day
 *  birthday item — same source the aggregator already surfaces. */
export const PERSON_ENTITY_TYPE = "brainstorm/Person/v1";

/** Notes type. A note carrying a date-valued property (9.15p) projects to
 *  an all-day item on that date. */
export const NOTE_ENTITY_TYPE = "brainstorm/Note/v1";

/** Journal daily-entry type (9.16.12). A journal entry whose title is a
 *  canonical `YYYY-MM-DD` projects to an all-day item on that day; periodic
 *  rollup entries (week / month titles) are excluded. */
export const JOURNAL_ENTRY_TYPE = "io.brainstorm.journal/Entry/v1";
