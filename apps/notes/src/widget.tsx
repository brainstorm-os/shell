/**
 * Notes dashboard widget (Stage 7.3 / 7.3b). When Notes is launched as a
 * dashboard widget (`launch.reason === "widget"`), `main.tsx` mounts this instead
 * of the full app — the same bundle, in widget-mode. The one registered widget,
 * `recent-notes`, is a glance list of notes with an in-widget sort control; the
 * shell strip above draws the title / open / collapse / ⋯ chrome, and clicking a
 * row opens that note in the full Notes app.
 */

import { useVaultEntities } from "@brainstorm/react-yjs";
import { SelectMenu } from "@brainstorm/sdk/select-menu";
import "@brainstorm/sdk/select-menu.css";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm/sdk/widget";
import { useMemo, useState } from "react";
import { t, tCount } from "./i18n/t";
import { NOTE_TYPE } from "./store/entities-repository";
import { getBrainstorm, openEntityInShell } from "./store/runtime";
import "./widget.css";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const NOTES_WIDGET_RECENT = "recent-notes";

const RECENT_LIMIT = 8;

/** Server-side narrowing for the widget's entity subscription (F-384) —
 *  module-level so the reference is stable across renders. */
const WIDGET_QUERY = { types: [NOTE_TYPE] } as const;

/** Empty-state CTA (F-381): an entityType-only `open` routes to the type's
 *  registered opener and launches the full Notes app. */
function openNotesApp(): void {
	const intents = getBrainstorm()?.services.intents;
	if (!intents) return;
	void intents.dispatch({ verb: "open", payload: { entityType: NOTE_TYPE } });
}

/** How the glance list is ordered — the in-widget sort control's value set. */
enum NotesSort {
	Edited = "edited",
	Created = "created",
	Title = "title",
}

type RecentNote = { id: string; title: string };

function noteTitle(properties: Record<string, unknown>): string {
	const title = properties.title;
	return typeof title === "string" && title.trim().length > 0 ? title : t("notes.list.untitled");
}

function RecentNotes({
	notes,
	total,
	sort,
	onSort,
}: {
	notes: RecentNote[];
	total: number;
	sort: NotesSort;
	onSort: (next: NotesSort) => void;
}) {
	return (
		<div className="notes-widget">
			<div className="notes-widget__toolbar">
				<SelectMenu<NotesSort>
					value={sort}
					onChange={onSort}
					ariaLabel={t("notes.widget.sort.label")}
					options={[
						{ value: NotesSort.Edited, label: t("notes.widget.sort.edited") },
						{ value: NotesSort.Created, label: t("notes.widget.sort.created") },
						{ value: NotesSort.Title, label: t("notes.widget.sort.title") },
					]}
				/>
				<span className="notes-widget__count">{tCount("notes.widget.count", total)}</span>
			</div>
			{notes.length === 0 ? (
				<WidgetEmpty
					message={t("notes.widget.empty")}
					actionLabel={t("notes.widget.emptyAction")}
					onAction={openNotesApp}
				/>
			) : (
				<ul className="notes-widget__list">
					{notes.map((note) => (
						<li key={note.id}>
							<button
								type="button"
								className="notes-widget__row"
								onClick={() => void openEntityInShell({ entityId: note.id, entityType: NOTE_TYPE })}
							>
								{note.title}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function sortNotes(notes: readonly RecentNote[], sort: NotesSort): RecentNote[] {
	// `notes` is already ordered newest-edited-first; only Title needs a re-sort.
	if (sort !== NotesSort.Title) return [...notes];
	return [...notes].sort((a, b) => a.title.localeCompare(b.title));
}

export function NotesWidget({ launch }: { launch: WidgetLaunch }) {
	const runtime = getBrainstorm();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const [sort, setSort] = useState<NotesSort>(NotesSort.Edited);
	const { entities } = useVaultEntities(runtime?.services.vaultEntities ?? null, {
		query: WIDGET_QUERY,
	});

	const live = useMemo(
		() => entities.filter((e) => e.type === NOTE_TYPE && e.deletedAt === null),
		[entities],
	);
	const total = live.length;

	const notes = useMemo<RecentNote[]>(() => {
		const ordered = [...live].sort((a, b) =>
			sort === NotesSort.Created ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt,
		);
		const top = ordered
			.slice(0, RECENT_LIMIT)
			.map((e) => ({ id: e.id, title: noteTitle(e.properties) }));
		return sortNotes(top, sort);
	}, [live, sort]);

	return (
		<WidgetRoot
			widgets={[
				{
					id: NOTES_WIDGET_RECENT,
					render: () => <RecentNotes notes={notes} total={total} sort={sort} onSort={setSort} />,
				},
			]}
			launch={launch}
		/>
	);
}
