/**
 * Runs view (11b.13) + the Agent-12c trace drill-in. Each `WorkflowRun/v1`
 * row expands to its step log AND the shell-written agent trace (step → tool
 * → outcome → duration), joined by `workflowRunId` over the app's OWN trace
 * runs (no capability — OQ-AO-2's own-runs read).
 *
 * Denial posture (OQ-AO-4, resolved passive): a capability-refused run shows
 * a denial badge on the row and names the missing capability in the detail —
 * never a toast (an automation denying in a loop would storm, and its user
 * is not present at the moment of refusal).
 *
 * Accessibility (workflow standard):
 *   - Keyboard: the expand control is a native `<button>` with
 *     `aria-expanded`; nothing binds raw keys.
 *   - Screen reader: the denial badge carries a pluralized `aria-label`; the
 *     trace renders as a labelled list.
 *   - Discoverability: the badge sits on the collapsed row, so a denied run
 *     is visibly denied before any interaction.
 */

import {
	AgentEventKind,
	type AgentRunSummary,
	type AgentTraceEventRecord,
	workflowRunDeniedCapabilities,
} from "@brainstorm-os/sdk-types";
import { formatRelativeDate } from "@brainstorm-os/sdk/date-formatters";
import { EmptyState, EmptyStateTone } from "@brainstorm-os/sdk/empty-state";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { type ReactElement, useEffect, useState } from "react";
import { type AutomationsI18nKey, plural, t } from "../i18n";
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

/** Fetch one run's trace events, or null when no trace exists / the shell
 *  offers no trace service (older shell, preview drop). */
export type LoadTraceEvents = (
	workflowRunId: string,
) => Promise<readonly AgentTraceEventRecord[] | null>;

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

/** One trace event: tool → outcome → duration; a denial names the missing
 *  capability (the row this track exists for). Everything renders as text. */
function TraceEventRow({ event }: { event: AgentTraceEventRecord }): ReactElement {
	const denied = event.kind === AgentEventKind.ToolDenied;
	return (
		<li className={denied ? "au-trace__event au-trace__event--denied" : "au-trace__event"}>
			{denied ? <Icon name={IconName.Lock} size={12} /> : null}
			<span className="au-trace__tool">{event.tool}</span>
			<span className={`au-pill au-pill--trace-${event.outcome}`}>
				{t(`runs.trace.outcome.${event.outcome}` as AutomationsI18nKey)}
			</span>
			{denied ? (
				<span className="au-trace__capability">
					{event.capability
						? t("runs.trace.denied", { capability: event.capability })
						: t("runs.trace.deniedUnknown")}
				</span>
			) : null}
			{event.durationMs > 0 ? (
				<span className="au-step__dur">
					{t("runs.trace.durationMs", { ms: String(Math.round(event.durationMs)) })}
				</span>
			) : null}
		</li>
	);
}

enum TraceState {
	Idle = "idle",
	Loading = "loading",
	Loaded = "loaded",
	None = "none",
}

type TraceFetch =
	| { state: TraceState.Idle }
	| { state: TraceState.Loading }
	| { state: TraceState.None }
	| { state: TraceState.Loaded; events: readonly AgentTraceEventRecord[] };

/** The shell-written trace for one run, fetched on first expand. */
function TraceSection({
	workflowRunId,
	load,
}: { workflowRunId: string; load: LoadTraceEvents }): ReactElement | null {
	const [fetch, setFetch] = useState<TraceFetch>({ state: TraceState.Idle });

	useEffect(() => {
		let live = true;
		setFetch({ state: TraceState.Loading });
		load(workflowRunId)
			.then((events) => {
				if (!live) return;
				if (events && events.length > 0) setFetch({ state: TraceState.Loaded, events });
				else setFetch({ state: TraceState.None });
			})
			.catch(() => {
				if (live) setFetch({ state: TraceState.None });
			});
		return () => {
			live = false;
		};
	}, [workflowRunId, load]);

	if (fetch.state === TraceState.Idle) return null;
	return (
		<section className="au-trace" aria-label={t("runs.trace.title")}>
			<h3 className="au-trace__title">{t("runs.trace.title")}</h3>
			{fetch.state === TraceState.Loading ? (
				<p className="au-empty">{t("runs.trace.loading")}</p>
			) : fetch.state === TraceState.None ? (
				<p className="au-empty">{t("runs.trace.empty")}</p>
			) : (
				<ol className="au-trace__events">
					{fetch.events.map((event) => (
						<TraceEventRow key={`${event.runId}:${event.seq}`} event={event} />
					))}
				</ol>
			)}
		</section>
	);
}

/** The denied capabilities for a run, from the decoded view or (defensively)
 *  re-parsed off a raw `capability-denied:` error — the surface never shows
 *  that raw string, whichever path built the view. */
function deniedCapsFor(run: RunView): string[] | null {
	if (run.deniedCapabilities && run.deniedCapabilities.length > 0) return run.deniedCapabilities;
	const parsed = workflowRunDeniedCapabilities(run.error);
	return parsed && parsed.length > 0 ? parsed : null;
}

function RunDetail({
	run,
	loadTraceEvents,
}: { run: RunView; loadTraceEvents?: LoadTraceEvents | undefined }): ReactElement {
	const deniedCaps = deniedCapsFor(run);
	return (
		<div className="au-run__detail">
			{deniedCaps ? (
				<div className="au-run__denied" data-testid="run-denied-caps">
					<p className="au-run__denied-title">
						<Icon name={IconName.Lock} size={12} />
						{t("runs.denied.title")}
					</p>
					<ul className="au-run__denied-caps">
						{deniedCaps.map((capability) => (
							<li key={capability}>
								<code className="au-run__denied-cap">{capability}</code>
							</li>
						))}
					</ul>
					<p className="au-run__denied-hint">{t("runs.denied.hint")}</p>
				</div>
			) : run.error ? (
				<p className="au-run__error">{`${t("runs.error")}: ${run.error}`}</p>
			) : null}
			{run.steps.length === 0 ? (
				<p className="au-empty">{t("runs.noSteps")}</p>
			) : (
				<ol className="au-steps">
					{run.steps.map((step, index) => (
						<StepRow key={`${step.stepId}:${index}`} step={step} />
					))}
				</ol>
			)}
			{loadTraceEvents ? <TraceSection workflowRunId={run.id} load={loadTraceEvents} /> : null}
		</div>
	);
}

function RunRow({
	run,
	now,
	trace,
	loadTraceEvents,
}: {
	run: RunView;
	now: number;
	trace: AgentRunSummary | undefined;
	loadTraceEvents?: LoadTraceEvents | undefined;
}): ReactElement {
	const [expanded, setExpanded] = useState(false);
	const denials = Math.max(trace?.denialCount ?? 0, deniedCapsFor(run)?.length ?? 0);
	return (
		<li className="au-run" data-denied={denials > 0 || undefined}>
			<div className="au-run__head">
				<span className="au-row__name">{run.workflowName}</span>
				<span className={`au-pill au-pill--${run.status}`}>{statusLabel(run.status)}</span>
				{denials > 0 ? (
					<span
						className="au-run__denial-badge"
						data-testid="run-denial-badge"
						aria-label={plural(denials, "runs.denialBadge.one", "runs.denialBadge.other", {
							count: String(denials),
						})}
					>
						<Icon name={IconName.Lock} size={11} />
						{denials}
					</span>
				) : null}
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
			{expanded ? <RunDetail run={run} loadTraceEvents={loadTraceEvents} /> : null}
		</li>
	);
}

export function RunsView({
	runs,
	now,
	traceByRunId,
	loadTraceEvents,
}: {
	runs: RunView[];
	now: () => number;
	/** Agent-12c — trace run summaries keyed by `WorkflowRun/v1` entity id
	 *  (the passive row badge reads `denialCount` without a per-row fetch). */
	traceByRunId?: ReadonlyMap<string, AgentRunSummary>;
	loadTraceEvents?: LoadTraceEvents;
}): ReactElement {
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
				<RunRow
					key={run.id}
					run={run}
					now={at}
					trace={traceByRunId?.get(run.id)}
					loadTraceEvents={loadTraceEvents}
				/>
			))}
		</ul>
	);
}
