/**
 * `<FileSidebar>` — the left library pane. Lists the vault's previewable
 * files newest-first with a Notes-style filter box on top, so opening Preview
 * standalone lands on something browsable instead of an empty stage. Picking a
 * row loads that file into the host (single-file gallery); the active row is
 * highlighted by id.
 *
 * The list is a vertical listbox via the shared composite-keyboard reducer
 * (`useCompositeKeyboard` from `@brainstorm/sdk/a11y`) — ArrowUp/Down rove,
 * Enter/Space opens — matching the Notes sidebar's keyboard model. Arrow-move
 * also opens the file (select === open), so the keyboard walk is a live
 * preview, the same single select-and-open action Notes uses.
 */

import { Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import type { PreviewFile } from "../demo/dataset";
import { t } from "../i18n";
import { filterPreviewFiles } from "../logic/vault-files";
import { kindClassFor, kindGlyphFor } from "./filmstrip-thumb";

export function FileSidebar({
	files,
	activeId,
	onOpen,
}: {
	files: readonly PreviewFile[];
	activeId: string | null;
	onOpen: (file: PreviewFile) => void;
}): ReactElement {
	const [query, setQuery] = useState("");
	const visible = useMemo(() => filterPreviewFiles(files, query), [files, query]);

	const activeIndex = useMemo(
		() => visible.findIndex((f) => f.id === activeId),
		[visible, activeId],
	);

	const openAt = useCallback(
		(index: number) => {
			const file = visible[index];
			if (file) onOpen(file);
		},
		[visible, onOpen],
	);

	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: visible.length,
		activeIndex,
		onActiveIndexChange: openAt,
		onActivate: openAt,
		useAriaActiveDescendant: true,
	});

	return (
		<aside className="preview__sidebar" aria-label={t("sidebar.region")}>
			<div className="preview__sidebar-search">
				<span className="preview__sidebar-search-icon" aria-hidden="true">
					<Icon name={IconName.Search} size={14} />
				</span>
				<input
					type="search"
					className="bs-input bs-input--sm preview__sidebar-input"
					value={query}
					placeholder={t("sidebar.filterPlaceholder")}
					aria-label={t("sidebar.filterPlaceholder")}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</div>
			{visible.length === 0 ? (
				<div className="preview__sidebar-empty">
					<p>{query.trim() ? t("sidebar.noMatches") : t("sidebar.empty")}</p>
				</div>
			) : (
				<ul {...containerProps} className="preview__sidebar-list" aria-label={t("sidebar.region")}>
					{visible.map((file, i) => {
						const isActive = file.id === activeId;
						return (
							<li key={file.id} {...getItemProps(i)} className="preview__sidebar-row">
								<button
									type="button"
									className={
										isActive ? "preview__sidebar-item preview__sidebar-item--active" : "preview__sidebar-item"
									}
									tabIndex={-1}
									title={file.info.name}
									onClick={() => onOpen(file)}
								>
									<span
										className={`preview__sidebar-icon preview__sidebar-icon--${kindClassFor(file.info.mime)}`}
										aria-hidden="true"
									>
										{kindGlyphFor(file.info.mime)}
									</span>
									<span className="preview__sidebar-name">{file.info.name}</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</aside>
	);
}
