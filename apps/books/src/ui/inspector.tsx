/**
 * The Books right inspector — a thin adapter over the SHARED
 * `@brainstorm-os/sdk/properties-panel` (chrome identical to Notes / Journal /
 * Database / Contacts), wrapped in the shared `.bs-props` glass slide-over
 * container. It contributes the Books-specific content slots: the cover
 * band (`lead` — host carries `flex-shrink: 0` per the cover-host rule),
 * the property rows (author writes back; format / pages / progress are
 * read-only facts), the table of contents (`children` — click navigates the
 * mounted reader), and the last-read / added metadata footer.
 */

import { EntityCommentsPanel } from "@brainstorm-os/editor";
import { formatDate } from "@brainstorm-os/sdk/date-formatters";
import type { CoverSubject } from "@brainstorm-os/sdk/entity-cover";
import {
	PropertiesPanel,
	type PropertiesPanelMeta,
	type PropertiesPanelRow,
} from "@brainstorm-os/sdk/properties-panel";
import type { ReactElement } from "react";
import { t } from "../i18n";
import {
	READONLY_BOOK_PROP_KEYS,
	applyBookPropertyValue,
	bookPropertyDefs,
	bookToValues,
} from "../logic/book-properties";
import type { TocEntry } from "../logic/toc";
import { getBooksRuntime } from "../runtime";
import type { Book } from "../types/book";
import type { Locator } from "../types/locator";
import { EntityCover } from "./entity-visuals";

export type BookInspectorProps = {
	book: Book;
	/** The raw entity (id + properties bag) the cover band resolves against
	 *  — the universal `properties.cover`, seeded gradient fallback. */
	subject: CoverSubject;
	toc: readonly TocEntry[];
	open: boolean;
	/** Sample / standalone books render read-only (no entity to patch). */
	readOnly: boolean;
	onPatch: (patch: Record<string, unknown>) => void;
	onNavigate: (locator: Locator) => void;
	onClose: () => void;
};

export function BookInspector({
	book,
	subject,
	toc,
	open,
	readOnly,
	onPatch,
	onNavigate,
	onClose,
}: BookInspectorProps): ReactElement {
	const values = bookToValues(book);
	const rows: PropertiesPanelRow[] = bookPropertyDefs().map((def) => {
		const locked = readOnly || READONLY_BOOK_PROP_KEYS.has(def.key);
		const row: PropertiesPanelRow = { def, value: values[def.key], readOnly: locked };
		if (!locked) {
			row.onChange = (next) => {
				const patch = applyBookPropertyValue(def.key, next);
				if (patch) onPatch(patch);
			};
		}
		return row;
	});

	const meta: PropertiesPanelMeta[] = [
		{
			label: t("meta.lastRead"),
			value: book.reading.lastReadAt === null ? t("meta.never") : formatDate(book.reading.lastReadAt),
		},
		{
			label: t("meta.added"),
			value: book.createdAt > 0 ? formatDate(book.createdAt) : t("meta.never"),
		},
	];

	const services = getBooksRuntime()?.services ?? null;
	return (
		<aside
			className={
				open
					? "bs-props books__props bs-props--open glass--strong"
					: "bs-props books__props glass--strong"
			}
			aria-label={t("inspector.title")}
			aria-hidden={!open}
			{...(open ? {} : { inert: true })}
		>
			<EntityCommentsPanel
				services={services}
				documentId={book.id}
				properties={({ tabbed }) => (
					<PropertiesPanel
						title={t("inspector.title")}
						rows={rows}
						entityId={book.id}
						{...(tabbed ? { hideHeader: true } : { onClose, closeLabel: t("inspector.hide") })}
						meta={meta}
						lead={
							<div className="books__cover">
								<EntityCover subject={subject} aspect={16 / 6} />
							</div>
						}
					>
						<section className="books__toc" aria-label={t("toc.title")}>
							<h3 className="books__toc-title">{t("toc.title")}</h3>
							{toc.length === 0 ? (
								<p className="books__toc-empty">{t("toc.empty")}</p>
							) : (
								<ul className="books__toc-list">
									{toc.map((entry, index) => (
										<li key={`${index}-${entry.title}`} className="books__toc-item">
											<button
												type="button"
												className="books__toc-link"
												style={{
													paddingInlineStart: `calc(var(--space-2) + ${entry.depth} * var(--space-4))`,
												}}
												onClick={() => onNavigate(entry.locator)}
											>
												{entry.title}
											</button>
										</li>
									))}
								</ul>
							)}
						</section>
					</PropertiesPanel>
				)}
			/>
		</aside>
	);
}
