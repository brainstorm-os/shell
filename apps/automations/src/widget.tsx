/**
 * Automations dashboard widget. When Automations is launched as a dashboard
 * widget (`launch.reason === "widget"`), `main.tsx` mounts this instead of the
 * full app — the same bundle, in widget-mode. The one registered widget,
 * `recent-runs`, is a glance list of the latest workflow runs (status chip +
 * trigger time); the shell strip above draws the title / open / collapse / ⋯
 * chrome, and clicking a row opens the run's workflow in the full Automations
 * app via the shared `intent.open`.
 *
 * Mirrors the Contacts `list-contacts` widget. Reactive over the shell's live
 * vault-entity index through `useVaultEntities` (never the raw `onChange` —
 * the sanctioned reactivity stack), narrowed to `WorkflowRun/v1` +
 * `Workflow/v1`.
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { openEntity } from "@brainstorm-os/sdk";
import { WORKFLOW_TYPE_URL } from "@brainstorm-os/sdk-types";
import { formatRelativeDate, formatTime } from "@brainstorm-os/sdk/date-formatters";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm-os/sdk/widget";
import { useMemo } from "react";
import { plural, t } from "./i18n";
import { useAutomationsT } from "./i18n-hooks";
import { getBrainstorm } from "./storage/runtime";
import {
	AUTOMATIONS_WIDGET_QUERY,
	AUTOMATIONS_WIDGET_RECENT_RUNS,
	type WidgetRun,
	runStatusLabelKey,
	shapeRuns,
} from "./widget-data";
import "./widget.css";

const OPEN_VERB = "open";

const REL_LABELS = {
	today: t("date.today"),
	tomorrow: t("date.tomorrow"),
	yesterday: t("date.yesterday"),
};

/** Short trigger-time label: a clock time for today's runs (a run list is
 *  mostly same-day, where "Today" ×8 says nothing), the shared relative date
 *  (Yesterday / short weekday / month-day) for older ones. */
function formatTriggeredAt(epochMs: number, now: number): string {
	if (new Date(epochMs).toDateString() === new Date(now).toDateString()) {
		return formatTime(epochMs);
	}
	return formatRelativeDate(epochMs, now, REL_LABELS, { weekdayStyle: "short" });
}

/** Open the run's workflow in the full Automations app through the shared
 *  open verb (cap `intents.dispatch:open`) — the workflow holds the
 *  registered opener; runs have none. */
function openWorkflow(workflowId: string): void {
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
		{ entityId: workflowId, entityType: WORKFLOW_TYPE_URL },
	);
}

/** Type-only `open` — no `entityId`, so the shell routes to the type's
 *  registered opener and launches the Automations app. */
function openAutomationsApp(): void {
	const intents = getBrainstorm()?.services?.intents;
	if (!intents) return;
	void intents.dispatch({ verb: OPEN_VERB, payload: { entityType: WORKFLOW_TYPE_URL } });
}

function RunRow({ run, now }: { run: WidgetRun; now: number }) {
	return (
		<li>
			<button
				type="button"
				className="automations-widget__row"
				onClick={() => openWorkflow(run.workflowId)}
			>
				<span className="automations-widget__row-top">
					{run.workflowName === null ? (
						<span className="automations-widget__name automations-widget__name--deleted">
							{t("widget.deletedWorkflow")}
						</span>
					) : (
						<span className="automations-widget__name">{run.workflowName}</span>
					)}
					<span className={`automations-widget__status automations-widget__status--${run.tone}`}>
						{t(runStatusLabelKey(run.status))}
					</span>
				</span>
				<span className="automations-widget__time">{formatTriggeredAt(run.triggeredAtMs, now)}</span>
			</button>
		</li>
	);
}

function RecentRuns({ runs, failedCount }: { runs: WidgetRun[]; failedCount: number }) {
	if (runs.length === 0) {
		return (
			<div className="automations-widget">
				<WidgetEmpty
					message={t("widget.empty")}
					actionLabel={t("widget.openApp")}
					onAction={openAutomationsApp}
				/>
			</div>
		);
	}
	const now = Date.now();
	return (
		<div className="automations-widget">
			<div className="automations-widget__toolbar">
				<span className="automations-widget__label">{t("app.title")}</span>
				{failedCount > 0 ? (
					<span className="automations-widget__count automations-widget__count--danger">
						{plural(failedCount, "widget.failedCount.one", "widget.failedCount.other")}
					</span>
				) : (
					<span className="automations-widget__count">
						{plural(runs.length, "widget.runCount.one", "widget.runCount.other")}
					</span>
				)}
			</div>
			<ul className="automations-widget__list">
				{runs.map((run) => (
					<RunRow key={run.id} run={run} now={now} />
				))}
			</ul>
		</div>
	);
}

export function AutomationsWidget({ launch }: { launch: WidgetLaunch }) {
	useAutomationsT();
	const runtime = getBrainstorm();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const { entities } = useVaultEntities(runtime?.services?.vaultEntities ?? null, {
		query: AUTOMATIONS_WIDGET_QUERY,
	});

	const { runs, failedCount } = useMemo(() => shapeRuns(entities), [entities]);

	return (
		<WidgetRoot
			widgets={[
				{
					id: AUTOMATIONS_WIDGET_RECENT_RUNS,
					render: () => <RecentRuns runs={runs} failedCount={failedCount} />,
				},
			]}
			launch={launch}
		/>
	);
}
