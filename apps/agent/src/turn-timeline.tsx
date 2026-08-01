/**
 * Agent-12b — the per-turn "what I did" disclosure on an assistant bubble.
 *
 * An expandable list of the run's ordered events (searched / called / staged /
 * was denied), derived from the message's persisted `toolCalls`. It renders the
 * conversation's OWN run — no new read capability — and upgrades the transient
 * "used tool X" chips into a durable, honest account. Denials are named in
 * plain language ("couldn't call `open`: this conversation doesn't grant
 * `intents.dispatch:open`") and drive both a run-level denial badge and the
 * existing Agent-5 escalation prompt (via `onEscalate`).
 *
 * Accessibility (workflow standard):
 *   - Keyboard: the summary is a native `<button>` (Tab-reachable, Enter/Space
 *     toggles); each denial's "Grant" is a native `<button>`. No raw key handling.
 *   - Screen reader: the toggle carries `aria-expanded` + `aria-controls`; the
 *     panel is a labelled list; the denial badge has an `aria-label` count.
 *   - Discoverability: the summary line ("Did N things · M denied") is always
 *     visible on every assistant turn that acted, so the detail is a click away.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { type ReactElement, useId, useState } from "react";
import { plural, t } from "./i18n";
import {
	type TurnTimelineItem,
	TurnTimelineKind,
	timelineDenialCount,
} from "./logic/turn-timeline";

function iconFor(kind: TurnTimelineKind): IconName {
	switch (kind) {
		case TurnTimelineKind.ToolCall:
			return IconName.Sparkle;
		case TurnTimelineKind.ToolError:
			return IconName.Warning;
		case TurnTimelineKind.Denied:
			return IconName.Lock;
	}
}

function labelFor(item: TurnTimelineItem): string {
	switch (item.kind) {
		case TurnTimelineKind.ToolCall:
			return t("timeline.item.called", { tool: item.tool });
		case TurnTimelineKind.ToolError:
			return t("timeline.item.errored", { tool: item.tool });
		case TurnTimelineKind.Denied:
			return item.capability
				? t("timeline.item.denied", { tool: item.tool, capability: item.capability })
				: t("timeline.item.deniedUnknown", { tool: item.tool });
	}
}

export function TurnTimeline({
	items,
	onEscalate,
}: {
	items: readonly TurnTimelineItem[];
	/** Fired when the user presses "Grant" on a capability-denied row — wires
	 *  into the existing Agent-5 escalation prompt. */
	onEscalate?: (capability: string) => void;
}): ReactElement | null {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	if (items.length === 0) return null;

	const denials = timelineDenialCount(items);
	const summary = plural(items.length, "timeline.summary.one", "timeline.summary.other", {
		count: String(items.length),
	});

	return (
		<div className="agent__timeline" data-testid="agent-timeline">
			<button
				type="button"
				className="agent__timeline-toggle"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((v) => !v)}
			>
				<Icon name={open ? IconName.CaretDown : IconName.CaretRight} size={12} />
				<span className="agent__timeline-summary">{summary}</span>
				{denials > 0 ? (
					<span
						className="agent__timeline-badge"
						aria-label={plural(denials, "timeline.badge.one", "timeline.badge.other", {
							denied: String(denials),
						})}
					>
						<Icon name={IconName.Lock} size={11} />
						{denials}
					</span>
				) : null}
			</button>
			{open ? (
				<ul className="agent__timeline-list" id={panelId}>
					{items.map((item) => (
						<li key={item.key} className={`agent__timeline-item agent__timeline-item--${item.kind}`}>
							<Icon name={iconFor(item.kind)} size={12} />
							<span className="agent__timeline-label">{labelFor(item)}</span>
							{item.kind === TurnTimelineKind.Denied && item.capability && onEscalate ? (
								<button
									type="button"
									className="agent__timeline-grant"
									onClick={() => onEscalate(item.capability as string)}
								>
									{t("timeline.grant")}
								</button>
							) : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
