/**
 * Agenda view (React) — a flat list grouped by relative bucket (Today /
 * Tomorrow / This week / Later), with per-day sub-headings inside each bucket.
 */

import { EmptyState } from "@brainstorm/sdk/empty-state";
import { IconName } from "@brainstorm/sdk/icon";
import { t } from "../../i18n/t";
import type { CompiledAgendaView } from "../../logic/compile-view";
import type { ScheduledItem } from "../../logic/scheduled-item";
import { formatGroupDateLabel } from "../format-date";
import { EventChip } from "./event-chip";
import type { ViewCallbacks } from "./view-callbacks";

export type AgendaViewProps = {
	compiled: CompiledAgendaView;
	now: number;
	callbacks: Pick<ViewCallbacks, "onItemClick" | "objectMenu">;
};

function groupByDay(items: readonly ScheduledItem[]): ScheduledItem[][] {
	const byDay = new Map<string, ScheduledItem[]>();
	for (const item of items) {
		const key = new Date(item.start).toDateString();
		const group = byDay.get(key);
		if (group) group.push(item);
		else byDay.set(key, [item]);
	}
	return [...byDay.values()];
}

export function AgendaView({ compiled, now, callbacks }: AgendaViewProps) {
	const { onItemClick, objectMenu } = callbacks;

	if (compiled.buckets.length === 0) {
		return (
			<section className="cal-agenda">
				<EmptyState
					icon={IconName.KindDate}
					title={t("calendar.agenda.empty.title")}
					hint={t("calendar.agenda.empty.body")}
				/>
			</section>
		);
	}

	return (
		<section className="cal-agenda">
			{compiled.buckets.map((bucket) => {
				const headingText = t(bucket.headingKey);
				return (
					<section key={bucket.key} className="cal-agenda__bucket" data-bucket={bucket.key}>
						<h2 className="cal-agenda__heading">{headingText}</h2>
						{groupByDay(bucket.items).map((items) => {
							const firstItem = items[0];
							if (!firstItem) return null;
							const dayLabel = formatGroupDateLabel(firstItem.start, now);
							return (
								<div key={firstItem.id}>
									{dayLabel !== headingText ? <h3 className="cal-agenda__day">{dayLabel}</h3> : null}
									<ul className="cal-agenda__list">
										{items.map((item) => (
											<li key={item.id} className="cal-agenda__row">
												<EventChip item={item} mode="row" onClick={onItemClick} objectMenu={objectMenu} />
											</li>
										))}
									</ul>
								</div>
							);
						})}
					</section>
				);
			})}
		</section>
	);
}
