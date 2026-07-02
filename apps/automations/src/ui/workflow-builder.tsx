/**
 * 11b.11 — the workflow builder surface. A linear (v1, no visual graph)
 * composer that authors a `Workflow/v1` + its bound `Trigger/v1` the
 * existing shell runner executes unchanged. Renders inside the shared
 * `<Popover>`; every enumerated choice goes through `<SelectMenu>` (no
 * native `<select>`); every user string is `t()`-wrapped.
 *
 * Three sections:
 *   • Trigger — kind + the minimal per-kind config (engine-wired set).
 *   • Steps — the step palette (add any builder StepKind), linear
 *     add / remove / reorder / duplicate, and per-step config including the
 *     OQ-166 output-binding affordance (pick a prior step → reference its
 *     output by id; member access via the expression field) and the OQ-167
 *     expression field for Branch / ForEach / Code.
 *   • Capability sheet — the union the steps require, computed live,
 *     each row granted / missing against the app ceiling; a missing row
 *     blocks save (the same fail-closed rule the host enforces at run time).
 *
 * The save-time validation pass (`validateBuilderWorkflow`) surfaces empty
 * names, empty bodies, `<unbound>` bindings, missing config, and capability
 * overreach; Save is gated on a clean pass.
 */

import {
	type AIAgentStep,
	type AgentTool,
	ENTITY_EVENT_VERBS,
	EXPORT_TEXT_FORMATS,
	EntityOp,
	type ExportTextFormat,
	StepKind,
	TriggerKind,
	type WorkflowStep,
} from "@brainstorm/sdk-types";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { Popover, PopoverSize } from "@brainstorm/sdk/popover";
import { SelectMenu, type SelectMenuOption } from "@brainstorm/sdk/select-menu";
import { type ReactElement, useMemo, useState } from "react";
import { type AutomationsI18nKey, t } from "../i18n";
import {
	BUILDER_STEP_KINDS,
	type BuilderIssue,
	BuilderIssueKind,
	type BuilderState,
	CapabilityRowState,
	UNBOUND,
	addStep,
	bindableSteps,
	bindingExpression,
	bindingStepId,
	computeCapabilitySheet,
	duplicateStep,
	emptyBuilderState,
	moveStep,
	removeStep,
	updateStep,
	validateBuilderWorkflow,
} from "../logic/builder-model";
import {
	BUILDER_TRIGGER_KINDS,
	type BuilderTrigger,
	TIME_PRESETS,
	type TimePreset,
	emptyBuilderTrigger,
} from "../logic/builder-trigger";

export type BuilderResult = {
	state: BuilderState;
	trigger: BuilderTrigger;
};

export type WorkflowBuilderProps = {
	appCapabilities: readonly string[];
	initialState?: BuilderState;
	initialTrigger?: BuilderTrigger;
	onClose: () => void;
	onSave: (result: BuilderResult) => void;
};

function stepKindLabel(kind: StepKind): string {
	return t(`step.kind.${kind}` as AutomationsI18nKey);
}

function triggerKindLabel(kind: TriggerKind): string {
	return t(`trigger.kind.${kind}` as AutomationsI18nKey);
}

function StepConfig({
	step,
	priorSteps,
	onChange,
}: {
	step: WorkflowStep;
	priorSteps: readonly WorkflowStep[];
	onChange: (next: WorkflowStep) => void;
}): ReactElement | null {
	switch (step.kind) {
		case StepKind.Notify:
			return (
				<label className="au-field">
					<span className="au-field__label">{t("builder.notify.title")}</span>
					<input
						className="bs-input"
						type="text"
						value={step.title}
						placeholder={t("builder.notify.titlePlaceholder")}
						onChange={(e) => onChange({ ...step, title: e.target.value })}
					/>
				</label>
			);
		case StepKind.Intent:
			return (
				<label className="au-field">
					<span className="au-field__label">{t("builder.intent.verb")}</span>
					<input
						className="bs-input"
						type="text"
						value={step.verb}
						placeholder={t("builder.intent.verbPlaceholder")}
						onChange={(e) => onChange({ ...step, verb: e.target.value })}
					/>
				</label>
			);
		case StepKind.Entity:
			return (
				<>
					<div className="au-field">
						<span className="au-field__label">{t("builder.entity.op")}</span>
						<SelectMenu<EntityOp>
							value={step.op}
							ariaLabel={t("builder.entity.op")}
							options={[
								EntityOp.Create,
								EntityOp.Update,
								EntityOp.Query,
								EntityOp.Get,
								EntityOp.Delete,
							].map((op) => ({ value: op, label: t(`entity.op.${op}` as AutomationsI18nKey) }))}
							onChange={(op) => onChange({ ...step, op })}
						/>
					</div>
					<label className="au-field">
						<span className="au-field__label">{t("builder.entity.type")}</span>
						<input
							className="bs-input"
							type="text"
							value={step.entityType}
							placeholder="brainstorm/Note/v1"
							onChange={(e) => onChange({ ...step, entityType: e.target.value })}
						/>
					</label>
				</>
			);
		case StepKind.Wait:
			return (
				<label className="au-field">
					<span className="au-field__label">{t("builder.wait.duration")}</span>
					<input
						className="bs-input"
						type="number"
						min={0}
						value={step.durationMs ?? 0}
						onChange={(e) => onChange({ ...step, durationMs: Math.max(0, Number(e.target.value) || 0) })}
					/>
				</label>
			);
		case StepKind.SubWorkflow:
			return (
				<label className="au-field">
					<span className="au-field__label">{t("builder.subworkflow.id")}</span>
					<input
						className="bs-input"
						type="text"
						value={step.workflowId}
						placeholder={t("builder.subworkflow.idPlaceholder")}
						onChange={(e) => onChange({ ...step, workflowId: e.target.value })}
					/>
				</label>
			);
		case StepKind.Branch:
			return (
				<BindingField
					labelKey="builder.branch.condition"
					value={step.condition}
					priorSteps={priorSteps}
					onChange={(condition) => onChange({ ...step, condition })}
				/>
			);
		case StepKind.ForEach:
			return (
				<BindingField
					labelKey="builder.foreach.collection"
					value={step.collection}
					priorSteps={priorSteps}
					onChange={(collection) => onChange({ ...step, collection })}
				/>
			);
		case StepKind.Code:
			return (
				<BindingField
					labelKey="builder.code.expression"
					value={step.expression}
					priorSteps={priorSteps}
					onChange={(expression) => onChange({ ...step, expression })}
				/>
			);
		case StepKind.Export:
			return (
				<div className="au-field">
					<span className="au-field__label">{t("builder.export.format")}</span>
					<SelectMenu<ExportTextFormat>
						value={step.format}
						ariaLabel={t("builder.export.format")}
						options={EXPORT_TEXT_FORMATS.map((format) => ({
							value: format,
							label: t(`export.format.${format}` as AutomationsI18nKey),
						}))}
						onChange={(format) => onChange({ ...step, format })}
					/>
				</div>
			);
		case StepKind.AICall:
			return (
				<>
					<label className="au-field">
						<span className="au-field__label">{t("builder.ai.instructions")}</span>
						<textarea
							className="bs-input bs-input--multiline"
							rows={3}
							value={step.instructions}
							placeholder={t("builder.ai.instructionsPlaceholder")}
							onChange={(e) => onChange({ ...step, instructions: e.target.value })}
						/>
					</label>
					<label className="au-field">
						<span className="au-field__label">{t("builder.ai.provider")}</span>
						<input
							className="bs-input"
							type="text"
							value={step.provider ?? ""}
							placeholder={t("builder.ai.providerPlaceholder")}
							onChange={(e) => onChange(withProvider(step, e.target.value))}
						/>
					</label>
				</>
			);
		case StepKind.AIAgent:
			return <AgentStepConfig step={step} onChange={onChange} />;
		default:
			return null;
	}
}

/** Set / clear an AI step's optional `provider`: a blank value removes the key
 *  (the broker picks the configured default) rather than persisting an empty
 *  scope — and never leaves `provider: undefined` under exactOptionalPropertyTypes. */
function withProvider<S extends { provider?: string }>(step: S, value: string): S {
	const trimmed = value.trim();
	const { provider: _drop, ...rest } = step;
	return trimmed.length > 0 ? ({ ...rest, provider: trimmed } as S) : ({ ...rest } as S);
}

/** The AIAgent step config: instructions + provider + the tools list (each a
 *  workflow intent the agent may call) + the iteration bound. The tools become
 *  `intents.dispatch:<verb>` rows in the capability sheet, intersected
 *  fail-closed against the workflow's frozen caps at run time. */
function AgentStepConfig({
	step,
	onChange,
}: {
	step: AIAgentStep;
	onChange: (next: WorkflowStep) => void;
}): ReactElement {
	const setTool = (index: number, patch: Partial<AgentTool>): void => {
		const tools = step.tools.map((tool, i) => (i === index ? { ...tool, ...patch } : tool));
		onChange({ ...step, tools });
	};
	const addTool = (): void => onChange({ ...step, tools: [...step.tools, { verb: "", label: "" }] });
	const removeTool = (index: number): void =>
		onChange({ ...step, tools: step.tools.filter((_, i) => i !== index) });

	return (
		<>
			<label className="au-field">
				<span className="au-field__label">{t("builder.ai.instructions")}</span>
				<textarea
					className="bs-input bs-input--multiline"
					rows={3}
					value={step.instructions}
					placeholder={t("builder.ai.agentInstructionsPlaceholder")}
					onChange={(e) => onChange({ ...step, instructions: e.target.value })}
				/>
			</label>
			<label className="au-field">
				<span className="au-field__label">{t("builder.ai.maxIterations")}</span>
				<input
					className="bs-input"
					type="number"
					min={1}
					value={step.maxIterations ?? ""}
					placeholder={t("builder.ai.maxIterationsPlaceholder")}
					onChange={(e) => {
						const n = Number(e.target.value);
						onChange({
							...step,
							...(Number.isFinite(n) && n >= 1 ? { maxIterations: Math.floor(n) } : {}),
						});
					}}
				/>
			</label>
			<div className="au-field">
				<div className="au-builder__steps-head">
					<span className="au-field__label">{t("builder.ai.tools")}</span>
					<button type="button" className="bs-btn bs-btn--neutral" onClick={addTool}>
						{t("builder.ai.addTool")}
					</button>
				</div>
				{step.tools.length === 0 ? (
					<p className="au-builder__steps-empty">{t("builder.ai.toolsEmpty")}</p>
				) : (
					<ul className="au-tools">
						{step.tools.map((tool, index) => (
							<li className="au-tool" key={`tool-${index}-${tool.verb}`}>
								<input
									className="bs-input"
									type="text"
									value={tool.verb}
									placeholder={t("builder.ai.toolVerbPlaceholder")}
									aria-label={t("builder.ai.toolVerb")}
									onChange={(e) => setTool(index, { verb: e.target.value })}
								/>
								<input
									className="bs-input"
									type="text"
									value={tool.label}
									placeholder={t("builder.ai.toolLabelPlaceholder")}
									aria-label={t("builder.ai.toolLabel")}
									onChange={(e) => setTool(index, { label: e.target.value })}
								/>
								<button
									type="button"
									className="bs-btn bs-btn--icon bs-btn--danger"
									aria-label={t("builder.ai.removeTool")}
									onClick={() => removeTool(index)}
								>
									<Icon name={IconName.Trash} size={16} />
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</>
	);
}

/** The OQ-166 output-binding affordance: a `<SelectMenu>` to pick a prior
 *  step (or the trigger `input`), plus a free expression field for member
 *  access and the OQ-167 grammar. Picking a step rewrites only the leading
 *  id token, preserving any member path the user typed. */
function BindingField({
	labelKey,
	value,
	priorSteps,
	onChange,
}: {
	labelKey: AutomationsI18nKey;
	value: string;
	priorSteps: readonly WorkflowStep[];
	onChange: (next: string) => void;
}): ReactElement {
	const options: SelectMenuOption[] = [
		{ value: "input", label: t("builder.binding.input") },
		...priorSteps.map((s, i) => ({
			value: s.id,
			label: t("builder.binding.step", { n: String(i + 1), kind: stepKindLabel(s.kind) }),
		})),
	];
	const selectedId = bindingStepId(value);
	const memberPath = ((): string => {
		if (selectedId === null) return value.trim() === "input" ? "" : value.trim();
		const rest = value.trim().slice(selectedId.length);
		return rest.replace(/^\./, "");
	})();
	const selectValue = selectedId ?? (value.trim() === "input" ? "input" : null);
	const unbound =
		value.trim() === UNBOUND || (selectedId !== null && !priorSteps.some((s) => s.id === selectedId));

	return (
		<div className="au-field">
			<span className="au-field__label">{t(labelKey)}</span>
			<div className="au-binding">
				<SelectMenu
					value={selectValue}
					ariaLabel={t("builder.binding.source")}
					placeholder={t("builder.binding.pick")}
					options={options}
					onChange={(id) => onChange(bindingExpression(id === "input" ? "input" : id, memberPath))}
				/>
				<input
					className="bs-input au-binding__expr"
					type="text"
					value={value}
					placeholder={t("builder.binding.exprPlaceholder")}
					aria-label={t(labelKey)}
					onChange={(e) => onChange(e.target.value)}
				/>
			</div>
			{unbound ? <p className="au-binding__unbound">{t("builder.binding.unbound")}</p> : null}
		</div>
	);
}

function StepCard({
	step,
	index,
	count,
	priorSteps,
	onChange,
	onMove,
	onDuplicate,
	onRemove,
}: {
	step: WorkflowStep;
	index: number;
	count: number;
	priorSteps: readonly WorkflowStep[];
	onChange: (next: WorkflowStep) => void;
	onMove: (delta: number) => void;
	onDuplicate: () => void;
	onRemove: () => void;
}): ReactElement {
	return (
		<li className="au-bstep" data-testid={`builder-step-${index}`}>
			<div className="au-bstep__head">
				<span className="au-bstep__kind">{stepKindLabel(step.kind)}</span>
				<div className="au-bstep__ops">
					<button
						type="button"
						className="bs-btn bs-btn--icon"
						aria-label={t("builder.step.moveUp")}
						disabled={index <= 1}
						onClick={() => onMove(-1)}
					>
						<Icon name={IconName.CaretUp} size={16} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--icon"
						aria-label={t("builder.step.moveDown")}
						disabled={index >= count - 1}
						onClick={() => onMove(1)}
					>
						<Icon name={IconName.CaretDown} size={16} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--icon"
						aria-label={t("builder.step.duplicate")}
						onClick={onDuplicate}
					>
						<Icon name={IconName.Copy} size={16} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--icon bs-btn--danger"
						aria-label={t("builder.step.remove")}
						onClick={onRemove}
					>
						<Icon name={IconName.Trash} size={16} />
					</button>
				</div>
			</div>
			<div className="au-bstep__body">
				<StepConfig step={step} priorSteps={priorSteps} onChange={onChange} />
			</div>
		</li>
	);
}

function TriggerSection({
	trigger,
	onChange,
}: {
	trigger: BuilderTrigger;
	onChange: (next: BuilderTrigger) => void;
}): ReactElement {
	return (
		<section className="au-builder__section">
			<h3 className="au-builder__section-title">{t("builder.trigger.title")}</h3>
			<div className="au-field">
				<span className="au-field__label">{t("builder.trigger.kind")}</span>
				<SelectMenu<TriggerKind>
					value={trigger.kind}
					ariaLabel={t("builder.trigger.kind")}
					options={BUILDER_TRIGGER_KINDS.map((k) => ({ value: k, label: triggerKindLabel(k) }))}
					onChange={(kind) => onChange({ ...trigger, kind })}
				/>
			</div>
			{trigger.kind === TriggerKind.Time ? (
				<div className="au-field">
					<span className="au-field__label">{t("builder.trigger.repeat")}</span>
					<SelectMenu<TimePreset>
						value={trigger.timePreset}
						ariaLabel={t("builder.trigger.repeat")}
						options={TIME_PRESETS.map((p) => ({
							value: p,
							label: t(`time.preset.${p}` as AutomationsI18nKey),
						}))}
						onChange={(timePreset) => onChange({ ...trigger, timePreset })}
					/>
				</div>
			) : null}
			{trigger.kind === TriggerKind.EntityEvent ? (
				<>
					<label className="au-field">
						<span className="au-field__label">{t("builder.trigger.entityType")}</span>
						<input
							className="bs-input"
							type="text"
							value={trigger.entityType}
							placeholder="brainstorm/Bookmark/v1"
							onChange={(e) => onChange({ ...trigger, entityType: e.target.value })}
						/>
					</label>
					<div className="au-field">
						<span className="au-field__label">{t("builder.trigger.verb")}</span>
						<SelectMenu
							value={trigger.verb}
							ariaLabel={t("builder.trigger.verb")}
							options={ENTITY_EVENT_VERBS.map((v) => ({
								value: v,
								label: t(`entity.verb.${v}` as AutomationsI18nKey),
							}))}
							onChange={(verb) => onChange({ ...trigger, verb })}
						/>
					</div>
				</>
			) : null}
		</section>
	);
}

function CapabilitySheetSection({
	steps,
	appCapabilities,
}: {
	steps: readonly WorkflowStep[];
	appCapabilities: readonly string[];
}): ReactElement {
	const sheet = useMemo(
		() => computeCapabilitySheet(steps, appCapabilities),
		[steps, appCapabilities],
	);
	return (
		<section className="au-builder__section" data-testid="builder-capabilities">
			<h3 className="au-builder__section-title">{t("builder.caps.title")}</h3>
			{sheet.rows.length === 0 ? (
				<p className="au-builder__caps-empty">{t("builder.caps.none")}</p>
			) : (
				<ul className="au-caps">
					{sheet.rows.map((row) => (
						<li
							key={row.capability}
							className={`au-cap au-cap--${row.state === CapabilityRowState.Missing ? "missing" : "granted"}`}
						>
							<code className="au-cap__name">{row.capability}</code>
							<span className="au-cap__state">
								{row.state === CapabilityRowState.Missing
									? t("builder.caps.missing")
									: t("builder.caps.granted")}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function issueMessage(issue: BuilderIssue): string {
	switch (issue.kind) {
		case BuilderIssueKind.EmptyName:
			return t("builder.issue.emptyName");
		case BuilderIssueKind.NoSteps:
			return t("builder.issue.noSteps");
		case BuilderIssueKind.UnboundBinding:
			return t("builder.issue.unbound", { detail: issue.detail ?? "" });
		case BuilderIssueKind.EmptyStepConfig:
			return t("builder.issue.emptyConfig", { detail: issue.detail ?? "" });
		case BuilderIssueKind.CapabilityExceeded:
			return t("builder.issue.capExceeded", { detail: issue.detail ?? "" });
	}
}

export function WorkflowBuilder(props: WorkflowBuilderProps): ReactElement {
	const { appCapabilities, onClose, onSave } = props;
	const [state, setState] = useState<BuilderState>(props.initialState ?? emptyBuilderState());
	const [trigger, setTrigger] = useState<BuilderTrigger>(
		props.initialTrigger ?? emptyBuilderTrigger(),
	);
	const [attempted, setAttempted] = useState(false);

	const issues = useMemo(
		() => validateBuilderWorkflow(state, appCapabilities),
		[state, appCapabilities],
	);
	const canSave = issues.length === 0;

	const onAddStep = (kind: StepKind): void => setState((s) => addStep(s, kind));

	const save = (): void => {
		setAttempted(true);
		if (!canSave) return;
		// Hand back the editable state + trigger; the app's repository layer
		// (`saveBuiltWorkflow`) mints the Trigger/v1 then the Workflow/v1
		// bound to its id, with the step-derived capability sheet.
		onSave({ state, trigger });
	};

	const paletteOptions: SelectMenuOption<StepKind>[] = BUILDER_STEP_KINDS.map((kind) => ({
		value: kind,
		label: stepKindLabel(kind),
	}));

	const prior = bindableSteps(state.steps);

	return (
		<Popover
			title={t("builder.title")}
			onClose={onClose}
			size={PopoverSize.Large}
			testId="workflow-builder"
			footer={
				<div className="au-builder__footer">
					{attempted && issues.length > 0 ? (
						<ul className="au-builder__issues" role="alert">
							{issues.map((issue, i) => (
								<li key={`${issue.kind}-${issue.stepId ?? ""}-${issue.detail ?? ""}-${i}`}>
									{issueMessage(issue)}
								</li>
							))}
						</ul>
					) : null}
					<div className="au-builder__actions">
						<button type="button" className="bs-btn bs-btn--neutral" onClick={onClose}>
							{t("builder.cancel")}
						</button>
						<button
							type="button"
							className="bs-btn"
							data-bs-primary=""
							data-testid="builder-save"
							disabled={attempted && !canSave}
							onClick={save}
						>
							{t("builder.save")}
						</button>
					</div>
				</div>
			}
		>
			<div className="au-builder">
				<label className="au-field">
					<span className="au-field__label">{t("builder.name")}</span>
					<input
						className="bs-input"
						type="text"
						value={state.name}
						placeholder={t("builder.namePlaceholder")}
						data-testid="builder-name"
						onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
					/>
				</label>

				<TriggerSection trigger={trigger} onChange={setTrigger} />

				<section className="au-builder__section">
					<div className="au-builder__steps-head">
						<h3 className="au-builder__section-title">{t("builder.steps.title")}</h3>
						<PaletteAdd options={paletteOptions} onAdd={onAddStep} />
					</div>
					{prior.length === 0 ? (
						<p className="au-builder__steps-empty">{t("builder.steps.empty")}</p>
					) : (
						<ol className="au-bsteps">
							{state.steps.map((step, index) =>
								step.kind === StepKind.Trigger ? null : (
									<StepCard
										key={step.id}
										step={step}
										index={index}
										count={state.steps.length}
										priorSteps={state.steps.slice(0, index).filter((s) => s.kind !== StepKind.Trigger)}
										onChange={(next) => setState((s) => updateStep(s, index, next))}
										onMove={(delta) => setState((s) => moveStep(s, index, delta))}
										onDuplicate={() => setState((s) => duplicateStep(s, index))}
										onRemove={() => setState((s) => removeStep(s, index))}
									/>
								),
							)}
						</ol>
					)}
				</section>

				<CapabilitySheetSection steps={state.steps} appCapabilities={appCapabilities} />
			</div>
		</Popover>
	);
}

/** The step palette as a `<SelectMenu>` — picking a kind appends a step of
 *  that kind. Resets its value each pick so it always reads "Add step". */
function PaletteAdd({
	options,
	onAdd,
}: {
	options: readonly SelectMenuOption<StepKind>[];
	onAdd: (kind: StepKind) => void;
}): ReactElement {
	return (
		<SelectMenu<StepKind>
			value={null}
			ariaLabel={t("builder.palette.add")}
			placeholder={t("builder.palette.add")}
			className="au-builder__palette"
			options={options}
			onChange={onAdd}
		/>
	);
}
