/**
 * The library shelf — the left panel listing every `Book/v1` in the vault,
 * grouped into recency sections (the Notes-sidebar model: Today / Yesterday /
 * … / Not started) via `buildLibrarySections`. Search state is panel-local;
 * selection is the app's. No sort dropdown — the recency grouping IS the order
 * (matching Notes' chrome-light sidebar).
 */

import { Searchbar } from "@brainstorm-os/sdk/searchbar";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { t } from "../i18n";
import { buildLibrarySections } from "../logic/library";
import type { Book } from "../types/book";
import { EntityIcon } from "./entity-visuals";

export type LibraryPanelProps = {
	books: readonly Book[];
	selectedId: string | null;
	/** Collapsed via CSS (not unmounted) so search state survives the header
	 *  toggle. */
	open: boolean;
	onSelect: (id: string) => void;
	/** A user-facing import failure (e.g. capability not granted) — shown as a
	 *  dismissable banner so a failed import is never silent. */
	importError?: string | null;
	onDismissError?: (() => void) | undefined;
};

export function LibraryPanel({
	books,
	selectedId,
	open,
	onSelect,
	importError,
	onDismissError,
}: LibraryPanelProps): ReactElement {
	const [query, setQuery] = useState("");

	const sections = useMemo(
		() =>
			buildLibrarySections(
				books,
				query,
				{
					today: t("library.section.today"),
					yesterday: t("library.section.yesterday"),
					last7: t("library.section.last7"),
					last30: t("library.section.last30"),
					notStarted: t("library.section.notStarted"),
				},
				Date.now(),
			),
		[books, query],
	);
	const hasResults = sections.length > 0;

	return (
		<aside
			className={open ? "books__library" : "books__library books__library--closed"}
			aria-label={t("library.title")}
			aria-hidden={!open}
			{...(open ? {} : { inert: true })}
			id="books-library"
		>
			<header className="books__library-head">
				<h2 className="books__library-title">{t("library.title")}</h2>
			</header>
			<div className="books__library-tools">
				<Searchbar
					value={query}
					onChange={setQuery}
					placeholder={t("library.search")}
					ariaLabel={t("library.search")}
					clearLabel={t("library.searchClear")}
				/>
			</div>
			{importError ? (
				<div className="books__import-error" role="alert">
					<span className="books__import-error-text">{importError}</span>
					{onDismissError ? (
						<button type="button" className="bs-btn bs-btn--sm bs-btn--ghost" onClick={onDismissError}>
							{t("import.dismiss")}
						</button>
					) : null}
				</div>
			) : null}
			{books.length === 0 ? (
				// Quiet note only — the primary "Import a book" CTA lives on the
				// prominent reader-pane empty hero (one empty state owns the action,
				// not two competing ones). Import also stays in the header menu.
				<div className="books__library-blank">
					<p className="books__library-blank-title">{t("library.empty")}</p>
					<p className="books__library-blank-hint">{t("library.emptyHint")}</p>
				</div>
			) : hasResults ? (
				<div className="books__library-list">
					{sections.map((section) => (
						<section key={section.key} className="books__library-group">
							<h3 className="books__library-section">{section.label}</h3>
							<ul className="books__library-section-list">
								{section.books.map((book) => (
									<LibraryRow
										key={book.id}
										book={book}
										active={book.id === selectedId}
										onSelect={onSelect}
									/>
								))}
							</ul>
						</section>
					))}
				</div>
			) : (
				<p className="books__library-blank-hint books__library-noresults">{t("library.noResults")}</p>
			)}
		</aside>
	);
}

function LibraryRow({
	book,
	active,
	onSelect,
}: {
	book: Book;
	active: boolean;
	onSelect: (id: string) => void;
}): ReactElement {
	const percent = Math.round(book.reading.progress * 100);
	return (
		<li className="books__library-item">
			<button
				type="button"
				className={active ? "books__row books__row--active" : "books__row"}
				aria-current={active ? "true" : undefined}
				onClick={() => onSelect(book.id)}
			>
				<EntityIcon icon={book.icon} className="books__row-icon" size={18} />
				<span className="books__row-text">
					<span className="books__row-title">{book.name || t("library.sampleName")}</span>
					{book.author ? <span className="books__row-author">{book.author}</span> : null}
				</span>
				{percent > 0 ? (
					<span className="books__row-progress">
						{t("library.rowProgress", { percent: String(percent) })}
					</span>
				) : null}
			</button>
		</li>
	);
}
