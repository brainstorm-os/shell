/**
 * Agent dashboard widget. When Agent is launched as a dashboard widget
 * (`launch.reason === "widget"`), `main.tsx` mounts this instead of the full
 * app — the same bundle, in widget-mode. The one registered widget,
 * `recent-conversations`, is a glance list of the newest-updated
 * conversations; the shell strip above draws the title / open / collapse / ⋯
 * chrome, and clicking a row opens that conversation in the full Agent app
 * via the shared `intent.open`.
 *
 * Mirrors the Contacts / Journal widgets. Reactive over the shell's live
 * vault-entity index through `useVaultEntities` (never the raw `onChange` —
 * the sanctioned reactivity stack), narrowed to `Conversation/v1`.
 */

import { useVaultEntities } from "@brainstorm/react-yjs";
import { type OpenCapableRuntime, openEntity } from "@brainstorm/sdk";
import { CONVERSATION_TYPE_URL } from "@brainstorm/sdk-types";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm/sdk/widget";
import { useMemo } from "react";
import { plural, t } from "./i18n";
import { getBrainstorm } from "./runtime";
import {
	AGENT_WIDGET_QUERY,
	AGENT_WIDGET_RECENT,
	type WidgetConversation,
	shapeConversations,
} from "./widget-data";
import "./widget.css";

const OPEN_VERB = "open";

/** Open a conversation in the full Agent app through the shared open verb
 *  (cap `intents.dispatch:open`). */
function openConversation(entityId: string): void {
	// `openEntity` accepts the loose `{ services: { intents } }` shape; the
	// app's stricter `IntentsService.dispatch` narrows `verb`, so the same
	// cast the full app uses bridges the two.
	void openEntity(getBrainstorm() as unknown as OpenCapableRuntime, {
		entityId,
		entityType: CONVERSATION_TYPE_URL,
	});
}

/** Type-only `open` — no `entityId`, so the shell routes to the type's
 *  registered opener and launches the Agent app (the empty-state CTA). */
function openAgentApp(): void {
	const intents = getBrainstorm()?.services?.intents;
	if (!intents) return;
	void intents.dispatch({ verb: OPEN_VERB, payload: { entityType: CONVERSATION_TYPE_URL } });
}

function ConversationsList({
	conversations,
	total,
}: {
	conversations: WidgetConversation[];
	total: number;
}) {
	if (conversations.length === 0) {
		return (
			<div className="agent-widget">
				<WidgetEmpty
					message={t("widget.empty")}
					actionLabel={t("widget.empty.action")}
					onAction={openAgentApp}
				/>
			</div>
		);
	}
	return (
		<div className="agent-widget">
			<div className="agent-widget__toolbar">
				<span className="agent-widget__label">{t("widget.label")}</span>
				<span className="agent-widget__count">
					{plural(total, "widget.count.one", "widget.count.other")}
				</span>
			</div>
			<ul className="agent-widget__list">
				{conversations.map((conversation) => (
					<li key={conversation.id}>
						<button
							type="button"
							className="agent-widget__row"
							onClick={() => openConversation(conversation.id)}
						>
							<span className="agent-widget__title">{conversation.title}</span>
							<span className="agent-widget__updated">{conversation.updated}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

export function AgentWidget({ launch }: { launch: WidgetLaunch }) {
	const runtime = getBrainstorm();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const { entities } = useVaultEntities(runtime?.services?.vaultEntities ?? null, {
		query: AGENT_WIDGET_QUERY,
	});

	const { conversations, total } = useMemo(
		() => shapeConversations(entities, Date.now()),
		[entities],
	);

	return (
		<WidgetRoot
			widgets={[
				{
					id: AGENT_WIDGET_RECENT,
					render: () => <ConversationsList conversations={conversations} total={total} />,
				},
			]}
			launch={launch}
		/>
	);
}
