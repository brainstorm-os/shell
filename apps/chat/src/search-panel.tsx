/**
 * Chats-1 — the message-search strip above the transcript: a query box, a
 * This channel / All channels scope switch, and the newest-first result list
 * (channel + author + time + snippet). Picking a result jumps the transcript
 * to that message and flashes it; the strip stays open so the next result is
 * one click away. Escape (the `chat.close-search` action) closes it.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { Searchbar } from "@brainstorm-os/sdk/searchbar";
import { type ReactElement, useMemo, useRef } from "react";
import { formatStamp } from "./format";
import { plural, t } from "./i18n";
import type { EntityLike } from "./logic/chat";
import {
	SEARCH_MIN_QUERY,
	SEARCH_RESULT_LIMIT,
	type SearchHit,
	SearchScope,
	searchMessages,
} from "./logic/search";
import { ChatAction, useChatShortcut } from "./shortcuts";

export function SearchPanel({
	entities,
	activeChannelId,
	activeChannelName,
	query,
	scope,
	onQueryChange,
	onScopeChange,
	onSelect,
	onClose,
}: {
	entities: readonly EntityLike[];
	activeChannelId: string | null;
	activeChannelName: string | null;
	query: string;
	scope: SearchScope;
	onQueryChange: (next: string) => void;
	onScopeChange: (next: SearchScope) => void;
	onSelect: (hit: SearchHit) => void;
	onClose: () => void;
}): ReactElement {
	const rootRef = useRef<HTMLElement>(null);
	useChatShortcut(ChatAction.CloseSearch, onClose, { scope: rootRef });

	const hits = useMemo(
		() => searchMessages(entities, query, { scope, channelId: activeChannelId }),
		[entities, query, scope, activeChannelId],
	);
	const tooShort = query.trim().length < SEARCH_MIN_QUERY;

	let status: string;
	if (tooShort) status = t("search.hint");
	else if (hits.length === 0) status = t("search.none");
	else if (hits.length >= SEARCH_RESULT_LIMIT)
		status = t("search.capped", { count: SEARCH_RESULT_LIMIT });
	else status = plural(hits.length, "search.results.one", "search.results.other");

	return (
		<section
			ref={rootRef}
			className="chat__search"
			aria-label={t("search.title")}
			data-testid="search-panel"
		>
			<div className="chat__search-bar">
				<Searchbar
					value={query}
					onChange={onQueryChange}
					placeholder={
						scope === SearchScope.Channel && activeChannelName
							? t("search.placeholder.channel", { name: activeChannelName })
							: t("search.placeholder.all")
					}
					clearLabel={t("search.clear")}
					autoFocus
					className="chat__search-input"
					inputTestId="search-input"
				/>
				<div className="bs-segmented" role="group" aria-label={t("search.scope")}>
					<button
						type="button"
						className="bs-segmented__tab"
						aria-pressed={scope === SearchScope.Channel}
						disabled={!activeChannelId}
						onClick={() => onScopeChange(SearchScope.Channel)}
						data-testid="search-scope-channel"
					>
						{t("search.scope.channel")}
					</button>
					<button
						type="button"
						className="bs-segmented__tab"
						aria-pressed={scope === SearchScope.All}
						onClick={() => onScopeChange(SearchScope.All)}
						data-testid="search-scope-all"
					>
						{t("search.scope.all")}
					</button>
				</div>
				<button
					type="button"
					className="chat__icon-btn"
					data-bs-tooltip={t("search.close")}
					aria-label={t("search.close")}
					onClick={onClose}
				>
					<Icon name={IconName.Close} size={16} />
				</button>
			</div>
			<p className="chat__search-status" aria-live="polite" data-testid="search-status">
				{status}
			</p>
			{hits.length > 0 ? (
				<ul className="chat__search-results" data-testid="search-results">
					{hits.map((hit) => (
						<li key={hit.messageId}>
							<button type="button" className="chat__search-hit" onClick={() => onSelect(hit)}>
								<span className="chat__search-hit-meta">
									<span className="chat__search-hit-channel">
										<span aria-hidden="true">#</span>
										{hit.channelName}
									</span>
									<span className="chat__search-hit-author">{hit.authorName}</span>
									<time className="chat__search-hit-time" dateTime={hit.createdAt}>
										{formatStamp(hit.createdAt)}
									</time>
								</span>
								<span className="chat__search-hit-snippet">{hit.snippet}</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}
