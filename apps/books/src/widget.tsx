/**
 * Books "currently-reading" dashboard widget. When Books is launched as a
 * dashboard widget (`launch.reason === "widget"`), `main.tsx` mounts this
 * instead of the full app — the same bundle, in widget-mode. The body is a
 * glance list of the books partway through (progress bar + percent), falling
 * back to the most recently added books, and clicking a row opens that book
 * in the full Books app via the shared `intent.open`.
 *
 * Mirrors the Contacts `list-contacts` widget. Reactive over the shell's live
 * vault-entity index through `useVaultEntities` (never the raw `onChange`),
 * narrowed by the typed `BOOKS_WIDGET_QUERY` — Books has no `entities.read:*`,
 * so the scoped read only clears the widget bridge as a per-type query.
 */

import { useVaultEntities } from "@brainstorm/react-yjs";
import { openEntity } from "@brainstorm/sdk";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm/sdk/widget";
import { useMemo } from "react";
import { plural, t } from "./i18n";
import { getBooksRuntime } from "./runtime";
import { BOOK_ENTITY_TYPE } from "./types/book";
import {
	BOOKS_WIDGET_QUERY,
	BOOKS_WIDGET_READING,
	BookRowStatus,
	BooksWidgetMode,
	type WidgetBook,
	shapeBooksWidget,
} from "./widget-data";
import "./widget.css";

/** Open a book in the full Books app through the shared open verb (cap
 *  `intents.dispatch:open`). Mirrors the Contacts widget's `openContact`. */
function openBook(entityId: string): void {
	const intents = getBooksRuntime()?.services?.intents;
	if (!intents?.dispatch) return;
	void openEntity(
		{
			services: {
				intents: {
					dispatch: (intent) => intents.dispatch?.(intent),
				},
			},
		},
		{ entityId, entityType: BOOK_ENTITY_TYPE },
	);
}

/** Type-only open — no `entityId`, so the shell routes to the `Book/v1`
 *  opener and just launches Books (the empty-state CTA). */
function openBooksApp(): void {
	const intents = getBooksRuntime()?.services?.intents;
	void intents?.dispatch?.({ verb: "open", payload: { entityType: BOOK_ENTITY_TYPE } });
}

function BookRow({ book }: { book: WidgetBook }) {
	return (
		<li>
			<button type="button" className="books-widget__row" onClick={() => openBook(book.id)}>
				<span className="books-widget__main">
					<span className="books-widget__title">{book.title}</span>
					{book.author ? <span className="books-widget__author">{book.author}</span> : null}
				</span>
				{book.status === BookRowStatus.InProgress ? (
					<span className="books-widget__progress">
						<span className="books-widget__track" aria-hidden="true">
							<span className="books-widget__fill" style={{ width: `${book.percent}%` }} />
						</span>
						<span className="books-widget__percent">
							{t("library.rowProgress", { percent: book.percent })}
						</span>
					</span>
				) : (
					<span className="books-widget__caption">
						{book.status === BookRowStatus.Finished
							? t("widget.finished")
							: t("library.section.notStarted")}
					</span>
				)}
			</button>
		</li>
	);
}

function ReadingList({ books, inProgressCount }: { books: WidgetBook[]; inProgressCount: number }) {
	return (
		<div className="books-widget">
			<div className="books-widget__toolbar">
				<span className="books-widget__label">{t("widget.label")}</span>
				<span className="books-widget__count">
					{plural(inProgressCount, "widget.inProgress.one", "widget.inProgress.other")}
				</span>
			</div>
			<ul className="books-widget__list">
				{books.map((book) => (
					<BookRow key={book.id} book={book} />
				))}
			</ul>
		</div>
	);
}

export function BooksWidget({ launch }: { launch: WidgetLaunch }) {
	const runtime = getBooksRuntime();
	// Host-driven pause: a scrolled-off widget stops re-rendering.
	useWidgetVisible();
	const { entities } = useVaultEntities(runtime?.services?.vaultEntities ?? null, {
		query: BOOKS_WIDGET_QUERY,
	});

	const { mode, books, inProgressCount } = useMemo(() => shapeBooksWidget(entities), [entities]);

	return (
		<WidgetRoot
			widgets={[
				{
					id: BOOKS_WIDGET_READING,
					render: () =>
						mode === BooksWidgetMode.Empty ? (
							<WidgetEmpty
								message={t("library.empty")}
								actionLabel={t("widget.openBooks")}
								onAction={openBooksApp}
							/>
						) : (
							<ReadingList books={books} inProgressCount={inProgressCount} />
						),
				},
			]}
			launch={launch}
		/>
	);
}
