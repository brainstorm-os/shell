import { formatRelativeDate } from "@brainstorm-os/sdk/date-formatters";
import { EmptyState, EmptyStateTone } from "@brainstorm-os/sdk/empty-state";
import { IconName } from "@brainstorm-os/sdk/icon";
import { type ReactElement, useState } from "react";
import { type AutomationsI18nKey, t } from "../i18n";
import type { RunStep, RunView } from "../logic/run-view";

// Run + step statuses share the `runs.status.*` catalog (step statuses are a
// subset). An unrecognised status (a malformed persisted row) falls back to
// its raw value rather than a missing-key blank.
const STATUS_KEYS = new Set<string>([
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"timed-out",
	"skipped",
]);

function statusLabel(status: string): string {
	return STATUS_KEYS.has(status) ? t(`runs.status.${status}` as AutomationsI18nKey) : status;
}

const REL_LABELS = {
	today: t("date.today"),
	tomorrow: t("date.tomorrow"),
	yesterday: t("date.yesterday"),
};

function formatDateTime(ms: number, now: number): string {
	if (!Number.isFinite(ms) || ms === 0) return "";
	const day = formatRelativeDate(ms, now, REL_LABELS);
	const time = new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `${day} ${time}`;
}

function StepRow({ step }: { step: RunStep }): ReactElement {
	return (
		<li className="au-step" style={{ "--au-step-depth": String(step.depth) } as React.CSSProperties}>
			<span className="au-step__kind">{step.kind || step.stepId}</span>
			<span className={`au-pill au-pill--${step.status}`}>{statusLabel(step.status)}</span>
			{step.durationMs !== undefined ? (
				<span className="au-step__dur">{`${Math.round(step.durationMs)}ms`}</span>
			) : null}
		</li>
	);
}

function RunDetail({ run }: { run: RunView }): ReactElement {
	return (
		<div className="au-run__detail">
			{run.error ? <p className="au-run__error">{`${t("runs.error")}: ${run.error}`}</p> : null}
			{run.steps.length === 0 ? (
				<p className="au-empty">{t("runs.noSteps")}</p>
			) : (
				<ol className="au-steps">
					{run.steps.map((step, index) => (
						<StepRow key={`${step.stepId}:${index}`} step={step} />
					))}
				</ol>
			)}
		</div>
	);
}

function RunRow({ run, now }: { run: RunView; now: number }): ReactElement {
	const [expanded, setExpanded] = useState(false);
	return (
		<li className="au-run">
			<div className="au-run__head">
				<span className="au-row__name">{run.workflowName}</span>
				<span className={`au-pill au-pill--${run.status}`}>{statusLabel(run.status)}</span>
				<span className="au-row__meta">{formatDateTime(run.triggeredAtMs, now)}</span>
				<button
					type="button"
					className="bs-btn bs-btn--ghost"
					aria-expanded={expanded}
					onClick={() => setExpanded((v) => !v)}
				>
					{expanded ? t("runs.collapse") : t("runs.inspect")}
				</button>
			</div>
			{expanded ? <RunDetail run={run} /> : null}
		</li>
	);
}

export function RunsView({ runs, now }: { runs: RunView[]; now: () => number }): ReactElement {
	if (runs.length === 0) {
		return (
			<EmptyState
				tone={EmptyStateTone.Compact}
				icon={IconName.Update}
				title={t("runs.empty")}
				hint={t("runs.comingSoon")}
			/>
		);
	}
	const at = now();
	return (
		<ul className="au-runs">
			{runs.map((run) => (
				<RunRow key={run.id} run={run} now={at} />
			))}
		</ul>
	);
}
