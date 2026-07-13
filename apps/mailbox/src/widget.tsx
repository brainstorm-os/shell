/**
 * Mailbox dashboard widget. When Mailbox is launched as a dashboard widget
 * (`launch.reason === "widget"`), `main.tsx` mounts this instead of the full
 * app — the same bundle, in widget-mode. The one registered widget, `inbox`,
 * is a glance list of the newest messages, unread first; the shell strip above
 * draws the title / open / collapse / ⋯ chrome, and clicking a row opens that
 * message in the full Mailbox app via the shared `intent.open`.
 *
 * Mirrors the Contacts `list-contacts` / Journal `today-journal` widgets.
 * Reactive over the shell's live vault-entity index through `useVaultEntities`
 * (never the raw `onChange` — the sanctioned reactivity stack), narrowed
 * server-side to `Email/v1`.
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
import { useMailboxT } from "./i18n-hooks";
import { messageDateLabel } from "./logic/format";
import { getBrainstorm } from "./runtime";
import { EMAIL_TYPE_URL } from "./types/mail-view";
import {
	MAILBOX_WIDGET_INBOX,
	MAILBOX_WIDGET_QUERY,
	type WidgetEmailRow,
	shapeInbox,
} from "./widget-data";
import "./widget.css";

const OPEN_VERB = "open";

/** Open a message in the full Mailbox app through the shared open verb (cap
 *  `intents.dispatch:open`). Mirrors the Contacts widget's `openContact` —
 *  the wrapper narrows the strict `IntentsService.dispatch` param back to the
 *  SDK's loose `IntentDispatch` shape. */
function openMessage(entityId: string): void {
	const intents = getBrainstorm()?.services?.intents;
	if (!intents) return;
	void openEntity(
		{
			services: {
				intents: {
					dispatch: (intent) => intents.dispatch(intent as Parameters<typeof intents.dispatch>[0]),
				},
			},
		},
		{ entityId, entityType: EMAIL_TYPE_URL },
	);
}

/** Type-only `open` — no `entityId`, so the shell routes to the type's
 *  registered opener and launches the full Mailbox app (F-381). */
function openMailboxApp(): void {
	const intents = getBrainstorm()?.services?.intents;
	if (!intents) return;
	void intents.dispatch({ verb: OPEN_VERB, payload: { entityType: EMAIL_TYPE_URL } });
}

function InboxRow({ row, now }: { row: WidgetEmailRow; now: number }) {
	return (
		<li>
			<button type="button" className="mailbox-widget__row" onClick={() => openMessage(row.id)}>
				<span className="mailbox-widget__line">
					{row.unread ? (
						<span className="mailbox-widget__dot" role="img" aria-label={t("list.unreadDot")} />
					) : null}
					<span className="mailbox-widget__sender">{row.sender}</span>
					<span className="mailbox-widget__time">{messageDateLabel(row.receivedAt, now)}</span>
				</span>
				<span
					className={
						row.unread
							? "mailbox-widget__subject"
							: "mailbox-widget__subject mailbox-widget__subject--read"
					}
				>
					{row.subject}
				</span>
			</button>
		</li>
	);
}

function InboxList({
	rows,
	unread,
	total,
}: {
	rows: WidgetEmailRow[];
	unread: number;
	total: number;
}) {
	const now = Date.now();
	return (
		<div className="mailbox-widget">
			<div className="mailbox-widget__toolbar">
				<span className="mailbox-widget__label">{t("widget.title")}</span>
				<span className="mailbox-widget__count">
					{unread > 0
						? plural(unread, "widget.unread.one", "widget.unread.other", { count: unread })
						: plural(total, "widget.messages.one", "widget.messages.other", { count: total })}
				</span>
			</div>
			<ul className="mailbox-widget__list">
				{rows.map((row) => (
					<InboxRow key={row.id} row={row} now={now} />
				))}
			</ul>
		</div>
	);
}

export function MailboxWidget({ launch }: { launch: WidgetLaunch }) {
	useMailboxT();
	const runtime = getBrainstorm();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const { entities } = useVaultEntities(runtime?.services?.vaultEntities ?? null, {
		query: MAILBOX_WIDGET_QUERY,
	});

	const { rows, unread, total } = useMemo(() => shapeInbox(entities), [entities]);

	return (
		<WidgetRoot
			widgets={[
				{
					id: MAILBOX_WIDGET_INBOX,
					render: () =>
						total === 0 ? (
							<WidgetEmpty
								message={t("widget.empty")}
								actionLabel={t("widget.open")}
								onAction={openMailboxApp}
							/>
						) : (
							<InboxList rows={rows} unread={unread} total={total} />
						),
				},
			]}
			launch={launch}
		/>
	);
}
