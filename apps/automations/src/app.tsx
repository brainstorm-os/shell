/**
 * Automations app (React, 11b.17). Three tabbed views over the four frozen
 * contracts (`Workflow|Trigger|WorkflowRun|Reminder/v1`):
 *
 *   • Workflows — list + enable/disable + "New from template" gallery + the
 *     export/import bundle transfer (11b.14 / 11b.16).
 *   • Reminders — low-friction quick-capture (11b.12) + Done/Snooze/Delete
 *     row actions over `Reminder/v1`.
 *   • Runs — `WorkflowRun/v1` history with status, relative time, and a
 *     depth-tagged step-log inspector (11b.13).
 *
 * Reactivity: all three lists are derived from the live whole-vault snapshot
 * read through the ONE shared stack — `@brainstorm/react-yjs`
 * `useVaultEntities` (which owns the change subscription + coalescing) —
 * never a hand-rolled `onChange → list → setState`. Pure logic lives in
 * `logic/*`; persistence in `storage/*`. Outside the shell there is no
 * entities service, so the app falls back to an empty workspace per the
 * [[preview-drop-pattern]].
 */

import { useVaultEntities } from "@brainstorm/react-yjs";
import type { AutomationsHostStatus, AutomationsService, ReminderDef } from "@brainstorm/sdk-types";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AutomationsI18nKey, t } from "./i18n";
import { useAutomationsT } from "./i18n-hooks";
import { type BuilderState, builderStateFromWorkflow } from "./logic/builder-model";
import {
	type BuilderTrigger,
	builderTriggerFromDef,
	emptyBuilderTrigger,
	triggerTypeSuggestions,
} from "./logic/builder-trigger";
import type { WorkflowTemplate } from "./logic/templates";
import {
	ExportOutcome,
	type ExportResult,
	ImportOutcome,
	exportWorkflowToClipboard,
	exportWorkflowToFile,
	importWorkflowFromFile,
} from "./logic/transfer-actions";
import {
	type LoadedWorkflow,
	deleteReminder,
	instantiateWorkflowTemplate,
	loadTrigger,
	remindersFromSnapshot,
	runsFromSnapshot,
	saveBuiltWorkflow,
	saveReminder,
	saveWorkflow,
	workflowsFromSnapshot,
} from "./storage/automation-repository";
import type { EntitiesService, FilesService } from "./storage/runtime";
import { getBrainstorm } from "./storage/runtime";
import { RemindersView } from "./ui/reminders-view";
import { RunsView } from "./ui/runs-view";
import { type StatusBanner, StatusTone } from "./ui/status";
import { type BuilderResult, WorkflowBuilder } from "./ui/workflow-builder";
import { WorkflowsView } from "./ui/workflows-view";

enum View {
	Workflows = "workflows",
	Reminders = "reminders",
	Runs = "runs",
}

const TABS: ReadonlyArray<{ view: View; key: AutomationsI18nKey }> = [
	{ view: View.Workflows, key: "tab.workflows" },
	{ view: View.Reminders, key: "tab.reminders" },
	{ view: View.Runs, key: "tab.runs" },
];

const STATUS_CLEAR_MS = 4000;

const TRANSFER_LABELS = {
	get exportTitle(): string {
		return t("transfer.saveDialogTitle");
	},
	get importTitle(): string {
		return t("transfer.openDialogTitle");
	},
	get filterName(): string {
		return t("transfer.filterName");
	},
};

function entitiesService(): EntitiesService | null {
	return getBrainstorm()?.services?.entities ?? null;
}

function filesService(): FilesService | null {
	return getBrainstorm()?.services?.files ?? null;
}

function automationsService(): AutomationsService | null {
	return getBrainstorm()?.services?.automations ?? null;
}

function now(): number {
	return Date.now();
}

/** The builder is either closed, open for a new workflow, or open editing
 *  an existing one (with its current state + trigger + enabled flag). */
type BuilderTarget =
	| { mode: "closed" }
	| { mode: "new" }
	| {
			mode: "edit";
			workflowId: string;
			triggerId: string;
			enabled: boolean;
			state: BuilderState;
			trigger: BuilderTrigger;
	  };

export function AutomationsApp(): ReactElement {
	useAutomationsT();
	const [ready, setReady] = useState(false);
	const [view, setView] = useState<View>(View.Workflows);
	const [showTemplates, setShowTemplates] = useState(false);
	const [builder, setBuilder] = useState<BuilderTarget>({ mode: "closed" });
	const [status, setStatus] = useState<StatusBanner | null>(null);
	const [hostStatus, setHostStatus] = useState<AutomationsHostStatus | null>(null);
	const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

	const canTransferFiles = Boolean(getBrainstorm()?.services?.files);
	const appCapabilities = getBrainstorm()?.capabilities ?? [];

	// ── Reactivity: the three lists read off the live whole-vault snapshot
	// through the ONE shared stack — `useVaultEntities` owns the subscription +
	// coalescing. A save here, or a write from another device, re-derives the
	// lists with no hand-rolled `onChange → list → setState`.
	const vault = useVaultEntities(ready ? (getBrainstorm()?.services?.vaultEntities ?? null) : null);
	const workflows = useMemo(() => workflowsFromSnapshot(vault.entities), [vault]);
	const reminders = useMemo(() => remindersFromSnapshot(vault.entities), [vault]);
	const runs = useMemo(() => runsFromSnapshot(vault.entities), [vault]);
	// Mailbox-8 — surface the types the vault holds (+ curated) as EntityEvent
	// trigger suggestions, so authoring an email-triage automation doesn't need
	// the exact `brainstorm/Email/v1` URL.
	const knownTriggerTypes = useMemo(
		() => triggerTypeSuggestions(vault.entities.map((e) => e.type)),
		[vault],
	);

	// ── Boot: the runtime hands services over after first paint, so gate the
	// live binding on the lifecycle `ready` handshake (fall through immediately
	// outside the shell).
	useEffect(() => {
		const bs = getBrainstorm();
		if (bs?.on) {
			const sub = bs.on("ready", () => setReady(true));
			return () => sub?.unsubscribe();
		}
		setReady(true);
		return undefined;
	}, []);

	useEffect(() => {
		return () => {
			if (statusTimer.current) clearTimeout(statusTimer.current);
		};
	}, []);

	const flashStatus = useCallback((message: string, tone: StatusTone): void => {
		if (statusTimer.current) clearTimeout(statusTimer.current);
		setStatus({ message, tone });
		statusTimer.current = setTimeout(() => {
			setStatus(null);
			statusTimer.current = null;
		}, STATUS_CLEAR_MS);
	}, []);

	// 11b.15 — read the automation-host designation once the shell is up so the
	// Workflows view can show "this device hosts" vs offer a Claim. A claim or a
	// take-over from another device re-reads the singleton designation.
	useEffect(() => {
		if (!ready) return undefined;
		const automations = automationsService();
		if (!automations) return undefined;
		let cancelled = false;
		void automations
			.hostStatus()
			.then((next) => {
				if (!cancelled) setHostStatus(next);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [ready]);

	const onClaimHost = useCallback((): void => {
		const automations = automationsService();
		if (!automations) return;
		void automations
			.claimHost()
			.then((next) => {
				setHostStatus(next);
				flashStatus(t("host.claimed"), StatusTone.Info);
			})
			.catch(() => {
				flashStatus(t("host.claimFailed"), StatusTone.Warn);
			});
	}, [flashStatus]);

	const reportExport = useCallback(
		(outcome: ExportOutcome, name: string): void => {
			switch (outcome) {
				case ExportOutcome.Saved:
					flashStatus(t("transfer.saved", { name }), StatusTone.Info);
					return;
				case ExportOutcome.Copied:
					flashStatus(t("transfer.copied", { name }), StatusTone.Info);
					return;
				case ExportOutcome.MissingTrigger:
					flashStatus(t("transfer.missingTrigger"), StatusTone.Warn);
					return;
				case ExportOutcome.Failed:
					flashStatus(t("transfer.exportFailed"), StatusTone.Warn);
					return;
				case ExportOutcome.Cancelled:
					return;
			}
		},
		[flashStatus],
	);

	const onAddTemplate = useCallback((template: WorkflowTemplate): void => {
		void instantiateWorkflowTemplate(entitiesService(), template).then(() => setShowTemplates(false));
	}, []);

	const onToggleWorkflow = useCallback((workflow: LoadedWorkflow): void => {
		void saveWorkflow(
			entitiesService(),
			{ ...workflow.def, enabled: !workflow.def.enabled },
			workflow.id,
		);
	}, []);

	const onNewWorkflow = useCallback((): void => {
		setShowTemplates(false);
		setBuilder({ mode: "new" });
	}, []);

	const onEditWorkflow = useCallback((workflow: LoadedWorkflow): void => {
		void loadTrigger(entitiesService(), workflow.def.triggerId).then((triggerDef) => {
			setBuilder({
				mode: "edit",
				workflowId: workflow.id,
				triggerId: workflow.def.triggerId,
				enabled: workflow.def.enabled,
				state: builderStateFromWorkflow(workflow.def),
				trigger: triggerDef ? builderTriggerFromDef(triggerDef) : emptyBuilderTrigger(),
			});
		});
	}, []);

	const onSaveBuilder = useCallback(
		(result: BuilderResult): void => {
			const existing =
				builder.mode === "edit"
					? {
							workflowId: builder.workflowId,
							triggerId: builder.triggerId,
							enabled: builder.enabled,
						}
					: undefined;
			void saveBuiltWorkflow(entitiesService(), result.state, result.trigger, existing).then(() => {
				setBuilder({ mode: "closed" });
				flashStatus(t("transfer.saved", { name: result.state.name }), StatusTone.Info);
			});
		},
		[builder, flashStatus],
	);

	// 11b.6 — the Manual trigger. The shell-side host loads + runs the
	// workflow under its frozen capability sheet and persists the
	// WorkflowRun/v1 (it appears in the Runs tab via the live snapshot).
	const canRunNow = Boolean(automationsService());
	const onRunWorkflow = useCallback(
		(workflow: LoadedWorkflow): void => {
			const automations = automationsService();
			if (!automations) return;
			void automations
				.runNow({ workflowId: workflow.id })
				.then((result) => {
					if (result.status === null) {
						flashStatus(t("workflow.runRefused", { name: workflow.def.name }), StatusTone.Warn);
					} else {
						flashStatus(
							t("workflow.runStarted", { name: workflow.def.name, status: result.status }),
							StatusTone.Info,
						);
					}
				})
				.catch(() => {
					flashStatus(t("workflow.runRefused", { name: workflow.def.name }), StatusTone.Warn);
				});
		},
		[flashStatus],
	);

	const onCopyWorkflow = useCallback(
		(workflow: LoadedWorkflow): void => {
			void exportWorkflowToClipboard(entitiesService(), workflow, navigator.clipboard).then(
				(result: ExportResult) => reportExport(result.outcome, workflow.def.name),
			);
		},
		[reportExport],
	);

	const onExportWorkflow = useCallback(
		(workflow: LoadedWorkflow): void => {
			const files = filesService();
			if (!files) return;
			void exportWorkflowToFile(entitiesService(), files, workflow, {
				dialogTitle: TRANSFER_LABELS.exportTitle,
				filterName: TRANSFER_LABELS.filterName,
			}).then((result) => reportExport(result.outcome, workflow.def.name));
		},
		[reportExport],
	);

	const onImport = useCallback((): void => {
		const files = filesService();
		if (!files) return;
		const existing = workflows.map((w) => w.def.name);
		void importWorkflowFromFile(entitiesService(), files, existing, {
			dialogTitle: TRANSFER_LABELS.importTitle,
			filterName: TRANSFER_LABELS.filterName,
		}).then((result) => {
			switch (result.outcome) {
				case ImportOutcome.Imported:
					flashStatus(t("transfer.imported", { name: result.name }), StatusTone.Info);
					return;
				case ImportOutcome.Invalid:
					flashStatus(t("transfer.invalid", { detail: result.issues[0] ?? "" }), StatusTone.Warn);
					return;
				case ImportOutcome.Failed:
					flashStatus(t("transfer.importFailed"), StatusTone.Warn);
					return;
				case ImportOutcome.Cancelled:
					return;
			}
		});
	}, [workflows, flashStatus]);

	const onAddReminder = useCallback((def: ReminderDef): void => {
		void saveReminder(entitiesService(), def);
	}, []);

	const onMutateReminder = useCallback((id: string, next: ReminderDef): void => {
		void saveReminder(entitiesService(), next, id);
	}, []);

	const onDeleteReminder = useCallback((id: string): void => {
		void deleteReminder(entitiesService(), id);
	}, []);

	const onTabKeyDown = (event: React.KeyboardEvent, index: number): void => {
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			event.preventDefault();
			const delta = event.key === "ArrowRight" ? 1 : -1;
			const nextIndex = (index + delta + TABS.length) % TABS.length;
			tabRefs.current[nextIndex]?.focus();
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			const entry = TABS[index];
			if (entry) setView(entry.view);
		}
	};

	const body = ((): ReactElement => {
		switch (view) {
			case View.Reminders:
				return (
					<RemindersView
						reminders={reminders}
						now={now}
						onAdd={onAddReminder}
						onMutate={onMutateReminder}
						onDelete={onDeleteReminder}
					/>
				);
			case View.Runs:
				return <RunsView runs={runs} now={now} />;
			default:
				return (
					<WorkflowsView
						workflows={workflows}
						status={status}
						hostStatus={hostStatus}
						onClaimHost={onClaimHost}
						showTemplates={showTemplates}
						canTransferFiles={canTransferFiles}
						onToggleTemplates={() => setShowTemplates((v) => !v)}
						onNewWorkflow={onNewWorkflow}
						onEditWorkflow={onEditWorkflow}
						onImport={onImport}
						onAddTemplate={onAddTemplate}
						onToggleWorkflow={onToggleWorkflow}
						onRunWorkflow={canRunNow ? onRunWorkflow : undefined}
						onCopyWorkflow={onCopyWorkflow}
						onExportWorkflow={onExportWorkflow}
					/>
				);
		}
	})();

	return (
		<>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<h1 className="app-header__title">{t("app.title")}</h1>
				</div>
				{/* No Automations surface has a header object (workflow actions
				    live on the rows; Import / New from template stay visible
				    toolbar actions), so there is no trailing ⋯ — a permanently
				    disabled one reads as broken. */}
				<div className="app-header__right" />
			</header>
			<main id="app-root">
				{/* kbn-roles-exempt: tab keyboard handled by the app's hand-rolled Arrow-key onKeyDown (verified working). */}
				<nav className="au-tabs" role="tablist" aria-label={t("app.title")}>
					{TABS.map(({ view: tabView, key }, index) => {
						const active = tabView === view;
						return (
							<button
								key={tabView}
								type="button"
								role="tab"
								aria-selected={active}
								tabIndex={active ? 0 : -1}
								ref={(el) => {
									tabRefs.current[index] = el;
								}}
								className="au-tab"
								onClick={() => setView(tabView)}
								onKeyDown={(event) => onTabKeyDown(event, index)}
							>
								{t(key)}
							</button>
						);
					})}
				</nav>
				<section className="au-body">{body}</section>
			</main>
			{builder.mode !== "closed" ? (
				<WorkflowBuilder
					appCapabilities={appCapabilities}
					knownTriggerTypes={knownTriggerTypes}
					{...(builder.mode === "edit"
						? { initialState: builder.state, initialTrigger: builder.trigger }
						: {})}
					onClose={() => setBuilder({ mode: "closed" })}
					onSave={onSaveBuilder}
				/>
			) : null}
		</>
	);
}
