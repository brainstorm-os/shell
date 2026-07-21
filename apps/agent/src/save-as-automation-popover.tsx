/**
 * Agent-6 — the review-then-commit dialog for save-as-automation. Renders the
 * generalized {@link WorkflowDraft} READABLY (name, trigger, the agent step's
 * instruction + tools, the generalized parameters, and the capability set the
 * workflow will hold) so the user confirms exactly what gets created before
 * anything is written. Built on the shared `@brainstorm-os/sdk/popover` primitive
 * (no bespoke dialog chrome).
 *
 * This is a review affordance, not a silent save: `onConfirm` is wired to the
 * Save button only; closing / Cancel writes nothing.
 */

import { StepKind } from "@brainstorm-os/sdk-types";
import { Popover, PopoverSize } from "@brainstorm-os/sdk/popover";
import { useMemo } from "react";
import type { ReactElement } from "react";
import { grantLabel } from "./conversation-settings-popover";
import { t } from "./i18n";
import type { WorkflowDraft } from "./logic/save-as-automation";

export type SaveAsAutomationPopoverProps = {
	draft: WorkflowDraft;
	saving: boolean;
	onConfirm: () => void;
	onClose: () => void;
};

export function SaveAsAutomationPopover({
	draft,
	saving,
	onConfirm,
	onClose,
}: SaveAsAutomationPopoverProps): ReactElement {
	const agentStep = useMemo(
		() => draft.workflow.steps.find((s) => s.kind === StepKind.AIAgent),
		[draft.workflow.steps],
	);
	const instructions = agentStep?.kind === StepKind.AIAgent ? agentStep.instructions : "";
	const tools = agentStep?.kind === StepKind.AIAgent ? agentStep.tools : [];

	return (
		<Popover
			title={t("saveAuto.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			testId="agent-save-automation"
		>
			<div className="agent-save-auto">
				<p className="agent-save-auto__blurb">{t("saveAuto.blurb")}</p>

				<section className="agent-save-auto__section">
					<h3 className="agent-save-auto__heading">{t("saveAuto.name.heading")}</h3>
					<p className="agent-save-auto__name" data-testid="agent-save-automation-name">
						{draft.workflow.name || t("saveAuto.name.untitled")}
					</p>
				</section>

				<section className="agent-save-auto__section">
					<h3 className="agent-save-auto__heading">{t("saveAuto.trigger.heading")}</h3>
					<p className="agent-save-auto__line">{t("saveAuto.trigger.manual")}</p>
				</section>

				<section className="agent-save-auto__section">
					<h3 className="agent-save-auto__heading">{t("saveAuto.step.heading")}</h3>
					<p className="agent-save-auto__instructions" data-testid="agent-save-automation-step">
						{instructions}
					</p>
					{tools.length > 0 ? (
						<ul className="agent-save-auto__tools">
							{tools.map((tool) => (
								<li key={tool.verb} className="agent-save-auto__tool">
									{grantLabel(`intents.dispatch:${tool.verb}`)}
								</li>
							))}
						</ul>
					) : null}
				</section>

				{draft.parameters.length > 0 ? (
					<section className="agent-save-auto__section">
						<h3 className="agent-save-auto__heading">{t("saveAuto.params.heading")}</h3>
						<p className="agent-save-auto__blurb">{t("saveAuto.params.blurb")}</p>
						<ul className="agent-save-auto__params" data-testid="agent-save-automation-params">
							{draft.parameters.map((param) => (
								<li key={param.example} className="agent-save-auto__param">
									<code className="agent-save-auto__token">{param.token}</code>
									<span className="agent-save-auto__example">
										{t("saveAuto.params.example", { value: param.example })}
									</span>
								</li>
							))}
						</ul>
					</section>
				) : null}

				<section className="agent-save-auto__section">
					<h3 className="agent-save-auto__heading">{t("saveAuto.caps.heading")}</h3>
					<p className="agent-save-auto__blurb">{t("saveAuto.caps.blurb")}</p>
					<ul className="agent-save-auto__caps" data-testid="agent-save-automation-caps">
						{draft.workflow.capabilities.map((cap) => (
							<li key={cap} className="agent-save-auto__cap">
								<code>{cap}</code>
							</li>
						))}
					</ul>
				</section>

				<div className="agent-save-auto__actions">
					<button
						type="button"
						className="bs-btn"
						onClick={onClose}
						data-testid="agent-save-automation-cancel"
					>
						{t("saveAuto.cancel")}
					</button>
					<button
						type="button"
						className="bs-btn"
						data-bs-primary=""
						disabled={saving}
						onClick={onConfirm}
						data-testid="agent-save-automation-confirm"
					>
						{saving ? t("saveAuto.saving") : t("saveAuto.confirm")}
					</button>
				</div>
			</div>
		</Popover>
	);
}
