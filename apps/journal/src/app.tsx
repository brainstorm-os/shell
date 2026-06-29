/**
 * Journal app (React, all-apps-React track).
 *
 * Daily-log surface modeled as a three-pane layout: a left mini-calendar
 * sidebar (entry-density + mood dots, streak badge, go-to-date, rollups,
 * reminder settings, all-entries overview), the focused day's body (the live
 * `<BrainstormEditor>` island, word-count meta, check-in mood/habits,
 * backlinks), and a right properties panel.
 *
 * Reactivity: the live entry list is derived from the whole-vault snapshot read
 * through the ONE shared stack — `@brainstorm/react-yjs` `useVaultEntities`
 * (which owns the change subscription + coalescing). The day body itself is a
 * Yjs-bound editor island. There is NO hand-rolled `onChange → list → setState`
 * loop — a Notes-app edit, an autosave, or a write from another device
 * re-derives the projection automatically.
 *
 * Standalone (`vite preview`, no `window.brainstorm`): falls back to the
 * in-memory demo dataset; the editor degrades to a read-only paragraph and the
 * mutation paths (create / icon / check-in) no-op per the preview-drop pattern.
 */

import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/editor/editor.css";
import "@brainstorm/editor/editor-theme.css";
import { type CommentsFocusRequest, RightPanelTab } from "@brainstorm/editor";
import { useVaultEntities } from "@brainstorm/react-yjs";
import { navModeFromEvent, openEntity } from "@brainstorm/sdk";
import type { CommentAnchor, Icon } from "@brainstorm/sdk-types";
import { MiniCalendar, openCalendarPopover } from "@brainstorm/sdk/calendar";
import type { MonthGridReactCell } from "@brainstorm/sdk/calendar";
import { Checkbox } from "@brainstorm/sdk/checkbox";
import { DatePager } from "@brainstorm/sdk/date-pager";
import {
	attachFindBar,
	attachFindShortcuts,
	createDomTextSearchProvider,
	createFindController,
} from "@brainstorm/sdk/find-replace";
import { Icon as Glyph, IconName } from "@brainstorm/sdk/icon";
import { LockButton } from "@brainstorm/sdk/lock-button";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { NavButtons, createNavHistory } from "@brainstorm/sdk/nav-history";
import {
	type AnchoredMenuItem,
	type ObjectMenuChromeLabels,
	type ObjectMenuRuntime,
	openAnchoredMenu,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { IconPickerButton } from "@brainstorm/sdk/picker-host";
import { applyPersistedPanelWidth, attachResizable } from "@brainstorm/sdk/resizable";
import { attachShortcut } from "@brainstorm/sdk/shortcut";
import { mountSpellcheckMenuFromWindow } from "@brainstorm/sdk/spellcheck-menu";
import type { SerializedEditorState } from "lexical";
import {
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { buildJournalDemo } from "./demo/dataset";
import {
	type Backlink,
	type OutgoingLink,
	findBacklinks,
	findOutgoingLinks,
} from "./logic/backlinks";
import { shiftByDays } from "./logic/calendar-grid";
import {
	HABIT_LABEL_KEY,
	type HabitId,
	JOURNAL_HABITS,
	JOURNAL_MOODS,
	MOOD_LABEL_KEY,
	type MoodId,
	toggleHabit,
} from "./logic/check-in";
import { JournalDayBodyMode, journalDayBodyMode } from "./logic/day-body-mode";
import { buildJournalDenormalizer } from "./logic/denormalize-entry";
import { groupEntriesByMonth, monthLabelFromKey } from "./logic/entry-overview";
import { JOURNAL_CHORDS, JournalChordId } from "./logic/journal-chords";
import {
	type JournalExportLabels,
	entriesInRange,
	journalToHtml,
	journalToMarkdown,
} from "./logic/journal-export";
import { buildJournalT, journalPlural } from "./logic/journal-i18n";
import {
	dateKeyForJournal,
	journalEntryIdForKey,
	journalEntryIdToDateMs,
	journalNoteTitle,
	parseJournalDateKey,
} from "./logic/journal-keys";
import { indexByDateKey, projectJournalEntries } from "./logic/journal-projection";
import {
	PeriodKind,
	type PeriodicDayLink,
	buildPeriodicSeedState,
	constituentDayKeys,
	periodKeyOf,
	periodLabel,
	periodStableId,
} from "./logic/periods";
import { currentStreak, densityBucket, streakAtRisk } from "./logic/streaks";
import {
	JOURNAL_TEMPLATE_SPECS,
	type JournalTemplate,
	templateToSeedState,
} from "./logic/templates";
import { parseReminderTime, shouldFireWriteReminder } from "./logic/write-reminder";
import {
	JOURNAL_ENTRY_TYPE,
	type VaultSnapshot,
	getJournalRuntime,
	notesFromSnapshot,
} from "./runtime";
import { pushEntityIndex, wireEditorIndex } from "./store/editor-index";
import { getYDocResolverApi } from "./store/ydoc-resolver";
import type { JournalEntry } from "./types/entry";
import { DEFAULT_JOURNAL_VIEW } from "./types/view";
import {
	ENTITY_ID_ATTR,
	ENTITY_TYPE_ATTR,
	type JournalMenuResolver,
	bindDelegatedObjectMenu,
} from "./ui/delegated-object-menu";
import { applyJournalSuggestion, insertEntityMention } from "./ui/editor-bridge";
import type { JournalCommentHooks, JournalDenormalizeFn } from "./ui/entry-editor-mount";
import { attachOverviewKeyboard } from "./ui/overview-keyboard";
import { JournalPropertiesIsland, type JournalPropertiesOptions } from "./ui/properties-panel";
import { EntityIcon } from "./ui/react/entity-icon";
import { EntryEditorIsland } from "./ui/react/entry-editor-island";
import { openJournalSearch } from "./ui/search-overlay";

const t = buildJournalT();

const ENTITY_LABEL_ATTR = "data-entity-label";

const LINK_TYPE_NOTE_LINK = "io.brainstorm.notes/link";

const NAV_WIDTH_KEY = "journal:nav-width";
const PROPS_WIDTH_KEY = "journal:props-width";
const NAV_OPEN_PREF_KEY = "journal:navOpen";
const PROPS_OPEN_PREF_KEY = "journal:propsOpen";

const REMINDER_ENABLED_KEY = "journal:reminderEnabled";
const REMINDER_TIME_KEY = "journal:reminderTime";
const REMINDER_LAST_FIRED_KEY = "journal:reminderLastFired";
const DEFAULT_REMINDER_TIME = "20:00";
const REMINDER_TICK_MS = 60_000;

type PeriodicView = { id: string; kind: PeriodKind; key: string; label: string };

function readPanelPref(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		return raw !== "false";
	} catch {
		return fallback;
	}
}

function writePanelPref(key: string, open: boolean): void {
	try {
		localStorage.setItem(key, String(open));
	} catch {
		// Quota / disabled — pref reverts to default on reload.
	}
}

function readLocal(key: string, fallback: string): string {
	try {
		return localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

function writeLocal(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Quota / disabled.
	}
}

// Persisted panel widths land on the `--journal-nav-width` / `--journal-props-width`
// CSS variables BEFORE first paint so the open-state grid doesn't flash from
// default → persisted width on every launch (the precaution Notes takes).
applyPersistedPanelWidth({
	storageKey: NAV_WIDTH_KEY,
	cssVar: "--journal-nav-width",
	defaultWidth: 260,
	min: 220,
	max: 420,
});
applyPersistedPanelWidth({
	storageKey: PROPS_WIDTH_KEY,
	cssVar: "--journal-props-width",
	defaultWidth: 320,
	min: 260,
	max: 480,
});

function canMutate(): boolean {
	return Boolean(getJournalRuntime()?.services?.entities?.create);
}

enum ExportFormat {
	Md = "md",
	Html = "html",
}

export function JournalApp(): ReactElement {
	const now = useMemo(() => new Date(), []);
	const todayKey = useMemo(() => dateKeyForJournal(now), [now]);

	const [ready, setReady] = useState(false);
	const [focus, setFocus] = useState<Date>(() => new Date());
	const [monthFocus, setMonthFocus] = useState<Date>(
		() => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
	);
	const [periodic, setPeriodic] = useState<PeriodicView | null>(null);
	const [navOpen, setNavOpen] = useState(() => readPanelPref(NAV_OPEN_PREF_KEY, true));
	const [propsOpen, setPropsOpen] = useState(() => readPanelPref(PROPS_OPEN_PREF_KEY, false));

	// Comments (B11.9) — right-panel tab + pending comment-on-selection /
	// click-to-thread state shared between the editor island and the panel.
	const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>(RightPanelTab.Properties);
	const [pendingCommentAnchor, setPendingCommentAnchor] = useState<CommentAnchor | null>(null);
	const [commentFocusRequest, setCommentFocusRequest] = useState<CommentsFocusRequest | null>(null);

	const runtime = getJournalRuntime();
	const mutable = canMutate();

	// ── Reactivity: live entry list off the whole-vault snapshot through the
	// ONE shared stack. Standalone (no vaultEntities) → null and we fall back
	// to the demo dataset below.
	const vault = useVaultEntities(ready ? (runtime?.services?.vaultEntities ?? null) : null);
	const hasVault = Boolean(runtime?.services?.vaultEntities?.list);

	const { entries, entryByDate, snapshot } = useMemo(() => {
		if (hasVault) {
			const snap = { entities: vault.entities, links: vault.links } as VaultSnapshot;
			const list = projectJournalEntries(notesFromSnapshot(snap));
			return { entries: list, entryByDate: indexByDateKey(list), snapshot: snap };
		}
		const demo = projectJournalEntries(buildJournalDemo());
		return {
			entries: demo,
			entryByDate: indexByDateKey(demo),
			snapshot: null as VaultSnapshot | null,
		};
	}, [hasVault, vault]);

	// Optimistically-minted entries that the vault snapshot hasn't echoed yet
	// (the `entities.create` → `vaultEntities.onChange` round-trip). Keyed by
	// dateKey; dropped once the snapshot carries the real row.
	const [optimistic, setOptimistic] = useState<Map<string, JournalEntry>>(() => new Map());
	const mergedByDate = useMemo(() => {
		if (optimistic.size === 0) return entryByDate;
		const out = new Map(entryByDate);
		for (const [key, entry] of optimistic) {
			if (!out.has(key)) out.set(key, entry);
		}
		return out;
	}, [entryByDate, optimistic]);
	const mergedEntries = useMemo(() => {
		if (optimistic.size === 0) return entries;
		const extra = [...optimistic.values()].filter((e) => !entryByDate.has(e.dateKey));
		return extra.length > 0 ? [...entries, ...extra] : entries;
	}, [entries, entryByDate, optimistic]);
	// Drop optimistic rows the real snapshot now carries.
	useEffect(() => {
		if (optimistic.size === 0) return;
		let changed = false;
		const next = new Map(optimistic);
		for (const key of optimistic.keys()) {
			if (entryByDate.has(key)) {
				next.delete(key);
				changed = true;
			}
		}
		if (changed) setOptimistic(next);
	}, [entryByDate, optimistic]);

	const focusKey = dateKeyForJournal(focus);
	const focusEntry = mergedByDate.get(focusKey) ?? null;

	// Per-day entry-presence dot (density + mood heatmap) for any month grid —
	// the sidebar mini-calendar (React) and the anchored calendar popovers (the
	// imperative go-to-date / link picker) share one renderer so the dots read
	// identically everywhere.
	const decorateCell = useCallback(
		(cell: MonthGridReactCell): ReactNode => {
			const entry = mergedByDate.get(cell.dateKey);
			if (!entry) return null;
			return (
				<span
					className="journal__mini-dot"
					data-density={String(densityBucket(entry.wordCount))}
					{...(entry.mood ? { "data-mood": entry.mood } : {})}
					aria-label={t("hasEntry")}
				/>
			);
		},
		[mergedByDate],
	);
	// DOM twin for the imperative calendar popovers, whose `renderCell` appends
	// to the cell DOM node rather than returning a React node.
	const decorateCellDom = useCallback(
		(cell: { dateKey: string; element: HTMLElement }): void => {
			const entry = mergedByDate.get(cell.dateKey);
			if (!entry) return;
			const dot = document.createElement("span");
			dot.className = "journal__mini-dot";
			dot.dataset.density = String(densityBucket(entry.wordCount));
			if (entry.mood) dot.dataset.mood = entry.mood;
			dot.setAttribute("aria-label", t("hasEntry"));
			cell.element.appendChild(dot);
		},
		[mergedByDate],
	);

	// ── Boot handshake: the runtime hands services over after first paint.
	useEffect(() => {
		const bs = getJournalRuntime();
		if (!bs || !bs.services?.vaultEntities?.list) {
			setReady(true);
			return;
		}
		// A cross-app `open` for a journal entry (while already open) lands on
		// that day. Journal is the registered opener for `Entry/v1`.
		bs.on("intent", (event) => {
			if (event.type !== "intent" || event.intent.verb !== "open") return;
			const entityId = event.intent.payload?.entityId;
			if (typeof entityId === "string" && entityId.length > 0) focusJournalEntry(entityId);
		});
		bs.on("ready", () => {
			setReady(true);
			const launchId = bs.launch?.reason === "open-entity" ? bs.launch.entityId : undefined;
			if (launchId) focusJournalEntry(launchId);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Bind the shared editor index + open host so the day-body `@`-mention /
	// transclusion typeaheads can enumerate the vault + navigate.
	useEffect(() => {
		wireEditorIndex();
	}, []);
	// Feed the editor's mention index from the SAME live snapshot the app reads
	// through `useVaultEntities` — no second raw `vaultEntities.onChange`.
	useEffect(() => {
		pushEntityIndex(vault.entities);
	}, [vault]);

	// ── Nav history (back/forward). The focused date IS the navigable location.
	const navHistory = useMemo(
		() =>
			createNavHistory<{ focus: number }>({
				initial: { focus: new Date().getTime() },
				persist: { key: "journal:nav", isValid: (loc) => Number.isFinite(loc.focus) },
			}),
		[],
	);

	const findRef = useRef<{ close(): void } | null>(null);

	const recordNav = useCallback(
		(date: Date) => {
			navHistory.push({ focus: date.getTime() });
		},
		[navHistory],
	);

	/** The single user-nav focus mutator: set focused date, follow the month,
	 *  record one history entry. */
	const focusTo = useCallback(
		(date: Date) => {
			findRef.current?.close();
			setPeriodic(null);
			setFocus(date);
			setMonthFocus((prev) => {
				if (date.getFullYear() !== prev.getFullYear() || date.getMonth() !== prev.getMonth()) {
					return new Date(date.getFullYear(), date.getMonth(), 1);
				}
				return prev;
			});
			recordNav(date);
		},
		[recordNav],
	);

	const focusJournalEntry = useCallback(
		(entityId: string): boolean => {
			const ms = journalEntryIdToDateMs(entityId);
			if (ms !== null) {
				focusTo(new Date(ms));
				return true;
			}
			return false;
		},
		[focusTo],
	);

	const applyNav = useCallback((loc: { focus: number }) => {
		findRef.current?.close();
		setPeriodic(null);
		const date = new Date(loc.focus);
		setFocus(date);
		setMonthFocus(new Date(date.getFullYear(), date.getMonth(), 1));
	}, []);

	// ── Pending placeholder seed → editor handoff (implicit create).
	const pendingSeedRef = useRef<Map<string, unknown>>(new Map());
	const inflightCreateRef = useRef<Map<string, Promise<string | null>>>(new Map());

	/** Mirror an autosave's denormalised body into the entity's `body` snippet
	 *  so calendar / week previews track edits. No-op without `entities.update`. */
	const journalDenormalize = useCallback<JournalDenormalizeFn>((noteId, state) => {
		const entities = getJournalRuntime()?.services?.entities;
		const update = entities?.update;
		if (!update) return;
		buildJournalDenormalizer(
			(id, patch) => update.call(entities, id, patch),
			noteId,
			() => {},
		)(state);
	}, []);

	/** Ensure a journal entry exists for `date`. Returns its id (or null when
	 *  there's no entities service / the create rejected non-idempotently). */
	const ensureEntry = useCallback(
		async (date: Date, init?: { icon?: Icon | null }): Promise<string | null> => {
			const dateKey = dateKeyForJournal(date);
			const existing = mergedByDate.get(dateKey);
			if (existing) return existing.noteId;

			const bs = getJournalRuntime();
			const create = bs?.services?.entities?.create;
			if (!create) return null;

			const stableId = journalEntryIdForKey(dateKey);
			const pending = inflightCreateRef.current.get(stableId);
			if (pending) return pending;

			const properties: Record<string, unknown> = { title: dateKey };
			if (init?.icon !== undefined) properties.icon = init.icon;

			const job = (async (): Promise<string | null> => {
				try {
					await create.call(bs?.services?.entities, JOURNAL_ENTRY_TYPE, properties, stableId);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					if (!/already exists/i.test(msg)) {
						console.warn("[journal] entities.create failed:", error);
						return null;
					}
				}
				const ts = Date.now();
				const synthetic: JournalEntry = {
					noteId: stableId,
					icon: init?.icon ?? null,
					dateEpochMs: parseJournalDateKey(dateKey) ?? date.getTime(),
					dateKey,
					rawTitle: dateKey,
					preview: "",
					wordCount: 0,
					seedBody: null,
					values: {},
					mood: null,
					habits: [],
					createdAt: ts,
					updatedAt: ts,
				};
				setOptimistic((prev) => new Map(prev).set(dateKey, synthetic));
				return stableId;
			})();
			inflightCreateRef.current.set(stableId, job);
			try {
				return await job;
			} finally {
				inflightCreateRef.current.delete(stableId);
			}
		},
		[mergedByDate],
	);

	const setEntryIcon = useCallback(
		async (date: Date, icon: Icon | null): Promise<void> => {
			const dateKey = dateKeyForJournal(date);
			const existing = mergedByDate.get(dateKey);
			const noteId = existing ? existing.noteId : await ensureEntry(date, { icon });
			if (!noteId) return;
			const bs = getJournalRuntime();
			const update = bs?.services?.entities?.update;
			if (existing && update) {
				try {
					await update.call(bs?.services?.entities, noteId, { icon });
				} catch (error) {
					console.warn("[journal] entities.update icon failed:", error);
					return;
				}
			}
			setOptimistic((prev) => {
				const cur = prev.get(dateKey);
				if (!cur) return prev;
				return new Map(prev).set(dateKey, { ...cur, icon });
			});
		},
		[mergedByDate, ensureEntry],
	);

	// ── Check-in: mood + habits.
	const persistEntryPatch = useCallback(
		async (entry: JournalEntry, patch: Record<string, unknown>): Promise<void> => {
			const entities = getJournalRuntime()?.services?.entities;
			const update = entities?.update;
			if (!update) return;
			try {
				await update.call(entities, entry.noteId, patch);
			} catch (error) {
				console.warn("[journal] entities.update check-in failed:", error);
			}
		},
		[],
	);
	const setEntryMood = useCallback(
		(entry: JournalEntry, mood: MoodId | null) => void persistEntryPatch(entry, { mood }),
		[persistEntryPatch],
	);
	const toggleEntryHabit = useCallback(
		(entry: JournalEntry, id: HabitId) =>
			void persistEntryPatch(entry, { habits: toggleHabit(entry.habits, id) }),
		[persistEntryPatch],
	);

	// ── Templates + implicit-create handoff.
	// Move DOM focus to the freshly-mounted editor; the caret is placed by the
	// seed plant's `$getRoot().selectEnd()` INSIDE the Lexical/Yjs update
	// (`plantJournalSeed`). Manipulating `window.getSelection()` ranges here
	// instead raced the `@lexical/yjs` binding — its reconciler spliced against
	// a collab element node that wasn't mapped yet and threw Lexical #94
	// ("splice: could not find collab element node"), which aborted the seed and
	// dropped the first word on a new entry (F-299). Just focus; let Lexical own
	// selection.
	const focusEditorAtEnd = useCallback((framesLeft = 12) => {
		requestAnimationFrame(() => {
			const ce = document.querySelector<HTMLElement>(".journal__entry-editor");
			if (!ce) {
				if (framesLeft > 0) focusEditorAtEnd(framesLeft - 1);
				return;
			}
			ce.focus();
		});
	}, []);

	const startEntryFromTemplate = useCallback(
		async (date: Date, template: JournalTemplate): Promise<void> => {
			const stableId = journalEntryIdForKey(dateKeyForJournal(date));
			const seed = templateToSeedState(template);
			pendingSeedRef.current.set(stableId, seed);
			const noteId = await ensureEntry(date);
			if (!noteId) {
				pendingSeedRef.current.delete(stableId);
				return;
			}
			journalDenormalize(noteId, seed as SerializedEditorState);
			focusEditorAtEnd();
		},
		[ensureEntry, journalDenormalize, focusEditorAtEnd],
	);

	const resolveTemplates = useCallback((): JournalTemplate[] => {
		return JOURNAL_TEMPLATE_SPECS.map((spec) => ({
			id: spec.id,
			name: t(spec.nameKey),
			sections: spec.sections.map((s) => ({
				heading: s.headingKey ? t(s.headingKey) : "",
				...(s.promptKey ? { prompt: t(s.promptKey) } : {}),
			})),
		}));
	}, []);

	// ── Periodic rollups.
	const openPeriodic = useCallback(
		async (kind: PeriodKind, anchor: Date): Promise<void> => {
			const key = periodKeyOf(kind, anchor);
			const id = periodStableId(kind, key);
			const label = periodLabel(kind, anchor);

			const dayLinks: PeriodicDayLink[] = [];
			for (const dayKey of constituentDayKeys(kind, anchor)) {
				const entry = mergedByDate.get(dayKey);
				if (!entry) continue;
				dayLinks.push({
					entityId: entry.noteId,
					label: journalNoteTitle(new Date(entry.dateEpochMs)),
				});
			}
			pendingSeedRef.current.set(id, buildPeriodicSeedState(label, dayLinks));

			const entities = getJournalRuntime()?.services?.entities;
			const create = entities?.create;
			if (!create) {
				pendingSeedRef.current.delete(id);
				return;
			}
			try {
				await create.call(entities, JOURNAL_ENTRY_TYPE, { title: key }, id);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (!/already exists/i.test(msg)) {
					console.warn("[journal] periodic create failed:", error);
					pendingSeedRef.current.delete(id);
					return;
				}
			}
			findRef.current?.close();
			setPeriodic({ id, kind, key, label });
		},
		[mergedByDate],
	);

	// ── Export.
	const buildExportLabels = useCallback((title: string): JournalExportLabels => {
		return {
			title,
			moodLabel: (m) => t(MOOD_LABEL_KEY[m]),
			habitLabel: (h) => t(HABIT_LABEL_KEY[h]),
			words: (n) => journalPlural(t, n, "wordOne", "wordOther"),
		};
	}, []);

	const exportJournal = useCallback(
		async (rows: readonly JournalEntry[], format: ExportFormat, title: string): Promise<void> => {
			const files = getJournalRuntime()?.services?.files;
			if (!files) return;
			const labels = buildExportLabels(title);
			const text =
				format === ExportFormat.Md ? journalToMarkdown(rows, labels) : journalToHtml(rows, labels);
			const ext = format === ExportFormat.Md ? "md" : "html";
			const { requestSaveBytes, suggestedFilename, textToBytes } = await import(
				"@brainstorm/sdk/export-file"
			);
			await requestSaveBytes(files, {
				title: t("export.saveDialogTitle"),
				suggestedName: suggestedFilename(t("export.title"), ext, { defaultStem: "journal" }),
				filters: [{ name: t("export.filterName"), extensions: [ext] }],
				encode: () => textToBytes(text),
			});
		},
		[buildExportLabels],
	);

	const openExportMenu = useCallback(
		(anchor: HTMLElement) => {
			const rect = anchor.getBoundingClientRect();
			const monthStart = new Date(monthFocus.getFullYear(), monthFocus.getMonth(), 1);
			const monthEnd = new Date(monthFocus.getFullYear(), monthFocus.getMonth() + 1, 1).getTime() - 1;
			const monthEntries = entriesInRange(mergedEntries, monthStart.getTime(), monthEnd);
			const monthTitle = periodLabel(PeriodKind.Month, monthFocus);
			const allTitle = t("export.title");
			const items: AnchoredMenuItem[] = [
				{
					label: t("export.monthMd"),
					icon: IconName.Download,
					onSelect: () => void exportJournal(monthEntries, ExportFormat.Md, monthTitle),
				},
				{
					label: t("export.monthHtml"),
					icon: IconName.Download,
					onSelect: () => void exportJournal(monthEntries, ExportFormat.Html, monthTitle),
				},
				{
					label: t("export.allMd"),
					icon: IconName.Download,
					onSelect: () => void exportJournal(mergedEntries, ExportFormat.Md, allTitle),
				},
				{
					label: t("export.allHtml"),
					icon: IconName.Download,
					onSelect: () => void exportJournal(mergedEntries, ExportFormat.Html, allTitle),
				},
			];
			openAnchoredMenu({ x: rect.left, y: rect.bottom + 4 }, items, {
				menuLabel: t("export.title"),
				anchor,
			});
		},
		[monthFocus, mergedEntries, exportJournal],
	);

	// ── Link picker: an anchored calendar (density/mood dots on days that have
	// an entry) — pick a day to insert a link to that day's entry, creating the
	// entry on demand if the day is still empty.
	const openLinkPicker = useCallback(
		(entry: JournalEntry, anchor: HTMLElement) => {
			openCalendarPopover({
				anchor: { element: anchor },
				ariaLabel: t("linkPickerTitle"),
				labels: { today: t("today"), prev: t("previous"), next: t("next") },
				valueMs: entry.dateEpochMs,
				viewMs: entry.dateEpochMs,
				todayMs: now.getTime(),
				weekStartsOn: DEFAULT_JOURNAL_VIEW.weekStartsOn,
				renderCell: decorateCellDom,
				onSelect: (ms) => {
					void (async () => {
						const date = new Date(ms);
						const dateKey = dateKeyForJournal(date);
						if (dateKey === entry.dateKey) return; // never self-link
						const existing = mergedByDate.get(dateKey);
						const noteId = existing ? existing.noteId : await ensureEntry(date);
						if (!noteId) return;
						insertEntityMention(noteId, JOURNAL_ENTRY_TYPE, journalNoteTitle(date));
					})();
				},
			});
		},
		[now, mergedByDate, ensureEntry, decorateCellDom],
	);

	// ── Month / year jump: the sidebar mini-calendar title opens a fancy-menu
	// of the shown year's months (current one checked) plus year steppers, so
	// you can reach any month or year without stepping one month at a time.
	const openMonthYearJump = useCallback(
		function openJump(viewMs: number, anchor: HTMLElement): void {
			const view = new Date(viewMs);
			const year = view.getFullYear();
			const currentMonth = year === monthFocus.getFullYear() ? monthFocus.getMonth() : -1;
			const items: AnchoredMenuItem[] = [
				{ label: String(year), section: true },
				{
					label: String(year - 1),
					icon: IconName.CaretLeft,
					onSelect: () => openJump(new Date(year - 1, view.getMonth(), 1).getTime(), anchor),
				},
				{
					label: String(year + 1),
					icon: IconName.CaretRight,
					onSelect: () => openJump(new Date(year + 1, view.getMonth(), 1).getTime(), anchor),
				},
				{ divider: true },
			];
			for (let m = 0; m < 12; m++) {
				const monthLabel = new Date(year, m, 1).toLocaleDateString(undefined, { month: "long" });
				items.push({
					label: monthLabel,
					...(m === currentMonth ? { icon: IconName.Check } : {}),
					onSelect: () => setMonthFocus(new Date(year, m, 1)),
				});
			}
			const rect = anchor.getBoundingClientRect();
			openAnchoredMenu({ x: rect.left, y: rect.bottom + 4 }, items, {
				menuLabel: t("jumpToMonth"),
				anchor,
			});
		},
		[monthFocus],
	);

	// ── Empty-day overflow menu (view-level actions instead of a dead ⋯).
	const openEmptyDayMenu = useCallback(
		(button: HTMLElement, isToday: boolean) => {
			const items: AnchoredMenuItem[] = [];
			if (mutable) {
				items.push({ label: t("templatesLabel"), section: true });
				for (const template of resolveTemplates()) {
					items.push({
						label: template.name,
						icon: IconName.Pencil,
						onSelect: () => void startEntryFromTemplate(focus, template),
					});
				}
				items.push({ divider: true });
			}
			if (!isToday) {
				items.push({ label: t("today"), icon: IconName.KindDate, onSelect: () => focusTo(now) });
			}
			items.push({
				label: t("export.button"),
				icon: IconName.Download,
				onSelect: () => openExportMenu(button),
			});
			const rect = button.getBoundingClientRect();
			openAnchoredMenu({ x: rect.left, y: rect.bottom + 4 }, items, {
				menuLabel: t("moreActions"),
				anchor: button,
			});
		},
		[mutable, resolveTemplates, startEntryFromTemplate, focus, now, focusTo, openExportMenu],
	);

	// ── Comments hooks (B11.9).
	const openCommentsTab = useCallback(() => {
		setRightPanelTab(RightPanelTab.Comments);
		setPropsOpen((open) => {
			if (!open) {
				writePanelPref(PROPS_OPEN_PREF_KEY, true);
				return true;
			}
			return open;
		});
	}, []);

	const focusEntryNoteId = focusEntry?.noteId ?? null;
	// Read-only lock — a synced `locked` property on the entry, same model as
	// Notes. Read from the live vault so it reflects edits from any device.
	const focusEntryLocked = focusEntryNoteId
		? vault.entities.some((e) => e.id === focusEntryNoteId && e.properties.locked === true)
		: false;
	const toggleFocusEntryLock = useCallback(() => {
		if (!focusEntryNoteId) return;
		const entities = getJournalRuntime()?.services?.entities;
		void entities?.update?.call(entities, focusEntryNoteId, { locked: !focusEntryLocked });
	}, [focusEntryNoteId, focusEntryLocked]);
	const commentHooks = useMemo<JournalCommentHooks>(
		() => ({
			onSelection(anchor) {
				if (!focusEntryNoteId) return;
				setPendingCommentAnchor({
					entityId: focusEntryNoteId,
					blockId: anchor.blockId,
					...(anchor.quote ? { quote: anchor.quote } : {}),
				});
				openCommentsTab();
			},
			onBlockClick(blockId) {
				setCommentFocusRequest((prev) => ({ blockId, nonce: (prev?.nonce ?? 0) + 1 }));
				openCommentsTab();
			},
		}),
		[focusEntryNoteId, openCommentsTab],
	);

	// Reset comment state on day switch — `focusEntryNoteId` IS the trigger.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the note id change is the intended trigger.
	useEffect(() => {
		setPendingCommentAnchor(null);
		setCommentFocusRequest(null);
	}, [focusEntryNoteId]);

	// ── Boot once: menu host + spellcheck menu + delegated object menu + chords.
	useEffect(() => {
		mountMenuHost();
		mountSpellcheckMenuFromWindow();
		const resolveMenuTarget: JournalMenuResolver = (entityId, el) => ({
			entityType: el?.getAttribute(ENTITY_TYPE_ATTR) ?? JOURNAL_ENTRY_TYPE,
			label: el?.getAttribute(ENTITY_LABEL_ATTR) ?? entityId,
		});
		const menuChromeLabels = (): Partial<ObjectMenuChromeLabels> => ({
			open: t("openInNotes"),
			openUnavailable: t("standaloneHint"),
			menuRegion: t("moreActions"),
			moreActions: t("moreActions"),
		});
		// Idempotent — guards on `dataset.objectMenuBound`, so a StrictMode
		// double-mount binds once; nothing to detach.
		bindDelegatedObjectMenu(
			document.body,
			() => getJournalRuntime() as ObjectMenuRuntime,
			resolveMenuTarget,
			menuChromeLabels,
		);
	}, []);

	// ── In-document find (B9.3) — DOM-text-search over the entry body.
	const rootRef = useRef<HTMLElement>(null);
	useEffect(() => {
		const host = rootRef.current;
		if (!host) return;
		const provider = createDomTextSearchProvider(() =>
			host.querySelector<HTMLElement>(".journal__entry-body"),
		);
		const find = createFindController(provider, { persist: { key: "journal:find" } });
		findRef.current = find;
		const detachBar = attachFindBar(host, find, { mode: "find" });
		const detachChords = attachFindShortcuts(window, find);
		const unsubscribe = find.subscribe(() => {
			if (!find.getState().open) provider.clear();
		});
		return () => {
			unsubscribe();
			detachChords();
			detachBar();
			findRef.current = null;
		};
	}, []);

	// ── Resize handles.
	const navResizeRef = useRef<HTMLDivElement>(null);
	const propsResizeRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const handle = navResizeRef.current;
		if (!handle) return;
		const r = attachResizable({
			handle,
			side: "left",
			defaultWidth: 260,
			min: 220,
			max: 420,
			storageKey: NAV_WIDTH_KEY,
			onWidth: (px) => document.body.style.setProperty("--journal-nav-width", `${px}px`),
		});
		return () => r.destroy();
	}, []);
	useEffect(() => {
		const handle = propsResizeRef.current;
		if (!handle) return;
		const r = attachResizable({
			handle,
			side: "right",
			defaultWidth: 320,
			min: 260,
			max: 480,
			storageKey: PROPS_WIDTH_KEY,
			onWidth: (px) => document.body.style.setProperty("--journal-props-width", `${px}px`),
		});
		return () => r.destroy();
	}, []);

	// ── Write reminder scheduler.
	useEffect(() => {
		const tick = (): void => {
			if (readLocal(REMINDER_ENABLED_KEY, "false") !== "true") return;
			const notify = getJournalRuntime()?.services?.ui?.notify;
			if (!notify) return;
			const target = parseReminderTime(readLocal(REMINDER_TIME_KEY, DEFAULT_REMINDER_TIME));
			if (target === null) return;
			const at = new Date();
			const key = dateKeyForJournal(at);
			const lastFired = readLocal(REMINDER_LAST_FIRED_KEY, "");
			const fire = shouldFireWriteReminder({
				now: at,
				targetMinutes: target,
				lastFiredDateKey: lastFired || null,
				todayKey: key,
				hasTodayEntry: mergedByDate.has(key),
			});
			if (!fire) return;
			writeLocal(REMINDER_LAST_FIRED_KEY, key);
			const atRisk = streakAtRisk(new Set(mergedEntries.map((e) => e.dateKey)), key);
			void notify({
				title: t("reminder.notify.title"),
				body:
					atRisk > 0
						? t("reminder.notify.streak", { count: String(atRisk) })
						: t("reminder.notify.body"),
			});
		};
		const id = setInterval(tick, REMINDER_TICK_MS);
		return () => clearInterval(id);
	}, [mergedByDate, mergedEntries]);

	// ── Chords.
	useJournalChord(JournalChordId.PrevPeriod, () => focusTo(shiftByDays(focus, -1)), [
		focus,
		focusTo,
	]);
	useJournalChord(JournalChordId.NextPeriod, () => focusTo(shiftByDays(focus, 1)), [focus, focusTo]);
	useJournalChord(JournalChordId.GoToToday, () => focusTo(now), [now, focusTo]);
	useJournalChord(
		JournalChordId.GoToDate,
		() => {
			if (!navOpen) {
				setNavOpen(true);
				writePanelPref(NAV_OPEN_PREF_KEY, true);
			}
			requestAnimationFrame(() => {
				rootRef.current?.querySelector<HTMLButtonElement>(".bs-cal-mini__title--button")?.click();
			});
		},
		[navOpen],
	);
	useJournalChord(
		JournalChordId.Search,
		() =>
			openJournalSearch({
				t,
				getEntries: () => mergedEntries,
				onPick: (entry) => focusTo(new Date(entry.dateEpochMs)),
			}),
		[mergedEntries, focusTo],
	);
	useJournalChord(
		JournalChordId.OpenFocusedDay,
		() => {
			const entry = mergedByDate.get(dateKeyForJournal(focus));
			if (!entry) return;
			void openEntity(getJournalRuntime(), {
				entityId: entry.noteId,
				entityType: JOURNAL_ENTRY_TYPE,
			});
		},
		[focus, mergedByDate],
	);

	// ── Panel toggles.
	const toggleNav = useCallback(() => {
		setNavOpen((open) => {
			const next = !open;
			writePanelPref(NAV_OPEN_PREF_KEY, next);
			return next;
		});
	}, []);
	const toggleProps = useCallback(() => {
		setPropsOpen((open) => {
			const next = !open;
			writePanelPref(PROPS_OPEN_PREF_KEY, next);
			return next;
		});
	}, []);

	// ── Properties panel opts (stable closures reading live state via refs).
	const propsOptsRef = useRef<JournalPropertiesOptions | null>(null);
	const focusRef = useRef(focus);
	focusRef.current = focus;
	const focusEntryRef = useRef(focusEntry);
	focusEntryRef.current = focusEntry;
	const rightPanelTabRef = useRef(rightPanelTab);
	rightPanelTabRef.current = rightPanelTab;
	const pendingCommentRef = useRef(pendingCommentAnchor);
	pendingCommentRef.current = pendingCommentAnchor;
	const commentFocusRef = useRef(commentFocusRequest);
	commentFocusRef.current = commentFocusRequest;
	if (!propsOptsRef.current) {
		propsOptsRef.current = {
			runtime: getJournalRuntime(),
			t,
			getEntry: () => focusEntryRef.current,
			ensureEntry: () => ensureEntry(focusRef.current),
			onClose: () => {
				setPropsOpen(false);
				writePanelPref(PROPS_OPEN_PREF_KEY, false);
			},
			getActiveTab: () => rightPanelTabRef.current,
			onTabChange: (tab) => setRightPanelTab(tab),
			getPendingCommentAnchor: () => pendingCommentRef.current,
			onClearPendingComment: () => setPendingCommentAnchor(null),
			getCommentFocusRequest: () => commentFocusRef.current,
			onApplySuggestion: (comment) =>
				applyJournalSuggestion(comment.anchor, comment.suggestion?.replacement),
		};
	}
	// Drive a fresh render of the properties island whenever inputs change.
	const propsVersion = useMemo(
		() =>
			`${focusEntryNoteId ?? ""}:${rightPanelTab}:${pendingCommentAnchor?.blockId ?? ""}:${commentFocusRequest?.nonce ?? 0}`,
		[focusEntryNoteId, rightPanelTab, pendingCommentAnchor, commentFocusRequest],
	);

	const isToday = focusKey === todayKey;
	const label = periodic ? periodic.label : journalNoteTitle(focus);

	return (
		<>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<NavButtons history={navHistory} onNavigate={applyNav} />
					{periodic ? null : (
						<DatePager
							labels={{ today: t("today"), prev: t("previous"), next: t("next") }}
							onToday={() => focusTo(now)}
							onPrev={() => focusTo(shiftByDays(focus, -1))}
							onNext={() => focusTo(shiftByDays(focus, 1))}
							className="journal__day-pager"
						/>
					)}
					{periodic ? null : mutable ? (
						<IconPickerButton
							value={focusEntry?.icon ?? null}
							size={18}
							ariaLabel={t("iconPicker")}
							onChange={(icon) => void setEntryIcon(focus, icon)}
						/>
					) : (
						<EntityIcon icon={focusEntry?.icon ?? null} size={18} />
					)}
					<span className="journal__header-title-host">
						{focusEntry?.noteId ? (
							<span
								className="app-header__title"
								{...{ [ENTITY_ID_ATTR]: focusEntry.noteId }}
								{...{ [ENTITY_LABEL_ATTR]: label }}
								{...{ [ENTITY_TYPE_ATTR]: JOURNAL_ENTRY_TYPE }}
							>
								{label}
							</span>
						) : (
							<span className="app-header__title">{label}</span>
						)}
					</span>
				</div>
				<div className="app-header__right">
					<button
						type="button"
						className="header-icon-btn"
						data-bs-tooltip={t("search.title")}
						aria-label={t("search.title")}
						onClick={() =>
							openJournalSearch({
								t,
								getEntries: () => mergedEntries,
								onPick: (entry) => focusTo(new Date(entry.dateEpochMs)),
							})
						}
					>
						<Glyph name={IconName.Search} size={18} />
					</button>
					{focusEntryNoteId && (
						<LockButton
							locked={focusEntryLocked}
							onToggle={toggleFocusEntryLock}
							lockLabel={t("header.lock")}
							unlockLabel={t("header.unlock")}
						/>
					)}
					<PanelToggleButton
						side={PanelSide.Left}
						open={navOpen}
						onClick={toggleNav}
						labels={{ show: t("sidebar.show"), hide: t("sidebar.hide") }}
						controls="journal-nav"
					/>
					<PanelToggleButton
						side={PanelSide.Right}
						open={propsOpen}
						onClick={toggleProps}
						labels={{ show: t("properties.show"), hide: t("properties.hide") }}
						controls="journal-props"
					/>
					<HeaderMoreButton
						entry={focusEntry}
						periodic={periodic}
						label={label}
						onEmptyDayMenu={(btn) => openEmptyDayMenu(btn, isToday)}
					/>
				</div>
			</header>
			<main
				className="journal"
				ref={rootRef}
				data-nav-open={String(navOpen)}
				data-props-open={String(propsOpen)}
			>
				<aside
					className="journal__nav"
					id="journal-nav"
					aria-hidden={!navOpen}
					inert={!navOpen ? true : undefined}
				>
					<div className="journal__nav-inner">
						<StreakBadge entries={mergedEntries} todayKey={todayKey} />
						<MiniCalendar
							labels={{ today: t("today"), prev: t("previous"), next: t("next") }}
							valueMs={focus.getTime()}
							viewMs={monthFocus.getTime()}
							todayMs={now.getTime()}
							weekStartsOn={DEFAULT_JOURNAL_VIEW.weekStartsOn}
							className="journal__mini"
							onChange={(ms) => focusTo(new Date(ms))}
							onViewChange={(ms) => setMonthFocus(new Date(ms))}
							onTitleClick={openMonthYearJump}
							renderCell={decorateCell}
						/>
						{mutable ? <Rollups now={now} activeId={periodic?.id ?? null} onOpen={openPeriodic} /> : null}
						<ReminderSettings />
						<Overview
							entries={mergedEntries}
							focusKey={focusKey}
							hasFiles={Boolean(getJournalRuntime()?.services?.files)}
							onPick={(ms) => focusTo(new Date(ms))}
							onExport={openExportMenu}
						/>
					</div>
				</aside>
				<div
					className="journal__nav-resize"
					ref={navResizeRef}
					role="separator"
					aria-orientation="vertical"
					tabIndex={0}
				/>
				<section className="journal__main">
					<section className="journal__day">
						{periodic ? (
							<PeriodicBody periodic={periodic} snapshot={snapshot} pendingSeedRef={pendingSeedRef} />
						) : (
							<EntryBody
								entry={focusEntry}
								focus={focus}
								mutable={mutable}
								snapshot={snapshot}
								pendingSeedRef={pendingSeedRef}
								journalDenormalize={journalDenormalize}
								commentHooks={commentHooks}
								onPlaceholderCreate={ensureEntry}
								resolveTemplates={resolveTemplates}
								onTemplate={startEntryFromTemplate}
								onMood={setEntryMood}
								onHabit={toggleEntryHabit}
								onLink={openLinkPicker}
							/>
						)}
					</section>
				</section>
				<div
					className="journal__props-resize"
					ref={propsResizeRef}
					role="separator"
					aria-orientation="vertical"
					tabIndex={0}
				/>
				<aside
					className="journal__props glass--strong"
					id="journal-props"
					aria-hidden={!propsOpen}
					inert={!propsOpen ? true : undefined}
				>
					{propsOptsRef.current ? (
						<JournalPropertiesIsland key={propsVersion} version={0} opts={propsOptsRef.current} />
					) : null}
				</aside>
			</main>
		</>
	);
}

function useJournalChord(
	id: JournalChordId,
	handler: () => void,
	deps: ReadonlyArray<unknown>,
): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const chord = useMemo(() => JOURNAL_CHORDS[id], [id]);
	useEffect(() => {
		// Route through the shared shortcut binder, NOT a raw `matchesChord`
		// keydown listener: single-key journal chords (T → today, ArrowLeft/
		// Right → prev/next day) must be suppressed while the day-body editor
		// (or any input) has focus — otherwise typing "t" in an entry jumps to
		// today and arrows navigate days. `attachShortcut` applies the registry
		// `isEditableElement` guard for single-key chords.
		return attachShortcut(window, chord, () => handlerRef.current());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chord]);
	void deps;
}

// ── Header ⋯ (object menu when there's an entry; empty-day overflow else). ──
function HeaderMoreButton({
	entry,
	periodic,
	label,
	onEmptyDayMenu,
}: {
	entry: JournalEntry | null;
	periodic: PeriodicView | null;
	label: string;
	onEmptyDayMenu: (button: HTMLElement) => void;
}): ReactElement {
	const ref = useRef<HTMLSpanElement>(null);
	// With an entry, the delegated object-menu listener resolves the ⋯ from its
	// `data-entity-id`; without one (and not a periodic rollup), the ⋯ opens the
	// view-level overflow so it's never a dead button.
	const hasObject = Boolean(entry?.noteId) && !periodic;
	const onClick = useCallback(
		(event: React.MouseEvent) => {
			if (hasObject) return; // delegated listener handles it
			event.preventDefault();
			event.stopPropagation();
			const el = ref.current;
			if (el) onEmptyDayMenu(el);
		},
		[hasObject, onEmptyDayMenu],
	);
	if (periodic) {
		// Periodic rollup is not an entity — disabled ⋯ anchors the trailing edge.
		return (
			<span
				className="bs-object-menu__more"
				aria-haspopup="menu"
				aria-disabled="true"
				aria-label={t("moreActions")}
				title={t("moreActions")}
			>
				<span className="bs-object-menu__more-dot" />
				<span className="bs-object-menu__more-dot" />
				<span className="bs-object-menu__more-dot" />
			</span>
		);
	}
	return (
		<span
			ref={ref}
			role="button"
			tabIndex={0}
			className="bs-object-menu__more"
			aria-haspopup="menu"
			aria-label={t("moreActions")}
			data-bs-tooltip={t("moreActions")}
			onClick={onClick}
			{...(hasObject && entry
				? {
						[ENTITY_ID_ATTR]: entry.noteId,
						[ENTITY_LABEL_ATTR]: label,
						[ENTITY_TYPE_ATTR]: JOURNAL_ENTRY_TYPE,
					}
				: {})}
		>
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
		</span>
	);
}

// ── Streak badge. ──
function StreakBadge({
	entries,
	todayKey,
}: { entries: readonly JournalEntry[]; todayKey: string }): ReactElement {
	const keys = useMemo(() => new Set(entries.map((e) => e.dateKey)), [entries]);
	const atRisk = streakAtRisk(keys, todayKey);
	if (atRisk > 0) {
		return (
			<div className="journal__streak" data-active="true" data-risk="true">
				<span className="journal__streak-flame" aria-hidden="true">
					⚠️
				</span>
				<span>{t("streakAtRisk", { count: String(atRisk) })}</span>
			</div>
		);
	}
	const streak = currentStreak(keys, todayKey);
	if (streak === 0) {
		return (
			<div className="journal__streak" data-active="false">
				{t("streakNone")}
			</div>
		);
	}
	return (
		<div className="journal__streak" data-active="true">
			<span className="journal__streak-flame" aria-hidden="true">
				🔥
			</span>
			<span>{journalPlural(t, streak, "streakOne", "streakMany")}</span>
		</div>
	);
}

// ── Periodic rollups quick-access. ──
function Rollups({
	now,
	activeId,
	onOpen,
}: {
	now: Date;
	activeId: string | null;
	onOpen: (kind: PeriodKind, anchor: Date) => void;
}): ReactElement {
	const lastWeekAnchor = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
	const lastMonthAnchor = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	const buttons: Array<{ key: string; label: string; kind: PeriodKind; anchor: Date }> = [
		{ key: "periodic.thisWeek", label: t("periodic.thisWeek"), kind: PeriodKind.Week, anchor: now },
		{
			key: "periodic.lastWeek",
			label: t("periodic.lastWeek"),
			kind: PeriodKind.Week,
			anchor: lastWeekAnchor,
		},
		{
			key: "periodic.thisMonth",
			label: t("periodic.thisMonth"),
			kind: PeriodKind.Month,
			anchor: now,
		},
		{
			key: "periodic.lastMonth",
			label: t("periodic.lastMonth"),
			kind: PeriodKind.Month,
			anchor: lastMonthAnchor,
		},
	];
	return (
		<section className="journal__rollups">
			<h2 className="journal__rollups-heading">{t("periodic.heading")}</h2>
			{buttons.map((b) => {
				const id = periodStableId(b.kind, periodKeyOf(b.kind, b.anchor));
				const active = activeId === id;
				return (
					<button
						key={b.key}
						type="button"
						className="journal__rollup-btn"
						{...(active ? { "data-active": "true", "aria-current": "true" } : {})}
						onClick={() => onOpen(b.kind, b.anchor)}
					>
						{b.label}
					</button>
				);
			})}
		</section>
	);
}

// ── Reminder settings. ──
function ReminderSettings(): ReactElement {
	const [enabled, setEnabled] = useState(() => readLocal(REMINDER_ENABLED_KEY, "false") === "true");
	const [time, setTime] = useState(() => readLocal(REMINDER_TIME_KEY, DEFAULT_REMINDER_TIME));
	return (
		<div className="journal__reminder">
			<Checkbox
				label={t("reminder.label")}
				checked={enabled}
				className="journal__reminder-toggle"
				onChange={(checked) => {
					setEnabled(checked);
					writeLocal(REMINDER_ENABLED_KEY, String(checked));
				}}
			/>
			{enabled ? (
				<input
					type="time"
					className="journal__reminder-time"
					value={time}
					aria-label={t("reminder.timeLabel")}
					onChange={(e) => {
						const next = e.target.value;
						if (parseReminderTime(next) !== null) {
							setTime(next);
							writeLocal(REMINDER_TIME_KEY, next);
						}
					}}
				/>
			) : null}
		</div>
	);
}

// ── All-entries overview list (KBN-A-journal listbox). ──
function overviewPreviewText(entry: JournalEntry): string {
	const raw = entry.preview?.trim();
	if (!raw) return t("noEntryYet");
	const match = /^(\d{4}-\d{2}-\d{2})\s+/.exec(raw);
	if (match && match[1] === entry.dateKey) {
		const rest = raw.slice(match[0].length).trim();
		if (rest) return rest;
	}
	return raw;
}

function Overview({
	entries,
	focusKey,
	hasFiles,
	onPick,
	onExport,
}: {
	entries: readonly JournalEntry[];
	focusKey: string;
	hasFiles: boolean;
	onPick: (epochMs: number) => void;
	onExport: (anchor: HTMLElement) => void;
}): ReactElement {
	const exportRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const sections = useMemo(() => groupEntriesByMonth(entries), [entries]);
	const ordered = useMemo(() => sections.flatMap((m) => m.entries), [sections]);
	const onPickRef = useRef(onPick);
	onPickRef.current = onPick;

	useEffect(() => {
		const host = listRef.current;
		if (!host) return;
		const kb = attachOverviewKeyboard(host, {
			count: () => ordered.length,
			initialActiveIndex: ordered.findIndex((e) => e.dateKey === focusKey),
			onOpen: (i) => {
				const entry = ordered[i];
				if (entry) onPickRef.current(entry.dateEpochMs);
			},
		});
		return () => kb.destroy();
	}, [ordered, focusKey]);

	return (
		<section className="journal__overview">
			<div className="journal__overview-heading-row">
				<h2 className="journal__overview-heading">{t("overviewHeading")}</h2>
				{hasFiles ? (
					<button
						type="button"
						className="journal__overview-export"
						ref={exportRef}
						onClick={() => exportRef.current && onExport(exportRef.current)}
					>
						{t("export.button")}
					</button>
				) : null}
			</div>
			{sections.length === 0 ? (
				<p className="journal__overview-empty">{t("overviewEmpty")}</p>
			) : (
				<div className="journal__overview-lists" ref={listRef}>
					{(() => {
						let index = -1;
						return sections.map((month) => (
							<div key={month.monthKey}>
								<h3 className="journal__overview-month">{monthLabelFromKey(month.monthKey)}</h3>
								<ul className="journal__overview-list">
									{month.entries.map((entry) => {
										index += 1;
										const i = index;
										const active = entry.dateKey === focusKey;
										const d = new Date(entry.dateEpochMs);
										return (
											<li key={entry.noteId} className="journal__overview-item">
												<button
													type="button"
													className="journal__overview-btn"
													data-composite-index={String(i)}
													{...(active ? { "data-active": "true", "aria-current": "true" } : {})}
													onClick={() => onPick(entry.dateEpochMs)}
												>
													<span className="journal__overview-weekday">
														{d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" })}
													</span>
													<span className="journal__overview-preview">{overviewPreviewText(entry)}</span>
												</button>
											</li>
										);
									})}
								</ul>
							</div>
						));
					})()}
				</div>
			)}
		</section>
	);
}

// ── Check-in (mood + habits). ──
function CheckIn({
	entry,
	onMood,
	onHabit,
}: {
	entry: JournalEntry;
	onMood: (entry: JournalEntry, mood: MoodId | null) => void;
	onHabit: (entry: JournalEntry, id: HabitId) => void;
}): ReactElement {
	return (
		<section className="journal__checkin">
			<div className="journal__checkin-group" role="group" aria-label={t("checkIn.mood")}>
				<span className="journal__checkin-label">{t("checkIn.mood")}</span>
				{JOURNAL_MOODS.map((mood) => {
					const active = entry.mood === mood.id;
					return (
						<button
							key={mood.id}
							type="button"
							className="journal__mood-btn"
							data-mood={mood.id}
							aria-pressed={active}
							aria-label={t(MOOD_LABEL_KEY[mood.id])}
							data-bs-tooltip={t(MOOD_LABEL_KEY[mood.id])}
							onClick={() => onMood(entry, active ? null : mood.id)}
						>
							{mood.emoji}
						</button>
					);
				})}
			</div>
			<div className="journal__checkin-group" role="group" aria-label={t("checkIn.habits")}>
				<span className="journal__checkin-label">{t("checkIn.habits")}</span>
				{JOURNAL_HABITS.map((habit) => {
					const done = entry.habits.includes(habit.id);
					return (
						<button
							key={habit.id}
							type="button"
							className="journal__habit-btn"
							aria-pressed={done}
							onClick={() => onHabit(entry, habit.id)}
						>
							<span className="journal__habit-glyph" aria-hidden="true">
								{habit.emoji}
							</span>
							<span>{t(HABIT_LABEL_KEY[habit.id])}</span>
						</button>
					);
				})}
			</div>
		</section>
	);
}

// ── Backlinks / outgoing panels. ──
function LinkRow({
	title,
	meta,
	noteId,
	type,
	onOpen,
}: {
	title: string;
	meta: string;
	noteId: string;
	type: string;
	onOpen: (event: React.MouseEvent) => void;
}): ReactElement {
	return (
		<li
			className="journal__backlink bs-object-menu__host--row"
			{...{ [ENTITY_ID_ATTR]: noteId }}
			{...{ [ENTITY_LABEL_ATTR]: title }}
			{...{ [ENTITY_TYPE_ATTR]: type }}
		>
			<button type="button" className="journal__backlink-btn" onClick={onOpen}>
				<span className="journal__backlink-title">{title}</span>
				<span className="journal__backlink-meta">{meta}</span>
			</button>
		</li>
	);
}

function BacklinksPanel({
	backlinks,
	onOpen,
}: {
	backlinks: readonly Backlink[];
	onOpen: (link: Backlink, event: React.MouseEvent) => void;
}): ReactElement {
	return (
		<aside className="journal__backlinks">
			<h2 className="journal__backlinks-heading">{t("linkedFrom", { count: backlinks.length })}</h2>
			<ul className="journal__backlinks-list">
				{backlinks.map((link) => (
					<LinkRow
						key={`${link.sourceNoteId}:${link.linkType}`}
						title={link.title}
						meta={link.linkType === LINK_TYPE_NOTE_LINK ? t("link") : t("mention")}
						noteId={link.sourceNoteId}
						type={link.sourceType}
						onOpen={(event) => onOpen(link, event)}
					/>
				))}
			</ul>
		</aside>
	);
}

function OutgoingPanel({
	links,
	onOpen,
}: {
	links: readonly OutgoingLink[];
	onOpen: (link: OutgoingLink, event: React.MouseEvent) => void;
}): ReactElement {
	return (
		<aside className="journal__backlinks">
			<h2 className="journal__backlinks-heading">{t("linksTo", { count: links.length })}</h2>
			<ul className="journal__backlinks-list">
				{links.map((link) => (
					<LinkRow
						key={`${link.destNoteId}:${link.linkType}`}
						title={link.title}
						meta={link.linkType === LINK_TYPE_NOTE_LINK ? t("link") : t("mention")}
						noteId={link.destNoteId}
						type={link.destType}
						onOpen={(event) => onOpen(link, event)}
					/>
				))}
			</ul>
		</aside>
	);
}

// ── Periodic rollup body. ──
function PeriodicBody({
	periodic,
	snapshot,
	pendingSeedRef,
}: {
	periodic: PeriodicView;
	snapshot: VaultSnapshot | null;
	pendingSeedRef: React.RefObject<Map<string, unknown>>;
}): ReactElement {
	const resolver = getYDocResolverApi();
	const pending = pendingSeedRef.current?.get(periodic.id);
	if (pending !== undefined) pendingSeedRef.current?.delete(periodic.id);
	const outgoing = snapshot ? findOutgoingLinks(snapshot, periodic.id) : [];
	const backlinks = snapshot ? findBacklinks(snapshot, periodic.id) : [];
	return (
		<div className="journal__entry-body">
			<div className="journal__entry-editor-host">
				{resolver ? (
					<EntryEditorIsland resolver={resolver.resolve} noteId={periodic.id} seedBody={pending} />
				) : (
					<p className="journal__entry-text">{t("noEntryYet")}</p>
				)}
			</div>
			{outgoing.length > 0 ? (
				<OutgoingPanel
					links={outgoing}
					onOpen={(link, event) =>
						void openEntity(getJournalRuntime(), {
							entityId: link.destNoteId,
							entityType: link.destType,
							mode: navModeFromEvent(event.nativeEvent),
						})
					}
				/>
			) : null}
			{backlinks.length > 0 ? (
				<BacklinksPanel
					backlinks={backlinks}
					onOpen={(link, event) =>
						void openEntity(getJournalRuntime(), {
							entityId: link.sourceNoteId,
							entityType: link.sourceType,
							mode: navModeFromEvent(event.nativeEvent),
						})
					}
				/>
			) : null}
		</div>
	);
}

// ── Day entry body. ──
function EntryBody({
	entry,
	focus,
	mutable,
	snapshot,
	pendingSeedRef,
	journalDenormalize,
	commentHooks,
	onPlaceholderCreate,
	resolveTemplates,
	onTemplate,
	onMood,
	onHabit,
	onLink,
}: {
	entry: JournalEntry | null;
	focus: Date;
	mutable: boolean;
	snapshot: VaultSnapshot | null;
	pendingSeedRef: React.RefObject<Map<string, unknown>>;
	journalDenormalize: JournalDenormalizeFn;
	commentHooks: JournalCommentHooks;
	onPlaceholderCreate: (date: Date) => Promise<string | null>;
	resolveTemplates: () => JournalTemplate[];
	onTemplate: (date: Date, template: JournalTemplate) => void;
	onMood: (entry: JournalEntry, mood: MoodId | null) => void;
	onHabit: (entry: JournalEntry, id: HabitId) => void;
	onLink: (entry: JournalEntry, anchor: HTMLElement) => void;
}): ReactElement {
	const resolver = getYDocResolverApi();
	const linkRef = useRef<HTMLButtonElement>(null);

	// First edit on an entry-less day promotes it to a real entity (idempotent
	// create with the deterministic stable id), THEN denormalises — so the body
	// snippet write happens against a row that exists. The editor never unmounts
	// across this promotion (same `noteId` + same JSX slot), so no keystroke is
	// lost: the single live editor owns the whole word from the first character
	// (F-299 — replaces the old placeholder→editor seed handoff that dropped it).
	const lazyDenormalize = useCallback<JournalDenormalizeFn>(
		(id, state) => {
			void onPlaceholderCreate(focus).then((created) => {
				if (created) journalDenormalize(id, state);
			});
		},
		[focus, onPlaceholderCreate, journalDenormalize],
	);

	// Read-only empty day: nothing to edit, no create path.
	if (
		!entry &&
		journalDayBodyMode({ hasEntry: false, canMutate: mutable }) === JournalDayBodyMode.ReadOnlyEmpty
	) {
		return (
			<div className="journal__entry-body">
				<div className="journal__empty">
					<p>{t("noEntryYet")}</p>
				</div>
			</div>
		);
	}

	// Deterministic id for the focused day — identical before and after the
	// lazy create, so the editor below reconciles as the SAME instance across the
	// transition (no remount).
	const noteId = entry ? entry.noteId : journalEntryIdForKey(dateKeyForJournal(focus));

	const pending = pendingSeedRef.current?.get(noteId);
	if (pending !== undefined) pendingSeedRef.current?.delete(noteId);
	// Seeds (templates / periodic) only apply to an already-created entry; the
	// empty-day typing path takes NO seed — keystrokes flow straight into the
	// live editor, so there's nothing to seed and nothing to lose.
	const seedBody = entry ? (pending ?? entry.seedBody) : undefined;

	const entryLocked =
		entry != null &&
		(snapshot?.entities.some((e) => e.id === entry.noteId && e.properties.locked === true) ?? false);
	const editable = mutable && !entryLocked;
	const onBodyDenormalize = entry ? journalDenormalize : lazyDenormalize;

	const outgoing = entry && snapshot ? findOutgoingLinks(snapshot, entry.noteId) : [];
	const backlinks = entry && snapshot ? findBacklinks(snapshot, entry.noteId) : [];

	return (
		<div className="journal__entry-body">
			{!entry && mutable ? (
				<div className="journal__templates">
					<span className="journal__templates-label">{t("templatesLabel")}</span>
					<div className="journal__templates-chips">
						{resolveTemplates().map((template) => (
							<button
								key={template.id}
								type="button"
								className="journal__template-chip"
								onClick={() => onTemplate(focus, template)}
							>
								{template.name}
							</button>
						))}
					</div>
				</div>
			) : null}
			{/* Focusing the writing area = intent to write, so create the entity
			    then (before the first keystroke), not on mere navigation — keeps
			    browsing from minting empty days while ensuring the row exists in
			    time for content-bearing persists. Lazy create on first edit backstops. */}
			<div
				className="journal__entry-editor-host"
				{...(entry ? {} : { onFocus: () => void onPlaceholderCreate(focus) })}
			>
				{resolver ? (
					<EntryEditorIsland
						resolver={resolver.resolve}
						noteId={noteId}
						editable={editable}
						seedBody={seedBody}
						onDenormalize={onBodyDenormalize}
						comments={commentHooks}
						{...(entry ? {} : { placeholder: t("writeHint") })}
					/>
				) : (
					<p className="journal__entry-text">{entry?.preview ?? ""}</p>
				)}
			</div>
			{entry ? (
				<>
					<div className="journal__entry-meta">
						<span>{journalPlural(t, entry.wordCount, "wordOne", "wordOther")}</span>
						{mutable ? (
							<button
								type="button"
								className="journal__link-btn"
								ref={linkRef}
								onClick={() => linkRef.current && onLink(entry, linkRef.current)}
							>
								{t("insertLink")}
							</button>
						) : null}
					</div>
					<CheckIn entry={entry} onMood={onMood} onHabit={onHabit} />
					{outgoing.length > 0 ? (
						<OutgoingPanel
							links={outgoing}
							onOpen={(link, event) =>
								void openEntity(getJournalRuntime(), {
									entityId: link.destNoteId,
									entityType: link.destType,
									mode: navModeFromEvent(event.nativeEvent),
								})
							}
						/>
					) : null}
					{backlinks.length > 0 ? (
						<BacklinksPanel
							backlinks={backlinks}
							onOpen={(link, event) =>
								void openEntity(getJournalRuntime(), {
									entityId: link.sourceNoteId,
									entityType: link.sourceType,
									mode: navModeFromEvent(event.nativeEvent),
								})
							}
						/>
					) : null}
				</>
			) : null}
		</div>
	);
}
