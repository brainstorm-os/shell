import type { AutomationsHostStatus } from "@brainstorm-os/sdk-types";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { AnchoredMenuItem } from "@brainstorm-os/sdk/object-menu";
import type { ReactElement } from "react";
import { plural, t } from "../i18n";
import type { AutomationsI18nKey } from "../i18n";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "../logic/templates";
import type { LoadedWorkflow } from "../storage/automation-repository";
import { RowMenu } from "./row-menu";
import type { StatusBanner } from "./status";

export type WorkflowsViewProps = {
	workflows: LoadedWorkflow[];
	status: StatusBanner | null;
	/** Automation-host designation for this device (11b.15) — null until the
	 *  shell reports it, or when running outside the shell. */
	hostStatus: AutomationsHostStatus | null;
	onClaimHost: () => void;
	showTemplates: boolean;
	canTransferFiles: boolean;
	onToggleTemplates: () => void;
	onNewWorkflow: () => void;
	onEditWorkflow: (workflow: LoadedWorkflow) => void;
	onImport: () => void;
	onAddTemplate: (template: WorkflowTemplate) => void;
	onToggleWorkflow: (workflow: LoadedWorkflow) => void;
	onCopyWorkflow: (workflow: LoadedWorkflow) => void;
	onExportWorkflow: (workflow: LoadedWorkflow) => void;
	/** Manual trigger ("Run now") — absent outside the shell. */
	onRunWorkflow?: ((workflow: LoadedWorkflow) => void) | undefined;
};

function TemplateGallery({
	onCancel,
	onAdd,
	dismissible,
}: {
	onCancel: () => void;
	onAdd: (template: WorkflowTemplate) => void;
	/** Show the Cancel affordance. False when the gallery IS the empty state
	 *  (no workflows yet) — there's nothing to dismiss back to. */
	dismissible: boolean;
}): ReactElement {
	return (
		<div className="au-templates">
			<div className="au-templates__head">
				<h2 className="au-templates__title">{t("templates.title")}</h2>
				{dismissible ? (
					<button type="button" className="bs-btn bs-btn--neutral" onClick={onCancel}>
						{t("templates.cancel")}
					</button>
				) : null}
			</div>
			<ul className="au-templates__grid">
				{WORKFLOW_TEMPLATES.map((template) => (
					<li key={template.id} className="au-template">
						<span className="au-template__name">
							{t(`template.${template.id}.name` as AutomationsI18nKey)}
						</span>
						<p className="au-template__desc">{t(`template.${template.id}.desc` as AutomationsI18nKey)}</p>
						<span className="au-template__trigger">
							{t(`template.${template.id}.trigger` as AutomationsI18nKey)}
						</span>
						<button type="button" className="bs-btn" data-bs-primary="" onClick={() => onAdd(template)}>
							{t("templates.add")}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function WorkflowRow({
	workflow,
	canTransferFiles,
	onToggle,
	onEdit,
	onCopy,
	onExport,
	onRun,
}: {
	workflow: LoadedWorkflow;
	canTransferFiles: boolean;
	onToggle: () => void;
	onEdit: () => void;
	onCopy: () => void;
	onExport: () => void;
	onRun?: (() => void) | undefined;
}): ReactElement {
	const { def } = workflow;
	const items: AnchoredMenuItem[] = [
		{ label: t("workflow.edit"), icon: IconName.Pencil, onSelect: onEdit },
	];
	if (onRun) items.push({ label: t("workflow.runNow"), icon: IconName.Update, onSelect: onRun });
	items.push(
		{
			label: def.enabled ? t("workflow.disable") : t("workflow.enable"),
			icon: IconName.Check,
			onSelect: onToggle,
		},
		{ label: t("transfer.copy"), icon: IconName.Copy, onSelect: onCopy },
	);
	if (canTransferFiles)
		items.push({ label: t("transfer.export"), icon: IconName.Download, onSelect: onExport });

	return (
		<li className="au-row">
			<span className="au-row__name">{def.name}</span>
			<span className="au-row__meta">
				{plural(def.steps.length, "workflow.stepCount.one", "workflow.stepCount.other")}
			</span>
			<span className={`au-row__status au-row__status--${def.enabled ? "on" : "off"}`}>
				{def.enabled ? t("workflow.enabled") : t("workflow.disabled")}
			</span>
			<RowMenu menuLabel={t("workflow.actions")} items={items} />
		</li>
	);
}

function HostStatusRow({
	hostStatus,
	onClaimHost,
}: {
	hostStatus: AutomationsHostStatus;
	onClaimHost: () => void;
}): ReactElement {
	const isHost = hostStatus.hostDeviceId === hostStatus.deviceId;
	const unset = hostStatus.hostDeviceId === null;
	const label = isHost ? t("host.thisDevice") : unset ? t("host.unset") : t("host.otherDevice");
	return (
		<div className={`au-host au-host--${isHost ? "self" : "other"}`} data-testid="host-status">
			<span className="au-host__face">
				<Icon name={isHost ? IconName.CheckCircle : IconName.Info} size={16} />
				<span className="au-host__label">{label}</span>
			</span>
			{isHost ? null : (
				<button type="button" className="bs-btn bs-btn--neutral au-host__claim" onClick={onClaimHost}>
					{unset ? t("host.claim") : t("host.takeOver")}
				</button>
			)}
		</div>
	);
}

export function WorkflowsView(props: WorkflowsViewProps): ReactElement {
	const { workflows, status, hostStatus, showTemplates, canTransferFiles } = props;
	return (
		<div className="au-section">
			{hostStatus ? <HostStatusRow hostStatus={hostStatus} onClaimHost={props.onClaimHost} /> : null}
			<div className="au-toolbar">
				{canTransferFiles ? (
					<button type="button" className="bs-btn bs-btn--neutral" onClick={props.onImport}>
						{t("transfer.import")}
					</button>
				) : null}
				<button type="button" className="bs-btn bs-btn--neutral" onClick={props.onToggleTemplates}>
					{t("templates.open")}
				</button>
				<button
					type="button"
					className="bs-btn"
					data-bs-primary=""
					data-testid="new-workflow"
					onClick={props.onNewWorkflow}
				>
					{t("workflows.new")}
				</button>
			</div>

			{status ? (
				<p className={`au-status au-status--${status.tone}`} role="status">
					{status.message}
				</p>
			) : null}

			{showTemplates || workflows.length === 0 ? (
				<TemplateGallery
					onCancel={props.onToggleTemplates}
					onAdd={props.onAddTemplate}
					dismissible={workflows.length > 0}
				/>
			) : null}

			{workflows.length > 0 ? (
				<ul className="au-list">
					{workflows.map((workflow) => (
						<WorkflowRow
							key={workflow.id}
							workflow={workflow}
							canTransferFiles={canTransferFiles}
							onToggle={() => props.onToggleWorkflow(workflow)}
							onEdit={() => props.onEditWorkflow(workflow)}
							onCopy={() => props.onCopyWorkflow(workflow)}
							onExport={() => props.onExportWorkflow(workflow)}
							onRun={props.onRunWorkflow ? () => props.onRunWorkflow?.(workflow) : undefined}
						/>
					))}
				</ul>
			) : null}
		</div>
	);
}
