/**
 * Bookmark properties inspector — a thin adapter over the SHARED
 * `@brainstorm/sdk/properties-panel`. It only maps the bookmark's bridged
 * fields (see `bookmark-properties.ts`) to the generic `rows` the shared panel
 * renders; all chrome (glass slide-over, header, grid rows) lives in the SDK
 * component, identical to Notes / Journal / Database.
 *
 * URL / Type / Saved are display-only; Site / Author / Published / Description /
 * Notes / Tags / Read / Archived are editable and write back through the typed
 * bridge (Site → `siteName`, Author → `author`, Published → `publishedAt`).
 * The OQ-DM-1 migration (bookmark → property-bearing entity) later swaps the
 * bridge for the entity's real `values` with no panel change.
 */

import { EntityCommentsPanel } from "@brainstorm/editor";
import { PropertiesPanel, type PropertiesPanelRow } from "@brainstorm/sdk/properties-panel";
import { readValue, useDictionary, useDictionaryStore } from "@brainstorm/sdk/property-ui";
import { t } from "../i18n/manifest";
import {
	BOOKMARK_PROPERTY_DEFS,
	BOOKMARK_PROP_KEY,
	BOOKMARK_TAGS_DICTIONARY_ID,
	READONLY_BOOKMARK_PROP_KEYS,
	applyBookmarkPropertyValue,
	bookmarkToValues,
} from "../properties/bookmark-properties";
import { getBrainstorm } from "../storage/runtime";
import type { Bookmark } from "../types/bookmark";

/** Whether a scrape-only metadata row should render. Only the derived,
 *  read-only Type row hides when the page declared no `og:type` (it would be a
 *  permanently-empty property the user can't fill). Author / Published always
 *  render — they're editable (F-204), so an empty row is the affordance for
 *  adding the citation data the scraper missed. */
export function isVisibleScrapeRow(key: string, bookmark: Bookmark): boolean {
	if (key === BOOKMARK_PROP_KEY.type) return Boolean(bookmark.mediaType);
	return true;
}

export type BookmarkPropertiesPanelProps = {
	bookmark: Bookmark;
	open: boolean;
	onChange: (partial: Partial<Bookmark>) => void;
	onClose: () => void;
};

export function BookmarkPropertiesPanel({
	bookmark,
	open,
	onChange,
	onClose,
}: BookmarkPropertiesPanelProps): React.ReactElement {
	// The label↔item-id bridge for the Tags cell (the bookmark stores label
	// strings; the cell speaks dictionary item ids).
	const tagsDict = useDictionary(BOOKMARK_TAGS_DICTIONARY_ID);
	const dictionaryStore = useDictionaryStore();
	const values = bookmarkToValues(bookmark, tagsDict);
	// A locked bookmark is read-only — every property row paints read-only (the
	// lock toggle itself lives in the detail header, outside this panel).
	const locked = bookmark.locked === true;
	const rows: PropertiesPanelRow[] = BOOKMARK_PROPERTY_DEFS
		// Only the read-only Type row hides when the page declared no og:type;
		// editable rows (Author / Published) render even when empty (F-204).
		.filter((def) => isVisibleScrapeRow(def.key, bookmark))
		.map((def) => {
			const readOnly =
				locked ||
				READONLY_BOOKMARK_PROP_KEYS.has(def.key) ||
				// Tags stay read-only until the vocabulary is loaded — editing
				// without it would write raw item ids into the label-keyed
				// `tags` field (tag board / sidebar key on labels).
				(def.key === BOOKMARK_PROP_KEY.tags && tagsDict === undefined);
			const row: PropertiesPanelRow = { def, value: readValue(values, def), readOnly };
			if (!readOnly) {
				row.onChange = (next) => {
					// Resolve the dictionary at EVENT time, not render time — an
					// inline-created tag lands in the store before the cell's
					// onChange fires, and a render-captured snapshot would map the
					// fresh item id back to a raw-id label.
					const liveDict = dictionaryStore.store.get(BOOKMARK_TAGS_DICTIONARY_ID) ?? tagsDict;
					const partial = applyBookmarkPropertyValue(def.key, next, Date.now(), liveDict);
					if (partial) onChange(partial);
				};
			}
			return row;
		});
	const services = getBrainstorm()?.services ?? null;
	return (
		<aside
			className={open ? "bs-props bs-props--open glass--strong" : "bs-props glass--strong"}
			aria-label={t("detail.properties")}
			aria-hidden={!open}
			{...(open ? {} : { inert: true })}
		>
			<EntityCommentsPanel
				services={services}
				documentId={bookmark.id}
				properties={({ tabbed }) => (
					<PropertiesPanel
						title={t("detail.properties")}
						rows={rows}
						entityId={bookmark.id}
						{...(tabbed ? { hideHeader: true } : { onClose, closeLabel: t("header.inspector.hide") })}
					/>
				)}
			/>
		</aside>
	);
}
