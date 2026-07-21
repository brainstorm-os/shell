/**
 * Journal dashboard widget. When Journal is launched as a dashboard widget
 * (`launch.reason === "widget"`), `main.tsx` mounts this instead of the full
 * app — the same bundle, in widget-mode. The one registered widget,
 * `today-journal`, is a glance at today's entry (or a write-today CTA) plus
 * the trailing written days and the current streak; the shell strip above
 * draws the title / open / collapse / ⋯ chrome, and clicking a row opens
 * that day in the full Journal app via the shared `intent.open`.
 *
 * Mirrors the Contacts `list-contacts` widget. Reactive over the shell's
 * live vault-entity index through `useVaultEntities` (never the raw
 * `onChange` — the sanctioned reactivity stack), filtered to `Entry/v1`.
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { openEntity } from "@brainstorm-os/sdk";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm-os/sdk/widget";
import { useMemo } from "react";
import { buildJournalT, journalPlural } from "./logic/journal-i18n";
import { JOURNAL_ENTRY_TYPE, getJournalRuntime } from "./runtime";
import {
	JOURNAL_WIDGET_QUERY,
	JOURNAL_WIDGET_TODAY,
	type JournalWidgetModel,
	type WidgetJournalRow,
	shapeJournalWidget,
} from "./widget-data";
import "./widget.css";

const t = buildJournalT();

const OPEN_VERB = "open";

/** Open a journal day in the full app through the shared open verb (cap
 *  `intents.dispatch:open`). */
function openEntry(entityId: string): void {
	void openEntity(getJournalRuntime(), { entityId, entityType: JOURNAL_ENTRY_TYPE });
}

/** Type-only `open` — no `entityId`, so the shell routes to the type's
 *  registered opener and launches the Journal app (which lands on today). */
function openJournalApp(): void {
	const intents = getJournalRuntime()?.services?.intents;
	if (!intents) return;
	void intents.dispatch({ verb: OPEN_VERB, payload: { entityType: JOURNAL_ENTRY_TYPE } });
}

function WriteTodayEmpty() {
	return (
		<WidgetEmpty
			message={t("widget.noEntryToday")}
			actionLabel={t("widget.writeToday")}
			onAction={openJournalApp}
		/>
	);
}

function PreviousRow({ row }: { row: WidgetJournalRow }) {
	return (
		<li>
			<button type="button" className="journal-widget__row" onClick={() => openEntry(row.id)}>
				<span className="journal-widget__row-date">{row.dateLabel}</span>
				<span className="journal-widget__row-snippet">{row.snippet}</span>
			</button>
		</li>
	);
}

function JournalGlance({ model }: { model: JournalWidgetModel }) {
	const { today, previous, streak } = model;
	if (!today && previous.length === 0) {
		return (
			<div className="journal-widget">
				<WriteTodayEmpty />
			</div>
		);
	}
	return (
		<div className="journal-widget">
			<div className="journal-widget__toolbar">
				<span className="journal-widget__label">{t("today")}</span>
				<span className="journal-widget__streak">
					{streak === 0 ? t("streakNone") : journalPlural(t, streak, "streakOne", "streakMany")}
				</span>
			</div>
			{today ? (
				<button type="button" className="journal-widget__today" onClick={() => openEntry(today.id)}>
					{today.snippet}
				</button>
			) : (
				<WriteTodayEmpty />
			)}
			{previous.length > 0 ? (
				<ul className="journal-widget__list">
					{previous.map((row) => (
						<PreviousRow key={row.id} row={row} />
					))}
				</ul>
			) : null}
		</div>
	);
}

export function JournalWidget({ launch }: { launch: WidgetLaunch }) {
	const runtime = getJournalRuntime();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const { entities } = useVaultEntities(runtime?.services?.vaultEntities ?? null, {
		query: JOURNAL_WIDGET_QUERY,
	});

	const model = useMemo(() => shapeJournalWidget(entities), [entities]);

	return (
		<WidgetRoot
			widgets={[{ id: JOURNAL_WIDGET_TODAY, render: () => <JournalGlance model={model} /> }]}
			launch={launch}
		/>
	);
}
