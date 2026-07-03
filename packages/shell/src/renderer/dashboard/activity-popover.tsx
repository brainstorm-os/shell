/**
 * Background-activity popover — one row per live operation: icon + title, a
 * progress bar (determinate when a percent is known, indeterminate otherwise),
 * and either the percent or, for a failed op, its error detail. Opened from the
 * activity chip. Uses the shared `<Popover>` primitive (no bespoke chrome).
 */

import type { BackgroundOperation } from "../../activity-types";
import { ActivityPhase } from "../../activity-types";
import { t } from "../i18n/t";
import { Icon } from "../ui/icon";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { iconForActivityKind, titleKeyForActivityKind } from "./activity-format";

export type ActivityPopoverProps = {
	operations: readonly BackgroundOperation[];
	onClose: () => void;
};

export function ActivityPopover({ operations, onClose }: ActivityPopoverProps) {
	return (
		<Popover
			title={t("shell.dashboard.activity.title")}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			onClose={onClose}
			testId="activity-popover"
		>
			<ul className="activity-popover__list" data-testid="activity-popover-list">
				{operations.map((op) => (
					<ActivityRow key={op.id} op={op} />
				))}
			</ul>
		</Popover>
	);
}

function ActivityRow({ op }: { op: BackgroundOperation }) {
	const isError = op.phase === ActivityPhase.Error;
	const title = t(titleKeyForActivityKind(op.kind));
	return (
		<li className="activity-popover__row" data-phase={op.phase} data-testid="activity-popover-row">
			<span className="activity-popover__head">
				<span className="activity-popover__icon" aria-hidden="true">
					<Icon name={iconForActivityKind(op.kind)} size={15} />
				</span>
				<span className="activity-popover__title">{title}</span>
				<span className="activity-popover__status">
					{isError
						? t("shell.dashboard.activity.failed")
						: op.percent !== null
							? t("shell.dashboard.activity.percent", { percent: op.percent })
							: t("shell.dashboard.activity.working")}
				</span>
			</span>
			{isError ? (
				op.detail && <p className="activity-popover__detail">{op.detail}</p>
			) : (
				// Decorative — the percent/"Working…" status text above carries the
				// value for assistive tech. Indeterminate (null percent) → full-width
				// via the data-phase rule; a known percent drives the width.
				<div
					className="activity-popover__bar"
					data-indeterminate={op.percent === null}
					aria-hidden="true"
				>
					<span
						className="activity-popover__bar-fill"
						style={op.percent !== null ? { width: `${op.percent}%` } : undefined}
					/>
				</div>
			)}
		</li>
	);
}
