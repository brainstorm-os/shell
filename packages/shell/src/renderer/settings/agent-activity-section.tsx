/**
 * Settings → AI → Agent activity (Agent-12d — doc 77 §Surfaces #3). The
 * vault-wide "what did agents do" query surface: runs filtered by surface /
 * app / date / outcome, with DENIALS-ONLY as a first-class toggle (the whole
 * point of the track — fail-closed stays debuggable only if denials are one
 * glance away, never buried in a dropdown). Click-through opens the entity /
 * conversation / workflow run via the privileged intent dispatch; per-entity
 * agent history rides the `target_entity_id` query.
 *
 * Data path: `window.brainstorm.agentActivity` → direct ipcMain (OQ-AO-2,
 * shell-surfaces-only — no app capability exists for this). Every reply is a
 * bounded, metadata-only projection; page sizes are clamped main-side.
 * Every string that could have originated in model output or an MCP server
 * (tool names, details) was sanitized at write time AND renders here as
 * React text — never markup.
 *
 * Accessibility (workflow standard):
 *   - Keyboard: filters are the shared `SettingSelect` (fancy-menus keyboard
 *     model); the denials toggle and every row expander are native buttons
 *     with `aria-pressed` / `aria-expanded`. No raw key handling.
 *   - Screen reader: the denial badge carries a pluralized ICU label; the
 *     run list is a labelled `<ul>`; expanders name their panels via
 *     `aria-controls`.
 *   - Discoverability: the section sits beside the AI usage panel in
 *     Settings → AI, always rendered — an empty vault shows the shared
 *     `<EmptyState>` explaining what will appear.
 */

import {
	AgentEventKind,
	AgentRunOutcome,
	AgentRunSurface,
	isAgentEventKind,
	isAgentRunOutcome,
	isAgentRunSurface,
} from "@brainstorm-os/sdk-types";
import { EmptyState, EmptyStateTone } from "@brainstorm-os/sdk/empty-state";
import { IconName as SdkIconName } from "@brainstorm-os/sdk/icon";
import { useCallback, useEffect, useId, useState } from "react";
import type { AgentActivityEventView, AgentActivityRunView } from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Icon, IconName } from "../ui/icon";
import { SettingSelect } from "./settings-controls";
import "@brainstorm-os/sdk/empty-state.css";
import "./agent-activity-section.css";

const PAGE_SIZE = 25;

/** Filter sentinel: "no constraint on this dimension". */
const ALL = "all";

enum ActivityRange {
	All = "all",
	Day = "day",
	Week = "week",
	Month = "month",
}

const RANGE_MS: Record<ActivityRange, number | null> = {
	[ActivityRange.All]: null,
	[ActivityRange.Day]: 24 * 60 * 60 * 1000,
	[ActivityRange.Week]: 7 * 24 * 60 * 60 * 1000,
	[ActivityRange.Month]: 30 * 24 * 60 * 60 * 1000,
};

const SURFACE_KEY: Record<AgentRunSurface, string> = {
	[AgentRunSurface.Chat]: "shell.settings.ai.activity.surfaceChat",
	[AgentRunSurface.Automation]: "shell.settings.ai.activity.surfaceAutomation",
};

const OUTCOME_KEY: Record<AgentRunOutcome, string> = {
	[AgentRunOutcome.Ok]: "shell.settings.ai.activity.outcomeOk",
	[AgentRunOutcome.Error]: "shell.settings.ai.activity.outcomeError",
	[AgentRunOutcome.Refused]: "shell.settings.ai.activity.outcomeRefused",
	[AgentRunOutcome.Budget]: "shell.settings.ai.activity.outcomeBudget",
	[AgentRunOutcome.Aborted]: "shell.settings.ai.activity.outcomeAborted",
};

const KIND_KEY: Record<AgentEventKind, string> = {
	[AgentEventKind.Retrieval]: "shell.settings.ai.activity.kindRetrieval",
	[AgentEventKind.ToolCall]: "shell.settings.ai.activity.kindToolCall",
	[AgentEventKind.ToolDenied]: "shell.settings.ai.activity.kindToolDenied",
	[AgentEventKind.ProposalStaged]: "shell.settings.ai.activity.kindProposalStaged",
	[AgentEventKind.ProposalApproved]: "shell.settings.ai.activity.kindProposalApproved",
	[AgentEventKind.ProposalDiscarded]: "shell.settings.ai.activity.kindProposalDiscarded",
	[AgentEventKind.McpCall]: "shell.settings.ai.activity.kindMcpCall",
	[AgentEventKind.Error]: "shell.settings.ai.activity.kindError",
};

function surfaceLabel(surface: string): string {
	return isAgentRunSurface(surface) ? t(SURFACE_KEY[surface]) : surface;
}

function outcomeLabel(outcome: string | null): string {
	if (outcome === null) return t("shell.settings.ai.activity.running");
	return isAgentRunOutcome(outcome) ? t(OUTCOME_KEY[outcome]) : outcome;
}

function kindLabel(kind: string): string {
	return isAgentEventKind(kind) ? t(KIND_KEY[kind]) : kind;
}

function formatTs(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Guarded bridge accessor — a version-skewed preload (dev HMR) degrades to
 *  an inert surface, never a crash (the AiPanel posture). */
function activityBridge(): typeof window.brainstorm.agentActivity | null {
	const bridge = window.brainstorm?.agentActivity;
	return bridge && typeof bridge.runs === "function" ? bridge : null;
}

function openEntity(entityId: string): void {
	void window.brainstorm.intents.dispatch({ verb: "open", payload: { entityId } });
}

/** One trace event row: what happened → to what → how long. All text. */
function EventRow({
	event,
	onEntityHistory,
}: { event: AgentActivityEventView; onEntityHistory: (entityId: string) => void }) {
	const denied = event.kind === (AgentEventKind.ToolDenied as string);
	return (
		<li
			className={
				denied
					? "settings__activity-event settings__activity-event--denied"
					: "settings__activity-event"
			}
		>
			<span className="settings__activity-event-kind">
				{denied ? <Icon name={IconName.Lock} size={11} /> : null}
				{kindLabel(event.kind)}
			</span>
			{event.tool ? <code className="settings__activity-event-tool">{event.tool}</code> : null}
			{denied ? (
				<span className="settings__activity-event-capability">
					{event.capability
						? t("shell.settings.ai.activity.eventDenied", { capability: event.capability })
						: t("shell.settings.ai.activity.eventDeniedUnknown")}
				</span>
			) : null}
			{event.targetEntityId ? (
				<button
					type="button"
					className="settings__activity-entity"
					title={t("shell.settings.ai.activity.entityHistory")}
					onClick={() => onEntityHistory(event.targetEntityId as string)}
				>
					{event.targetEntityId}
				</button>
			) : null}
			{event.durationMs > 0 ? (
				<span className="settings__activity-event-duration">
					{t("shell.settings.ai.activity.durationMs", { ms: String(Math.round(event.durationMs)) })}
				</span>
			) : null}
		</li>
	);
}

/** One run row: agent · surface · outcome · denial badge · time, expanding
 *  to its ordered events + click-through. */
function RunRow({
	run,
	onEntityHistory,
}: { run: AgentActivityRunView; onEntityHistory: (entityId: string) => void }) {
	const [expanded, setExpanded] = useState(false);
	const [events, setEvents] = useState<readonly AgentActivityEventView[] | null>(null);
	const panelId = useId();

	useEffect(() => {
		if (!expanded || events !== null) return undefined;
		const bridge = activityBridge();
		if (!bridge) return undefined;
		let live = true;
		void bridge
			.events(run.id)
			.then((reply) => live && setEvents(reply.events))
			.catch(() => live && setEvents([]));
		return () => {
			live = false;
		};
	}, [expanded, events, run.id]);

	return (
		<li className="settings__activity-run" data-denied={run.denialCount > 0 || undefined}>
			<button
				type="button"
				className="settings__activity-run-head"
				aria-expanded={expanded}
				aria-controls={panelId}
				aria-label={
					expanded
						? t("shell.settings.ai.activity.collapseRun")
						: t("shell.settings.ai.activity.expandRun")
				}
				onClick={() => setExpanded((v) => !v)}
			>
				<Icon name={expanded ? IconName.CaretUp : IconName.CaretDown} size={12} />
				<span className="settings__activity-run-agent">{run.agent}</span>
				<span className="settings__activity-run-surface">{surfaceLabel(run.surface)}</span>
				<span className="settings__activity-run-outcome" data-outcome={run.outcome ?? "running"}>
					{outcomeLabel(run.outcome)}
				</span>
				{run.denialCount > 0 ? (
					<span
						className="settings__activity-denial-badge"
						aria-label={t("shell.settings.ai.activity.denials", { count: run.denialCount })}
					>
						<Icon name={IconName.Lock} size={11} />
						{run.denialCount}
					</span>
				) : null}
				<span className="settings__activity-run-time">{formatTs(run.startedAt)}</span>
			</button>
			{expanded ? (
				<div className="settings__activity-run-detail" id={panelId}>
					{events === null ? null : events.length === 0 ? (
						<p className="settings__hint">{t("shell.settings.ai.activity.eventsEmpty")}</p>
					) : (
						<ul className="settings__activity-events">
							{events.map((event) => (
								<EventRow
									key={`${event.runId}:${event.seq}`}
									event={event}
									onEntityHistory={onEntityHistory}
								/>
							))}
						</ul>
					)}
					<div className="settings__activity-run-actions">
						{run.conversationId ? (
							<Button
								variant={ButtonVariant.Ghost}
								size={ButtonSize.Md}
								onClick={() => openEntity(run.conversationId as string)}
							>
								{t("shell.settings.ai.activity.openConversation")}
							</Button>
						) : null}
						{run.workflowRunId ? (
							<Button
								variant={ButtonVariant.Ghost}
								size={ButtonSize.Md}
								onClick={() => openEntity(run.workflowRunId as string)}
							>
								{t("shell.settings.ai.activity.openWorkflowRun")}
							</Button>
						) : null}
					</div>
				</div>
			) : null}
		</li>
	);
}

/** Per-entity agent history (the `target_entity_id` query + the
 *  `agentProvenance` back-link's read side). */
function EntityHistory({ entityId, onClear }: { entityId: string; onClear: () => void }) {
	const [events, setEvents] = useState<readonly AgentActivityEventView[] | null>(null);

	useEffect(() => {
		const bridge = activityBridge();
		if (!bridge || typeof bridge.entityHistory !== "function") {
			setEvents([]);
			return undefined;
		}
		let live = true;
		void bridge
			.entityHistory(entityId)
			.then((reply) => live && setEvents(reply.events))
			.catch(() => live && setEvents([]));
		return () => {
			live = false;
		};
	}, [entityId]);

	return (
		<div className="settings__activity-entity-history" data-testid="ai-activity-entity-history">
			<div className="settings__activity-entity-history-head">
				<span className="settings__activity-entity-history-title">
					{t("shell.settings.ai.activity.entityHistoryTitle", { entityId })}
				</span>
				<Button variant={ButtonVariant.Ghost} size={ButtonSize.Md} onClick={() => openEntity(entityId)}>
					{t("shell.settings.ai.activity.openEntity")}
				</Button>
				<Button variant={ButtonVariant.Ghost} size={ButtonSize.Md} onClick={onClear}>
					{t("shell.settings.ai.activity.entityHistoryClear")}
				</Button>
			</div>
			{events !== null && events.length === 0 ? (
				<p className="settings__hint">{t("shell.settings.ai.activity.eventsEmpty")}</p>
			) : events !== null ? (
				<ul className="settings__activity-events">
					{events.map((event) => (
						<EventRow key={`${event.runId}:${event.seq}`} event={event} onEntityHistory={() => {}} />
					))}
				</ul>
			) : null}
		</div>
	);
}

export function AgentActivitySection() {
	const [surface, setSurface] = useState<string>(ALL);
	const [agent, setAgent] = useState<string>(ALL);
	const [outcome, setOutcome] = useState<string>(ALL);
	const [range, setRange] = useState<string>(ActivityRange.All);
	const [denialsOnly, setDenialsOnly] = useState(false);
	const [agents, setAgents] = useState<readonly string[]>([]);
	const [runs, setRuns] = useState<readonly AgentActivityRunView[] | null>(null);
	const [pageFull, setPageFull] = useState(false);
	const [entityFilter, setEntityFilter] = useState<string | null>(null);

	const query = useCallback(
		(beforeStartedAt?: number) => {
			const rangeMs = RANGE_MS[range as ActivityRange] ?? null;
			return {
				...(surface !== ALL ? { surface } : {}),
				...(agent !== ALL ? { agent } : {}),
				...(outcome !== ALL ? { outcome } : {}),
				...(rangeMs !== null ? { sinceTs: Date.now() - rangeMs } : {}),
				...(denialsOnly ? { denialsOnly: true } : {}),
				...(beforeStartedAt !== undefined ? { beforeStartedAt } : {}),
				limit: PAGE_SIZE,
			};
		},
		[surface, agent, outcome, range, denialsOnly],
	);

	useEffect(() => {
		const bridge = activityBridge();
		if (!bridge) return undefined;
		let live = true;
		void bridge
			.runs(query())
			.then((reply) => {
				if (!live) return;
				setRuns(reply.runs);
				setPageFull(reply.runs.length >= PAGE_SIZE);
			})
			.catch(() => live && setRuns([]));
		return () => {
			live = false;
		};
	}, [query]);

	useEffect(() => {
		const bridge = activityBridge();
		if (!bridge || typeof bridge.agents !== "function") return undefined;
		let live = true;
		void bridge
			.agents()
			.then((reply) => live && setAgents(reply.agents))
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);

	const loadMore = useCallback(() => {
		const bridge = activityBridge();
		const last = runs?.[runs.length - 1];
		if (!bridge || !last) return;
		void bridge
			.runs(query(last.startedAt))
			.then((reply) => {
				setRuns((prev) => [...(prev ?? []), ...reply.runs]);
				setPageFull(reply.runs.length >= PAGE_SIZE);
			})
			.catch(() => undefined);
	}, [runs, query]);

	const surfaceOptions = [
		{ value: ALL, label: t("shell.settings.ai.activity.surfaceAll") },
		{ value: AgentRunSurface.Chat as string, label: t(SURFACE_KEY[AgentRunSurface.Chat]) },
		{
			value: AgentRunSurface.Automation as string,
			label: t(SURFACE_KEY[AgentRunSurface.Automation]),
		},
	];
	const agentOptions = [
		{ value: ALL, label: t("shell.settings.ai.activity.appAll") },
		...agents.map((id) => ({ value: id, label: id })),
	];
	const outcomeOptions = [
		{ value: ALL, label: t("shell.settings.ai.activity.outcomeAll") },
		...Object.values(AgentRunOutcome).map((value) => ({ value, label: t(OUTCOME_KEY[value]) })),
	];
	const rangeOptions = [
		{ value: ActivityRange.All as string, label: t("shell.settings.ai.activity.rangeAll") },
		{ value: ActivityRange.Day as string, label: t("shell.settings.ai.activity.rangeDay") },
		{ value: ActivityRange.Week as string, label: t("shell.settings.ai.activity.rangeWeek") },
		{ value: ActivityRange.Month as string, label: t("shell.settings.ai.activity.rangeMonth") },
	];

	return (
		<div className="settings__field" data-testid="ai-activity">
			<div className="settings__field-head">
				<span className="settings__field-label">{t("shell.settings.ai.activity.title")}</span>
			</div>
			<p className="settings__hint">{t("shell.settings.ai.activity.intro")}</p>
			<div className="settings__activity-filters">
				<button
					type="button"
					className="settings__activity-toggle"
					aria-pressed={denialsOnly}
					data-testid="ai-activity-denials-only"
					onClick={() => setDenialsOnly((v) => !v)}
				>
					<Icon name={IconName.Lock} size={12} />
					{t("shell.settings.ai.activity.denialsOnly")}
				</button>
				<SettingSelect
					value={surface}
					options={surfaceOptions}
					onChange={setSurface}
					ariaLabel={t("shell.settings.ai.activity.filterSurface")}
				/>
				<SettingSelect
					value={agent}
					options={agentOptions}
					onChange={setAgent}
					ariaLabel={t("shell.settings.ai.activity.filterApp")}
				/>
				<SettingSelect
					value={outcome}
					options={outcomeOptions}
					onChange={setOutcome}
					ariaLabel={t("shell.settings.ai.activity.filterOutcome")}
				/>
				<SettingSelect
					value={range}
					options={rangeOptions}
					onChange={setRange}
					ariaLabel={t("shell.settings.ai.activity.filterRange")}
				/>
			</div>
			{entityFilter !== null ? (
				<EntityHistory entityId={entityFilter} onClear={() => setEntityFilter(null)} />
			) : runs !== null && runs.length === 0 ? (
				<EmptyState
					tone={EmptyStateTone.Compact}
					icon={denialsOnly ? SdkIconName.Lock : SdkIconName.Sparkle}
					title={
						denialsOnly
							? t("shell.settings.ai.activity.emptyDenialsTitle")
							: t("shell.settings.ai.activity.emptyTitle")
					}
					hint={
						denialsOnly
							? t("shell.settings.ai.activity.emptyDenialsHint")
							: t("shell.settings.ai.activity.emptyHint")
					}
				/>
			) : (
				<>
					<ul className="settings__activity-runs" aria-label={t("shell.settings.ai.activity.title")}>
						{(runs ?? []).map((run) => (
							<RunRow key={run.id} run={run} onEntityHistory={setEntityFilter} />
						))}
					</ul>
					{pageFull ? (
						<Button variant={ButtonVariant.Ghost} size={ButtonSize.Md} onClick={loadMore}>
							{t("shell.settings.ai.activity.loadMore")}
						</Button>
					) : null}
				</>
			)}
		</div>
	);
}
