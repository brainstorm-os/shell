/**
 * Dashboard background-activity chip.
 *
 * Sits in the dashboard's right-hand action group next to the sync chip. It
 * appears ONLY while background work is in flight (a model download, a reindex,
 * …) — idle it renders nothing, so the chrome stays quiet. It shows a spinner,
 * the freshest operation's title (or "N tasks"), and its percent when known;
 * click opens `<ActivityPopover>` with a row + progress bar per operation.
 *
 * Pure-render like the sync chip: reads the hook, dispatches an open callback;
 * the dashboard owns the `AnimatePresence` mount of the popover.
 */

import { AnimatePresence } from "framer-motion";
import { useState } from "react";
import { ActivityPhase, type ActivitySnapshot } from "../../activity-types";
import { t } from "../i18n/t";
import { Icon, IconName } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import { titleKeyForActivityKind } from "./activity-format";
import { ActivityPopover } from "./activity-popover";
import { useBackgroundActivity } from "./use-background-activity";

export type ActivityChipProps = {
	/** Test hook — pins a snapshot instead of reading the live hook. */
	override?: ActivitySnapshot;
};

export function ActivityChip({ override }: ActivityChipProps = {}) {
	const live = useBackgroundActivity();
	const snapshot = override ?? live;
	const [open, setOpen] = useState(false);

	const operations = snapshot.operations;
	if (operations.length === 0) return null;

	const primary = operations[0];
	if (!primary) return null;
	const hasError = operations.some((op) => op.phase === ActivityPhase.Error);
	const multiple = operations.length > 1;

	// Single op → its title + percent; multiple → a count. An error anywhere
	// swaps the spinner for a warning glyph so a stuck download reads at a glance.
	const label = multiple
		? t("shell.dashboard.activity.summary", { count: operations.length })
		: t(titleKeyForActivityKind(primary.kind));

	return (
		<>
			<button
				type="button"
				className={`activity-chip${hasError ? " activity-chip--error" : ""}`}
				onClick={() => setOpen(true)}
				aria-label={t("shell.dashboard.activity.chipLabel")}
				data-testid="activity-chip"
			>
				{/* Spinner reads as "working" for any running op (single or many); the
				    kind icon lives on the popover rows. An error swaps to a warning. */}
				{hasError ? <Icon name={IconName.Warning} size={16} /> : <Spinner size={14} decorative />}
				<span className="activity-chip__label" aria-live="polite" data-testid="activity-chip-label">
					{label}
				</span>
				{!multiple && primary.percent !== null && primary.phase === ActivityPhase.Running && (
					<span className="activity-chip__percent">
						{t("shell.dashboard.activity.percent", { percent: primary.percent })}
					</span>
				)}
			</button>
			<AnimatePresence>
				{open && (
					<ActivityPopover
						key="activity-popover"
						operations={operations}
						onClose={() => setOpen(false)}
					/>
				)}
			</AnimatePresence>
		</>
	);
}
