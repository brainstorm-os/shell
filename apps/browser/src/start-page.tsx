/**
 * StartPage (POLISH-DSN-3) — the new-tab surface. Rendered in
 * `.browser__region` while the active tab is blank; the shell's
 * WebContentsView is parked at zero bounds meanwhile (same mechanism as the
 * reader sheet), so this is fully visible and clickable. Content: a
 * most-visited tile grid from the vault's browsing history, or — when there
 * is no history, or in a private tab — the shared `<EmptyState>` pointing at
 * the (already focused) address bar.
 */

import { EmptyState } from "@brainstorm-os/sdk/empty-state";
import { IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import { useMemo } from "react";
import { t } from "./i18n";
import { type HistoryVisit, visitLabel } from "./logic/history";
import { siteHost, siteMonogram, startPageSites } from "./logic/start-page";

export function StartPage({
	visits,
	isPrivate,
	onOpen,
}: {
	visits: readonly HistoryVisit[];
	/** Private tabs never surface history — the grid is suppressed. */
	isPrivate: boolean;
	onOpen: (url: string) => void;
}): ReactElement {
	const sites = useMemo(() => (isPrivate ? [] : startPageSites(visits)), [visits, isPrivate]);

	if (sites.length === 0) {
		return (
			<div className="browser-start browser-start--empty">
				<EmptyState icon={IconName.KindUrl} title={t("start.emptyTitle")} hint={t("start.emptyHint")} />
			</div>
		);
	}

	return (
		<div className="browser-start">
			<h2 className="browser-start__heading">{t("start.recent")}</h2>
			<div className="browser-start__grid">
				{sites.map((visit) => {
					const host = siteHost(visit.url);
					return (
						<button
							key={visit.url}
							type="button"
							className="browser-start__tile"
							title={visit.url}
							onClick={() => onOpen(visit.url)}
						>
							<span className="browser-start__monogram" aria-hidden="true">
								{siteMonogram(visit.url)}
							</span>
							<span className="browser-start__tile-title">{visitLabel(visit)}</span>
							{host.length > 0 ? <span className="browser-start__tile-host">{host}</span> : null}
						</button>
					);
				})}
			</div>
		</div>
	);
}
