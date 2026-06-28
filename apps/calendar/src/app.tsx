/**
 * Calendar app (React) — boot + orchestration.
 *
 * Source resolution:
 *   - **shell launch** (`window.brainstorm` present): live entities through
 *     `useVaultEntities` (the one shared reactivity stack) projected via the
 *     pure `logic/from-vault-entities`, merged with the Calendar-owned
 *     `Event/v1` rows read from `entities.db` through the local repo.
 *   - **standalone** (`window.brainstorm` undefined): the in-memory demo
 *     dataset so the chrome stays useful in `vite preview` / isolated dev.
 */

import "./types";

import { useVaultEntities } from "@brainstorm/react-yjs";
import { openEntity } from "@brainstorm/sdk";
import type { ObjectDragPayload } from "@brainstorm/sdk-types";
import { IconName } from "@brainstorm/sdk/icon";
import { NavButtons, createNavHistory } from "@brainstorm/sdk/nav-history";
import type { ObjectMenuContext } from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { useResizable } from "@brainstorm/sdk/resizable";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { DEMO_ITEMS, DEMO_NOW } from "./demo/dataset";
import { t } from "./i18n/t";
import { bulkShiftToDate } from "./logic/bulk-reschedule";
import { type CalendarSource, discoverSources } from "./logic/calendar-sources";
import {
	type CompiledView,
	compileAgendaView,
	compileDayView,
	compileMonthView,
	compileWeekView,
	compileYearView,
} from "./logic/compile-view";
import { parseComposePayload } from "./logic/compose-payload";
import { copyEventBlockRef } from "./logic/copy-event-block-ref";
import { addDays, addMonths, startOfDay, startOfMonth, startOfWeek } from "./logic/date-range";
import { defaultEventStart } from "./logic/default-event-start";
import {
	eventToScheduledItem,
	mergeScheduledItems,
	vaultSnapshotToScheduledItems,
} from "./logic/from-vault-entities";
import { createReminderScheduler } from "./logic/reminder-schedule";
import { rescheduleEvent } from "./logic/reschedule";
import { dropDateValue, resolveDropDateKey } from "./logic/resolve-drop-date-key";
import {
	EVENT_SOURCE_KEY,
	JOURNAL_SOURCE_KEY,
	type ScheduledItem,
	parseSourceKey,
} from "./logic/scheduled-item";
import { defaultHiddenSources, loadHiddenSources, saveHiddenSources } from "./logic/source-prefs";
import { useDateKeyInfo } from "./logic/use-date-key-info";
import { JOURNAL_ENTRY_TYPE, getCalendarRuntime } from "./runtime";
import { ActionId, bindShortcut } from "./shortcuts";
import { EVENT_TYPE, createEntitiesRepository } from "./storage/entities-repository";
import type { EventsRepository } from "./storage/repository";
import { getStorageRuntime } from "./storage/runtime";
import { CalendarViewKind, WeekStartsOn } from "./types/calendar-view";
import type { Event } from "./types/event";
import { IntentVerb } from "./types/intent";
import { AgendaView } from "./ui/react/agenda-view";
import { BulkReschedule } from "./ui/react/bulk-reschedule";
import { CalDavDialog } from "./ui/react/caldav-dialog";
import { CalendarHeaderActions, CalendarHeaderLead } from "./ui/react/calendar-header";
import { EventDetail, EventDetailOutcome, type EventDetailResult } from "./ui/react/event-detail";
import { IcsActionsButton } from "./ui/react/ics-actions-button";
import { MonthView } from "./ui/react/month-view";
import { SearchOverlay } from "./ui/react/search-overlay";
import { SelectionBar } from "./ui/react/selection-bar";
import { Sidebar } from "./ui/react/sidebar";
import type { ViewCallbacks } from "./ui/react/view-callbacks";
import { WeekView } from "./ui/react/week-view";
import { YearView } from "./ui/react/year-view";
import { reminderOffsetLabel } from "./ui/reminder-labels";

const REMINDER_TICK_MS = 30_000;
const SIDEBAR_OPEN_KEY = "calendar:sidebar-open";

/** The owning entity type behind an item's source key — drives the object
 *  menu target. Built-in keys map to their type; a property-derived key
 *  carries its type in the key itself. */
function entityTypeForItem(item: ScheduledItem): string {
	if (item.sourceKey === EVENT_SOURCE_KEY) return EVENT_TYPE;
	if (item.sourceKey === JOURNAL_SOURCE_KEY) return JOURNAL_ENTRY_TYPE;
	return parseSourceKey(item.sourceKey)?.entityType ?? "";
}

function startOfYear(epochMs: number): number {
	return new Date(new Date(epochMs).getFullYear(), 0, 1).getTime();
}

type NavLoc = { viewKind: CalendarViewKind; anchor: number };

type DetailState = { event: Event | null; defaultStart: number } | null;

function readSidebarOpen(): boolean {
	try {
		const raw = localStorage.getItem(SIDEBAR_OPEN_KEY);
		return raw === null ? true : raw === "true";
	} catch {
		return true;
	}
}

export function CalendarApp() {
	const runtime = useMemo(() => getCalendarRuntime(), []);
	const storageRuntime = useMemo(() => getStorageRuntime(), []);
	const vaultMode = Boolean(runtime?.services?.vaultEntities?.list);

	const repository = useMemo<EventsRepository | null>(() => {
		const entitiesSvc = storageRuntime?.services?.entities ?? null;
		return entitiesSvc ? createEntitiesRepository(entitiesSvc) : null;
	}, [storageRuntime]);

	const caldavService = runtime?.services?.caldav ?? null;

	const nowAnchor = useCallback(() => (vaultMode ? Date.now() : DEMO_NOW), [vaultMode]);

	// ── View state ──────────────────────────────────────────────────────
	const [viewKind, setViewKind] = useState<CalendarViewKind>(CalendarViewKind.Month);
	const [anchor, setAnchorState] = useState<number>(() =>
		startOfMonth(vaultMode ? Date.now() : DEMO_NOW),
	);
	const weekStartsOn = WeekStartsOn.Monday;
	const propertiesSvc = runtime?.services?.properties ?? null;
	const settingsSvc = runtime?.services?.settings ?? null;
	const dateKeyInfo = useDateKeyInfo(propertiesSvc);
	const [hiddenSources, setHiddenSources] = useState<Set<string>>(() => defaultHiddenSources());

	// ── Sidebar (open + resizable width) ────────────────────────────────
	const [sidebarOpen, setSidebarOpen] = useState<boolean>(readSidebarOpen);
	const { handleProps, width } = useResizable({
		side: "left",
		defaultWidth: 248,
		min: 200,
		max: 420,
		storageKey: "calendar:sidebar-width",
	});

	// ── Live data: vault projection + Calendar-owned events ─────────────
	const { entities, links } = useVaultEntities(runtime?.services?.vaultEntities ?? null);
	const vaultItems = useMemo(
		() => (vaultMode ? vaultSnapshotToScheduledItems({ entities, links }, dateKeyInfo) : []),
		[vaultMode, entities, links, dateKeyInfo],
	);

	// Hydrate the per-device source-filter visibility.
	useEffect(() => {
		let cancelled = false;
		void loadHiddenSources(settingsSvc ?? undefined).then((set) => {
			if (!cancelled) setHiddenSources(set);
		});
		return () => {
			cancelled = true;
		};
	}, [settingsSvc]);

	// Calendar-owned Event rows, keyed by id (loaded from the repo; the demo
	// dataset stands in for standalone mode). A version counter forces a
	// reload after a save/delete/import.
	const [eventsById, setEventsById] = useState<Map<string, Event>>(() => new Map());
	const [eventsVersion, setEventsVersion] = useState(0);
	// `eventsVersion` re-reads after a local save/delete/import; `entities`
	// re-reads after any vault write (a Tasks-app edit or dev reseed). Both are
	// deliberate re-run triggers, not values read in the body.
	// biome-ignore lint/correctness/useExhaustiveDependencies: eventsVersion/entities are reload triggers
	useEffect(() => {
		if (!repository) return;
		let cancelled = false;
		void repository.listAll().then(
			(events) => {
				if (cancelled) return;
				setEventsById(new Map(events.map((e) => [e.id, e])));
			},
			(error: unknown) => console.warn("[calendar] events.listAll failed", error),
		);
		return () => {
			cancelled = true;
		};
	}, [repository, eventsVersion, entities]);

	const items = useMemo<readonly ScheduledItem[]>(() => {
		if (!vaultMode) {
			const events = [...eventsById.values()].map(eventToScheduledItem);
			const nonEvents = DEMO_ITEMS.filter((i) => i.sourceKey !== EVENT_SOURCE_KEY);
			return mergeScheduledItems(nonEvents, events);
		}
		const events = [...eventsById.values()].map(eventToScheduledItem);
		return mergeScheduledItems(vaultItems, events);
	}, [vaultMode, eventsById, vaultItems]);

	// In standalone mode the demo dataset's non-event items seed `eventsById`
	// is empty, so we surface the full demo list until a user edit lands.
	const effectiveItems = useMemo<readonly ScheduledItem[]>(() => {
		if (!vaultMode && eventsById.size === 0) return DEMO_ITEMS;
		return items;
	}, [vaultMode, eventsById, items]);

	// The discovered, toggleable source list the sidebar renders (9.15f).
	const sources = useMemo<CalendarSource[]>(
		() => discoverSources(effectiveItems, dateKeyInfo),
		[effectiveItems, dateKeyInfo],
	);

	// ── Navigation history ──────────────────────────────────────────────
	const navHist = useMemo(
		() =>
			createNavHistory<NavLoc>({
				initial: {
					viewKind: CalendarViewKind.Month,
					anchor: startOfMonth(vaultMode ? Date.now() : DEMO_NOW),
				},
				persist: { key: "calendar:nav" },
			}),
		[vaultMode],
	);
	const recordNav = useCallback((loc: NavLoc) => navHist.push(loc), [navHist]);
	const applyNavLoc = useCallback((loc: NavLoc) => {
		setViewKind(loc.viewKind);
		setAnchorState(loc.anchor);
	}, []);

	// ── Selection (Cmd/Ctrl-click owned events) ─────────────────────────
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
	const [bulkOpen, setBulkOpen] = useState(false);

	// ── Dialogs ─────────────────────────────────────────────────────────
	const [detail, setDetail] = useState<DetailState>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [caldavOpen, setCaldavOpen] = useState(false);

	const itemsRef = useRef(effectiveItems);
	itemsRef.current = effectiveItems;
	const eventsRef = useRef(eventsById);
	eventsRef.current = eventsById;
	// Live vault entities + date-key set, read at drop time by the cross-app
	// object-drop handler (kept in refs so the handler is a stable callback that
	// never goes stale on a vault change).
	const entitiesRef = useRef(entities);
	entitiesRef.current = entities;
	const dateKeyInfoRef = useRef(dateKeyInfo);
	dateKeyInfoRef.current = dateKeyInfo;
	// Latest anchor, read by nav actions so they can compute the next anchor +
	// record nav OUTSIDE the setAnchorState updater — calling recordNav (which
	// notifies the nav-history subscribers → setState) from inside the updater
	// runs during render and trips React's "setState in render" warning.
	const anchorRef = useRef(anchor);
	anchorRef.current = anchor;

	// ── Navigation actions ──────────────────────────────────────────────
	const setView = useCallback(
		(kind: CalendarViewKind) => {
			const cur = anchorRef.current;
			let next = cur;
			if (kind === CalendarViewKind.Day) next = startOfDay(cur);
			if (kind === CalendarViewKind.Week) next = startOfWeek(cur, weekStartsOn);
			if (kind === CalendarViewKind.Year) next = startOfYear(cur);
			setAnchorState(next);
			setViewKind(kind);
			recordNav({ viewKind: kind, anchor: next });
		},
		[recordNav, weekStartsOn],
	);

	const openMonth = useCallback(
		(monthStart: number) => {
			const next = startOfMonth(monthStart);
			setViewKind(CalendarViewKind.Month);
			setAnchorState(next);
			recordNav({ viewKind: CalendarViewKind.Month, anchor: next });
		},
		[recordNav],
	);

	const setAnchor = useCallback(
		(epochMs: number) => {
			setAnchorState(epochMs);
			recordNav({ viewKind, anchor: epochMs });
		},
		[recordNav, viewKind],
	);

	const goToday = useCallback(() => {
		const next = startOfDay(nowAnchor());
		setAnchorState(next);
		recordNav({ viewKind, anchor: next });
	}, [nowAnchor, recordNav, viewKind]);

	const step = useCallback(
		(direction: 1 | -1) => {
			const cur = anchorRef.current;
			let next = cur;
			switch (viewKind) {
				case CalendarViewKind.Month:
					next = addMonths(cur, direction);
					break;
				case CalendarViewKind.Week:
					next = addDays(cur, 7 * direction);
					break;
				case CalendarViewKind.Day:
					next = addDays(cur, direction);
					break;
				case CalendarViewKind.Agenda:
					next = addDays(cur, 7 * direction);
					break;
				case CalendarViewKind.Year:
					next = addMonths(cur, 12 * direction);
					break;
			}
			setAnchorState(next);
			recordNav({ viewKind, anchor: next });
		},
		[recordNav, viewKind],
	);

	const toggleSource = useCallback(
		(key: string) => {
			setHiddenSources((cur) => {
				const next = new Set(cur);
				if (next.has(key)) {
					next.delete(key);
				} else {
					// Never hide the last visible source.
					const visibleCount = sources.filter((s) => !cur.has(s.key)).length;
					if (visibleCount <= 1) return cur;
					next.add(key);
				}
				void saveHiddenSources(settingsSvc ?? undefined, next);
				return next;
			});
		},
		[sources, settingsSvc],
	);

	const toggleSidebar = useCallback(() => {
		setSidebarOpen((open) => {
			const next = !open;
			try {
				localStorage.setItem(SIDEBAR_OPEN_KEY, String(next));
			} catch {
				/* private mode / quota — fine */
			}
			return next;
		});
	}, []);

	// ── Persistence: apply a detail-surface / drag result ──────────────
	const applyDetailResult = useCallback(
		(result: EventDetailResult) => {
			void (async () => {
				if (result.kind === EventDetailOutcome.Saved) {
					setEventsById((cur) => new Map(cur).set(result.event.id, result.event));
					if (repository) await repository.save(result.event);
				} else {
					setEventsById((cur) => {
						const next = new Map(cur);
						next.delete(result.id);
						return next;
					});
					if (repository) await repository.remove(result.id);
				}
				setEventsVersion((v) => v + 1);
			})();
		},
		[repository],
	);

	// F-218: only Day view's anchor is an explicitly chosen day — the month /
	// week / year anchors are period starts, not a selection, so composing
	// from them defaults to today at the next full hour.
	const defaultComposeStart = useCallback(
		(): number =>
			defaultEventStart({
				selectedDayStart: viewKind === CalendarViewKind.Day ? startOfDay(anchor) : null,
				now: nowAnchor(),
			}),
		[anchor, viewKind, nowAnchor],
	);

	const openDetailFor = useCallback((event: Event | null, defaultStart: number) => {
		setDetail({ event, defaultStart });
	}, []);

	// ── Selection helpers ───────────────────────────────────────────────
	const toggleSelection = useCallback((item: ScheduledItem) => {
		if (!eventsRef.current.has(item.sourceEntityId)) return;
		setSelectedIds((cur) => {
			const next = new Set(cur);
			if (next.has(item.sourceEntityId)) next.delete(item.sourceEntityId);
			else next.add(item.sourceEntityId);
			return next;
		});
	}, []);

	const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

	const bulkMove = useCallback(
		async (targetDayStart: number) => {
			const events: Event[] = [];
			for (const id of selectedIds) {
				const ev = eventsRef.current.get(id);
				if (ev) events.push(ev);
			}
			const shifted = bulkShiftToDate(events, targetDayStart);
			setEventsById((cur) => {
				const next = new Map(cur);
				for (const ev of shifted) next.set(ev.id, ev);
				return next;
			});
			if (repository) for (const ev of shifted) await repository.save(ev);
			clearSelection();
			setEventsVersion((v) => v + 1);
		},
		[selectedIds, repository, clearSelection],
	);

	// ── Item interactions ───────────────────────────────────────────────
	const onItemClick = useCallback(
		(item: ScheduledItem, event?: ReactMouseEvent) => {
			if (event && (event.metaKey || event.ctrlKey)) {
				toggleSelection(item);
				return;
			}
			if (item.sourceKey === EVENT_SOURCE_KEY) {
				const owned = eventsRef.current.get(item.sourceEntityId);
				if (owned) {
					openDetailFor(owned, owned.start);
					return;
				}
			}
			void openEntity(runtime, { entityId: item.sourceEntityId }).then((handled) => {
				if (!handled) {
					console.info("[calendar] item.click", item.sourceKey, item.sourceEntityId, item.title);
				}
			});
		},
		[runtime, toggleSelection, openDetailFor],
	);

	const onDayClick = useCallback((dayStart: number) => {
		setAnchorState(dayStart);
		setViewKind(CalendarViewKind.Day);
	}, []);

	const composeEvent = useCallback((start: number) => openDetailFor(null, start), [openDetailFor]);

	const onReschedule = useCallback(
		(item: ScheduledItem, newStart: number) => {
			if (item.sourceKey === EVENT_SOURCE_KEY) {
				const owned = eventsRef.current.get(item.sourceEntityId);
				if (!owned) return;
				applyDetailResult({ kind: EventDetailOutcome.Saved, event: rescheduleEvent(owned, newStart) });
				return;
			}
			// Property-derived items rewrite the *same* date property they were
			// projected from; read-only sources (birthdays) aren't draggable.
			if (item.readonly) return;
			const parsed = parseSourceKey(item.sourceKey);
			if (!parsed) return;
			const entitiesSvc = storageRuntime?.services?.entities;
			if (!entitiesSvc) return;
			void entitiesSvc
				.update(item.sourceEntityId, { [parsed.propertyKey]: newStart })
				.then(() => setEventsVersion((v) => v + 1))
				.catch((error: unknown) => console.warn("[calendar] reschedule failed", error));
		},
		[applyDetailResult, storageRuntime],
	);

	// Cross-app object drop onto a day (DND-4, §III set-property):
	// an object dragged from another app's window lands on a Calendar day cell and
	// has its date property set to that day. The dropped item carries only a
	// reference (id + type); the real properties are read from the live vault
	// projection here, the date key is resolved (reuse an existing dated key, else
	// `scheduledAt`), and the value is written through the SAME entities service
	// the chip-reschedule path uses. Calendar-owned `Event/v1` items are vault
	// rows too and go through the same update; an item not in the vault (e.g. an
	// unresolvable id) is skipped.
	const onDropObject = useCallback(
		(dayStart: number, payload: ObjectDragPayload) => {
			const entitiesSvc = storageRuntime?.services?.entities;
			if (!entitiesSvc) return;
			const byId = new Map(entitiesRef.current.map((e) => [e.id, e]));
			const dateKeys = dateKeyInfoRef.current.keys;
			for (const item of payload.items) {
				const entity = byId.get(item.entityId);
				if (!entity || entity.deletedAt !== null) continue;
				const key = resolveDropDateKey(entity.properties, dateKeys);
				const value = dropDateValue(entity.properties[key], dayStart);
				// Refresh only when the write actually lands — a fail-closed
				// capability rejection must not paint the day as if it accepted.
				void entitiesSvc
					.update(item.entityId, { [key]: value })
					.then(() => setEventsVersion((v) => v + 1))
					.catch((error: unknown) => console.warn("[calendar] object-drop failed", error));
			}
		},
		[storageRuntime],
	);

	// Delete the entity behind a calendar item. Owned events route through the
	// repository-backed detail path; Task / Note / Journal rows delete the
	// source entity via the entities service (the reactive vault projection then
	// drops the row). Birthdays are excluded — they're a derived view of a
	// Contact's anniversary, so "Delete" there would nuke the contact.
	const deleteItem = useCallback(
		(item: ScheduledItem) => {
			if (item.sourceKey === EVENT_SOURCE_KEY) {
				applyDetailResult({ kind: EventDetailOutcome.Deleted, id: item.sourceEntityId });
				return;
			}
			const entitiesSvc = storageRuntime?.services?.entities;
			if (!entitiesSvc) return;
			void entitiesSvc
				.delete(item.sourceEntityId)
				.catch((error: unknown) => console.warn("[calendar] delete failed", error));
		},
		[applyDetailResult, storageRuntime],
	);

	const objectMenuFor = useCallback(
		(item: ScheduledItem): ObjectMenuContext => {
			const isOwnedEvent =
				item.sourceKey === EVENT_SOURCE_KEY && eventsRef.current.has(item.sourceEntityId);
			// A read-only source (a birthday) must not offer Delete — that would
			// nuke the underlying person, not a calendar placement.
			const canDelete = isOwnedEvent || !item.readonly;
			return {
				target: {
					entityId: item.sourceEntityId,
					entityType: entityTypeForItem(item),
				},
				runtime,
				labels: { remove: t("calendar.menu.delete") },
				...(isOwnedEvent
					? {
							extraItems: [
								{
									id: "copy-block-ref",
									label: t("calendar.event.copyBlockRef"),
									icon: IconName.Copy,
									run: async () => {
										if (await copyEventBlockRef(item.sourceEntityId)) {
											runtime?.services?.ui?.notify?.({ title: t("calendar.event.copyBlockRef.done") });
										}
									},
								},
							],
						}
					: {}),
				...(canDelete ? { onRemove: () => deleteItem(item) } : {}),
			};
		},
		[runtime, deleteItem],
	);

	// ── Compiled view ───────────────────────────────────────────────────
	const compiled = useMemo<CompiledView>(() => {
		const filtered = effectiveItems.filter((i) => !hiddenSources.has(i.sourceKey));
		const options = { anchor, weekStartsOn, now: nowAnchor() };
		switch (viewKind) {
			case CalendarViewKind.Month:
				return compileMonthView(filtered, options);
			case CalendarViewKind.Week:
				return compileWeekView(filtered, options);
			case CalendarViewKind.Day:
				return compileDayView(filtered, options);
			case CalendarViewKind.Agenda:
				return compileAgendaView(filtered, options);
			case CalendarViewKind.Year:
				return compileYearView(filtered, options);
		}
	}, [effectiveItems, hiddenSources, anchor, weekStartsOn, viewKind, nowAnchor]);

	// ── Search ──────────────────────────────────────────────────────────
	const onSearchPick = useCallback(
		(item: ScheduledItem) => {
			setAnchorState(startOfDay(item.start));
			setViewKind(CalendarViewKind.Day);
			recordNav({ viewKind: CalendarViewKind.Day, anchor: startOfDay(item.start) });
			onItemClick(item);
		},
		[recordNav, onItemClick],
	);

	// ── Effects: shortcuts ──────────────────────────────────────────────
	useEffect(() => {
		const unbinds = [
			bindShortcut(ActionId.GoMonth, () => setView(CalendarViewKind.Month)),
			bindShortcut(ActionId.GoWeek, () => setView(CalendarViewKind.Week)),
			bindShortcut(ActionId.GoDay, () => setView(CalendarViewKind.Day)),
			bindShortcut(ActionId.GoAgenda, () => setView(CalendarViewKind.Agenda)),
			bindShortcut(ActionId.GoYear, () => setView(CalendarViewKind.Year)),
			bindShortcut(ActionId.GoToday, goToday),
			bindShortcut(ActionId.GoPrevRange, () => step(-1)),
			bindShortcut(ActionId.GoNextRange, () => step(1)),
			bindShortcut(ActionId.Compose, () => composeEvent(defaultComposeStart())),
			bindShortcut(ActionId.Search, () => setSearchOpen(true)),
		];
		return () => {
			for (const off of unbinds) off();
		};
	}, [setView, goToday, step, composeEvent, defaultComposeStart]);

	// ── Effects: inbound compose intent ─────────────────────────────────
	useEffect(() => {
		if (!runtime) return;
		runtime.on("intent", (event) => {
			if (event.type !== "intent") return;
			if (event.intent.verb === IntentVerb.Compose) {
				const start = parseComposePayload(event.intent.payload)?.start ?? defaultComposeStart();
				openDetailFor(null, start);
			}
		});
	}, [runtime, defaultComposeStart, openDetailFor]);

	// ── Effects: in-app reminder scheduler ──────────────────────────────
	useEffect(() => {
		const notify = runtime?.services?.ui?.notify;
		if (!vaultMode || !notify) return;
		const scheduler = createReminderScheduler({
			startedAt: Date.now(),
			getItems: () =>
				[...eventsRef.current.values()].map((e) => ({
					id: e.id,
					title: e.title,
					start: e.start,
					reminders: e.reminders,
				})),
			notify: (due) => {
				void notify({
					title: t("calendar.reminder.notify.title", { title: due.title }),
					body:
						due.minutes <= 0
							? t("calendar.reminder.notify.bodyAtStart")
							: t("calendar.reminder.notify.body", { label: reminderOffsetLabel(due.minutes) }),
				});
			},
		});
		const interval = window.setInterval(() => scheduler.tick(Date.now()), REMINDER_TICK_MS);
		return () => {
			window.clearInterval(interval);
			scheduler.dispose();
		};
	}, [runtime, vaultMode]);

	const now = nowAnchor();
	const selectionCount = selectedIds.size;

	const filesService = storageRuntime?.services?.files ?? null;
	const uiNotify = runtime?.services?.ui?.notify;

	return (
		<>
			<header className="app-header">
				<div className="app-header__left">
					<NavButtons history={navHist} onNavigate={applyNavLoc} />
					<div className="cal-header__lead-slot">
						<CalendarHeaderLead
							viewKind={viewKind}
							anchor={anchor}
							weekStartsOn={weekStartsOn}
							onPrev={() => step(-1)}
							onNext={() => step(1)}
							onToday={goToday}
						/>
					</div>
				</div>
				<div className="app-header__right">
					<CalendarHeaderActions
						viewKind={viewKind}
						onViewKind={setView}
						onNewEvent={() => composeEvent(defaultComposeStart())}
						onSearch={() => setSearchOpen(true)}
					/>
					<PanelToggleButton
						side={PanelSide.Left}
						open={sidebarOpen}
						onClick={toggleSidebar}
						labels={{ show: t("calendar.header.sidebar.show"), hide: t("calendar.header.sidebar.hide") }}
					/>
					{filesService ? (
						<IcsActionsButton
							files={filesService}
							getEvents={() => [...eventsRef.current.values()]}
							onImport={async (events) => {
								setEventsById((cur) => {
									const next = new Map(cur);
									for (const ev of events) next.set(ev.id, ev);
									return next;
								});
								if (repository) for (const ev of events) await repository.save(ev);
								setEventsVersion((v) => v + 1);
							}}
							{...(uiNotify ? { notify: (message: string) => void uiNotify({ title: message }) } : {})}
							{...(caldavService && storageRuntime?.services?.entities
								? { onOpenCalDav: () => setCaldavOpen(true) }
								: {})}
						/>
					) : null}
				</div>
			</header>

			<main
				className="calendar-main"
				data-sidebar-open={String(sidebarOpen)}
				data-view-kind={viewKind}
				style={{ ["--cal-sidebar-width" as string]: `${width}px` }}
			>
				<div id="calendar-sidebar-slot">
					<Sidebar
						anchor={anchor}
						now={now}
						weekStartsOn={weekStartsOn}
						sources={sources}
						hiddenSources={hiddenSources}
						onAnchor={setAnchor}
						onToggleSource={toggleSource}
					/>
				</div>
				<div
					className="calendar-resize"
					aria-label={t("calendar.chrome.resizeSidebar")}
					{...handleProps}
				/>
				<div className="calendar-content">
					<div className="calendar-view-slot">
						<CalendarViews
							compiled={compiled}
							now={now}
							weekStartsOn={weekStartsOn}
							callbacks={{
								onItemClick,
								onDayClick,
								onEmptyCellClick: composeEvent,
								onMonthOpen: openMonth,
								objectMenu: objectMenuFor,
								onReschedule,
								...(storageRuntime?.services?.entities ? { onDropObject } : {}),
							}}
						/>
					</div>
				</div>
				{selectionCount > 0 ? (
					<div className="cal-selection-slot">
						<SelectionBar
							count={selectionCount}
							onReschedule={() => setBulkOpen(true)}
							onClear={clearSelection}
						/>
					</div>
				) : null}
			</main>

			{detail ? (
				<EventDetail
					event={detail.event}
					defaultStart={detail.defaultStart}
					onResolve={applyDetailResult}
					onClose={() => setDetail(null)}
					locked={detail.event?.locked ?? false}
					{...(detail.event
						? {
								objectMenu: () => objectMenuFor(eventToScheduledItem(detail.event as Event)),
								onToggleLock: () => {
									const ev = detail.event;
									if (!ev) return;
									const next = !ev.locked;
									void storageRuntime?.services?.entities?.update?.(ev.id, { locked: next });
									setDetail((d) => (d?.event ? { ...d, event: { ...d.event, locked: next } } : d));
								},
							}
						: {})}
				/>
			) : null}

			{caldavOpen && caldavService && storageRuntime?.services?.entities ? (
				<CalDavDialog
					caldav={caldavService}
					entities={storageRuntime.services.entities}
					onClose={() => {
						setCaldavOpen(false);
						// A sync may have pulled/edited Event/v1 rows — re-read.
						setEventsVersion((v) => v + 1);
					}}
					{...(uiNotify ? { notify: (message: string) => void uiNotify({ title: message }) } : {})}
				/>
			) : null}

			{searchOpen ? (
				<SearchOverlay
					getItems={() => itemsRef.current}
					now={now}
					onPick={onSearchPick}
					onClose={() => setSearchOpen(false)}
				/>
			) : null}

			{bulkOpen ? (
				<BulkReschedule
					count={selectionCount}
					defaultDayStart={(() => {
						const starts = [...selectedIds]
							.map((id) => eventsRef.current.get(id)?.start)
							.filter((s): s is number => typeof s === "number");
						return starts.length > 0 ? startOfDay(Math.min(...starts)) : startOfDay(now);
					})()}
					onMove={(target) => void bulkMove(target)}
					onClose={() => setBulkOpen(false)}
				/>
			) : null}
		</>
	);
}

function CalendarViews({
	compiled,
	now,
	weekStartsOn,
	callbacks,
}: {
	compiled: CompiledView;
	now: number;
	weekStartsOn: WeekStartsOn;
	callbacks: ViewCallbacks;
}) {
	switch (compiled.kind) {
		case CalendarViewKind.Month:
			return <MonthView compiled={compiled} weekStartsOn={weekStartsOn} callbacks={callbacks} />;
		case CalendarViewKind.Week:
		case CalendarViewKind.Day:
			return <WeekView compiled={compiled} now={now} callbacks={callbacks} />;
		case CalendarViewKind.Agenda:
			return <AgendaView compiled={compiled} now={now} callbacks={callbacks} />;
		case CalendarViewKind.Year:
			return <YearView compiled={compiled} weekStartsOn={weekStartsOn} callbacks={callbacks} />;
	}
}
