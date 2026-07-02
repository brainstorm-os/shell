/** Middle column: the message list for the current selection, with search.
 *  Rows show sender, subject, a text snippet, date, and unread/flag/attachment
 *  affordances. When conversation grouping is on, messages sharing a
 *  `threadKey` collapse into one expandable thread row (Mailbox-6 threading
 *  UI — `deriveThreadKey` / OQ-MB-3 shipped in Mailbox-1). */

import { CountBadge, CountBadgeTone } from "@brainstorm/sdk/count-badge";
import { EmptyState, EmptyStateTone } from "@brainstorm/sdk/empty-state";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import type { ReactElement } from "react";
import { plural, t } from "../i18n";
import { messageDateLabel } from "../logic/format";
import { senderLabel } from "../logic/mail-view";
import type { ThreadView } from "../logic/mail-view";
import type { MessageView } from "../types/mail-view";

type RowProps = {
	message: MessageView;
	now: number;
	active: boolean;
	nested?: boolean;
	onSelect: () => void;
};

function MessageRow({ message, now, active, nested = false, onSelect }: RowProps): ReactElement {
	const sender = senderLabel(message) || t("list.noSender");
	const subject = message.subject || t("list.noSubject");
	return (
		<button
			type="button"
			className={`mb-row${nested ? " mb-row--nested" : ""}${active ? " is-active" : ""}${
				message.unread ? " is-unread" : ""
			}`}
			aria-current={active ? "true" : undefined}
			onClick={onSelect}
		>
			<span className="mb-row__rail" aria-hidden="true">
				{message.unread ? <span className="mb-row__dot" title={t("list.unreadDot")} /> : null}
			</span>
			<span className="mb-row__main">
				<span className="mb-row__top">
					<span className="mb-row__sender">{sender}</span>
					<span className="mb-row__date">{messageDateLabel(message.receivedAt, now)}</span>
				</span>
				<span className="mb-row__subject">
					{message.flagged ? (
						<Icon name={IconName.Star} className="mb-row__flag" aria-hidden="true" />
					) : null}
					{subject}
				</span>
				<span className="mb-row__snippet">
					{message.bodyText.slice(0, 140)}
					{message.attachments.length > 0 ? (
						<Icon name={IconName.KindFile} className="mb-row__attach" aria-label={t("list.attachment")} />
					) : null}
				</span>
			</span>
		</button>
	);
}

type ThreadRowProps = {
	thread: ThreadView;
	now: number;
	activeId: string | null;
	expanded: boolean;
	onToggleExpand: () => void;
	onSelect: (id: string) => void;
};

function ThreadRow({
	thread,
	now,
	activeId,
	expanded,
	onToggleExpand,
	onSelect,
}: ThreadRowProps): ReactElement {
	const { latest } = thread;
	const sender = senderLabel(latest) || t("list.noSender");
	const subject = thread.subject || t("list.noSubject");
	const containsActive = thread.messages.some((m) => m.id === activeId);
	return (
		<div className={`mb-thread${expanded ? " is-expanded" : ""}`}>
			<button
				type="button"
				className={`mb-row mb-row--thread${containsActive && !expanded ? " is-active" : ""}${
					thread.unreadCount > 0 ? " is-unread" : ""
				}`}
				aria-current={containsActive && !expanded ? "true" : undefined}
				aria-expanded={expanded}
				aria-label={expanded ? t("list.thread.collapse") : t("list.thread.expand")}
				onClick={onToggleExpand}
			>
				<span className="mb-row__rail" aria-hidden="true">
					{thread.unreadCount > 0 ? <span className="mb-row__dot" title={t("list.unreadDot")} /> : null}
				</span>
				<span className="mb-row__main">
					<span className="mb-row__top">
						<span className="mb-row__sender">{sender}</span>
						<span className="mb-row__date">{messageDateLabel(latest.receivedAt, now)}</span>
					</span>
					<span className="mb-row__subject">
						{thread.flagged ? (
							<Icon name={IconName.Star} className="mb-row__flag" aria-hidden="true" />
						) : null}
						{subject}
						<CountBadge count={thread.count} tone={CountBadgeTone.Accent} />
					</span>
					<span className="mb-row__snippet">
						{plural(thread.count, "list.thread.count.one", "list.thread.count.other", {
							count: thread.count,
						})}
						{thread.hasAttachments ? (
							<Icon
								name={IconName.KindFile}
								className="mb-row__attach"
								aria-label={t("list.attachment")}
							/>
						) : null}
					</span>
				</span>
				<Icon name={IconName.CaretRight} className="mb-thread__chevron" aria-hidden="true" />
			</button>
			{expanded ? (
				<ul className="mb-thread__messages">
					{thread.messages.map((message) => (
						<li key={message.id}>
							<MessageRow
								message={message}
								now={now}
								nested
								active={message.id === activeId}
								onSelect={() => onSelect(message.id)}
							/>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export type MessageListProps = {
	messages: MessageView[];
	threads: ThreadView[];
	threaded: boolean;
	expandedThreads: ReadonlySet<string>;
	activeId: string | null;
	now: number;
	query: string;
	onQueryChange: (q: string) => void;
	onSelect: (id: string) => void;
	onToggleThreaded: () => void;
	onToggleThreadExpand: (threadKey: string) => void;
};

export function MessageList({
	messages,
	threads,
	threaded,
	expandedThreads,
	activeId,
	now,
	query,
	onQueryChange,
	onSelect,
	onToggleThreaded,
	onToggleThreadExpand,
}: MessageListProps): ReactElement {
	const empty = threaded ? threads.length === 0 : messages.length === 0;
	return (
		<div className="mb-list">
			<div className="mb-list__search">
				<label className="mb-list__search-field bs-input bs-input--sm">
					<Icon name={IconName.Search} className="mb-list__search-icon" aria-hidden="true" />
					<input
						type="search"
						className="mb-list__search-input bs-input__control"
						placeholder={t("list.search.placeholder")}
						aria-label={t("list.search.aria")}
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
					/>
				</label>
				<button
					type="button"
					className={`mb-list__thread-toggle${threaded ? " is-on" : ""}`}
					aria-pressed={threaded}
					aria-label={threaded ? t("list.thread.toggle.off") : t("list.thread.toggle.on")}
					data-bs-tooltip={threaded ? t("list.thread.toggle.off") : t("list.thread.toggle.on")}
					onClick={onToggleThreaded}
				>
					<Icon name={IconName.Inbox} aria-hidden="true" />
				</button>
			</div>
			<ul className="mb-list__items" aria-label={t("list.aria")}>
				{empty ? (
					<li>
						{query.trim().length > 0 ? (
							<EmptyState
								tone={EmptyStateTone.Compact}
								icon={IconName.Search}
								title={t("list.noResults", { query })}
							/>
						) : (
							<EmptyState
								tone={EmptyStateTone.Compact}
								icon={IconName.Inbox}
								title={t("list.empty.title")}
								hint={t("list.empty.blurb")}
							/>
						)}
					</li>
				) : threaded ? (
					threads.map((thread) => (
						<li key={thread.threadKey}>
							<ThreadRow
								thread={thread}
								now={now}
								activeId={activeId}
								expanded={expandedThreads.has(thread.threadKey)}
								onToggleExpand={() => onToggleThreadExpand(thread.threadKey)}
								onSelect={onSelect}
							/>
						</li>
					))
				) : (
					messages.map((message) => (
						<li key={message.id}>
							<MessageRow
								message={message}
								now={now}
								active={message.id === activeId}
								onSelect={() => onSelect(message.id)}
							/>
						</li>
					))
				)}
			</ul>
		</div>
	);
}
