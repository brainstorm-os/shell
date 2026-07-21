/**
 * Chat dashboard widget. When Chat is launched as a dashboard widget
 * (`launch.reason === "widget"`), `main.tsx` mounts this instead of the full
 * app — the same bundle, in widget-mode. The one registered widget,
 * `recent-messages`, is a glance list of the newest chat messages across
 * every channel; the shell strip above draws the title / open / collapse / ⋯
 * chrome, and clicking a row opens that channel in the full Chat app via the
 * shared `intent.open` (channels hold the registered opener, not messages).
 *
 * Mirrors the Contacts `list-contacts` widget. Reactive over the shell's live
 * vault-entity index through `useVaultEntities` (never the raw `onChange` —
 * the sanctioned reactivity stack), narrowed to messages + channels via the
 * stable `CHAT_WIDGET_QUERY`.
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { openEntity } from "@brainstorm-os/sdk";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm-os/sdk/widget";
import { useMemo } from "react";
import { plural, t } from "./i18n";
import { useChatT } from "./i18n-hooks";
import { CHANNEL_TYPE } from "./logic/chat";
import { getBrainstorm } from "./runtime";
import {
	CHAT_WIDGET_QUERY,
	CHAT_WIDGET_RECENT,
	type WidgetMessageRow,
	shapeRecentMessages,
} from "./widget-data";
import "./widget.css";

/** Open a channel in the full Chat app through the shared open verb (cap
 *  `intents.dispatch:open`). Mirrors the Contacts widget's `openContact`. */
function openChannel(channelId: string): void {
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
		{ entityId: channelId, entityType: CHANNEL_TYPE },
	);
}

/** Empty-state CTA: an entityType-only `open` routes to the channel opener's
 *  owning app — i.e. launches Chat itself (the F-381 pattern). */
function openChatApp(): void {
	const intents = getBrainstorm()?.services?.intents;
	if (!intents) return;
	void intents.dispatch({ verb: "open", payload: { entityType: CHANNEL_TYPE } });
}

function RecentMessages({
	rows,
	channelCount,
}: { rows: WidgetMessageRow[]; channelCount: number }) {
	if (rows.length === 0) {
		return (
			<WidgetEmpty
				message={t("widget.empty")}
				actionLabel={t("widget.openChat")}
				onAction={openChatApp}
			/>
		);
	}
	return (
		<div className="chat-widget">
			<div className="chat-widget__toolbar">
				<span className="chat-widget__label">{t("widget.label")}</span>
				<span className="chat-widget__count">
					{plural(channelCount, "widget.channels.one", "widget.channels.other")}
				</span>
			</div>
			<ul className="chat-widget__list">
				{rows.map((row) => (
					<li key={row.id}>
						<button type="button" className="chat-widget__row" onClick={() => openChannel(row.channelId)}>
							<span className="chat-widget__meta">
								<span className="chat-widget__sender">{row.sender}</span>
								<span className="chat-widget__channel">#{row.channelName}</span>
							</span>
							<span className="chat-widget__snippet">{row.snippet}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

export function ChatWidget({ launch }: { launch: WidgetLaunch }) {
	useChatT();
	const runtime = getBrainstorm();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const { entities } = useVaultEntities(runtime?.services?.vaultEntities ?? null, {
		query: CHAT_WIDGET_QUERY,
	});

	const { rows, channelCount } = useMemo(() => shapeRecentMessages(entities), [entities]);

	return (
		<WidgetRoot
			widgets={[
				{
					id: CHAT_WIDGET_RECENT,
					render: () => <RecentMessages rows={rows} channelCount={channelCount} />,
				},
			]}
			launch={launch}
		/>
	);
}
