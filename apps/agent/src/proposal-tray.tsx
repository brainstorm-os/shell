/**
 * Agent-11b — the preview-confirm tray (the hero surface).
 *
 * When the agent proposes vault artifacts in a turn, they land here as editable
 * cards ABOVE the composer: the user reviews each draft, tweaks it if the model
 * got a field wrong, then approves (persists) or discards. Nothing is written
 * until the user hits "Add to vault" — the approve button IS the human gesture
 * that exercises `entities.write:<type>` (the injection mitigation). The card is
 * pure presentation over the {@link ProposedArtifact} buffer; the create + the
 * field-merge live in `app.tsx` (so the write cap stays on a user gesture).
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import type { AgentI18nKey } from "./i18n";
import { t } from "./i18n";
import { PROPOSE_DESCRIPTORS, ProposeKind, type ProposedArtifact } from "./logic/propose-artifacts";

const KIND_LABEL_KEY: Record<ProposeKind, AgentI18nKey> = {
	[ProposeKind.Note]: "propose.kind.note",
	[ProposeKind.Task]: "propose.kind.task",
	[ProposeKind.Event]: "propose.kind.event",
	[ProposeKind.Bookmark]: "propose.kind.bookmark",
	[ProposeKind.Contact]: "propose.kind.contact",
};

const KIND_ICON: Record<ProposeKind, IconName> = {
	[ProposeKind.Note]: IconName.KindFile,
	[ProposeKind.Task]: IconName.CheckCircle,
	[ProposeKind.Event]: IconName.KindDate,
	[ProposeKind.Bookmark]: IconName.KindLink,
	[ProposeKind.Contact]: IconName.AddressBook,
};

const descriptorFor = (artifact: ProposedArtifact) =>
	PROPOSE_DESCRIPTORS.find((d) => d.kind === artifact.kind) ?? null;

export type ProposalTrayProps = {
	proposals: readonly ProposedArtifact[];
	/** Ids currently being persisted (approve in flight) — disables the card. */
	busyIds: ReadonlySet<string>;
	onApprove: (artifact: ProposedArtifact) => void;
	onDiscard: (id: string) => void;
	onEditField: (id: string, field: string, value: string) => void;
};

function ProposalCard({
	artifact,
	busy,
	onApprove,
	onDiscard,
	onEditField,
}: {
	artifact: ProposedArtifact;
	busy: boolean;
	onApprove: (artifact: ProposedArtifact) => void;
	onDiscard: (id: string) => void;
	onEditField: (id: string, field: string, value: string) => void;
}): ReactElement | null {
	const descriptor = descriptorFor(artifact);
	if (!descriptor) return null;
	const kindLabel = t(KIND_LABEL_KEY[artifact.kind]);
	const primaryEmpty = !(artifact.fields[descriptor.primaryField] ?? "").trim();

	return (
		<div
			className="agent-proposal"
			role="group"
			aria-label={t("propose.card.aria", { kind: kindLabel, summary: artifact.summary })}
			data-testid="agent-proposal"
			data-kind={artifact.kind}
		>
			<div className="agent-proposal__head">
				<span className="agent-proposal__kind">
					<Icon name={KIND_ICON[artifact.kind]} size={13} />
					{kindLabel}
				</span>
			</div>
			<div className="agent-proposal__fields">
				{descriptor.fields.map((field) => {
					const multiline = descriptor.longFields.includes(field);
					const value = artifact.fields[field] ?? "";
					const fieldLabel = t(`propose.field.${field}` as AgentI18nKey);
					const inputId = `${artifact.id}-${field}`;
					return (
						<label key={field} className="agent-proposal__field" htmlFor={inputId}>
							<span className="agent-proposal__field-label">{fieldLabel}</span>
							{multiline ? (
								<textarea
									id={inputId}
									className="bs-input bs-input--multiline agent-proposal__input"
									value={value}
									rows={3}
									disabled={busy}
									onChange={(e) => onEditField(artifact.id, field, e.target.value)}
								/>
							) : (
								<input
									id={inputId}
									type="text"
									className="bs-input agent-proposal__input"
									value={value}
									disabled={busy}
									onChange={(e) => onEditField(artifact.id, field, e.target.value)}
								/>
							)}
						</label>
					);
				})}
			</div>
			<div className="agent-proposal__actions">
				<button
					type="button"
					className="agent-proposal__btn agent-proposal__btn--approve"
					disabled={busy || primaryEmpty}
					onClick={() => onApprove(artifact)}
					data-testid="agent-proposal-approve"
				>
					<Icon name={IconName.Check} size={13} />
					{t("propose.card.approve")}
				</button>
				<button
					type="button"
					className="agent-proposal__btn"
					disabled={busy}
					onClick={() => onDiscard(artifact.id)}
					data-testid="agent-proposal-discard"
				>
					{t("propose.card.discard")}
				</button>
			</div>
		</div>
	);
}

export function ProposalTray({
	proposals,
	busyIds,
	onApprove,
	onDiscard,
	onEditField,
}: ProposalTrayProps): ReactElement | null {
	if (proposals.length === 0) return null;
	return (
		<section className="agent-proposal-tray" aria-label={t("propose.tray.title")}>
			<header className="agent-proposal-tray__head">
				<span className="agent-proposal-tray__title">
					<Icon name={IconName.Sparkle} size={13} />
					{t("propose.tray.title")}
				</span>
				<span className="agent-proposal-tray__subtitle">{t("propose.tray.subtitle")}</span>
			</header>
			{proposals.map((artifact) => (
				<ProposalCard
					key={artifact.id}
					artifact={artifact}
					busy={busyIds.has(artifact.id)}
					onApprove={onApprove}
					onDiscard={onDiscard}
					onEditField={onEditField}
				/>
			))}
		</section>
	);
}
