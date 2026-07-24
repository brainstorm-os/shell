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
 *
 * Agent-11d adds the database-row card: same chrome, but its editable lines are
 * the TARGET DATABASE's own columns (carried on the artifact's `row` payload),
 * laid out as the row it will become — label column, value column.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import type { AgentI18nKey } from "./i18n";
import { t } from "./i18n";
import {
	PROPOSE_DESCRIPTORS,
	ProposeKind,
	type ProposedArtifact,
	type RowColumn,
} from "./logic/propose-artifacts";
import { rowCellKey } from "./logic/propose-database";

const KIND_LABEL_KEY: Record<ProposeKind, AgentI18nKey> = {
	[ProposeKind.Note]: "propose.kind.note",
	[ProposeKind.Task]: "propose.kind.task",
	[ProposeKind.Event]: "propose.kind.event",
	[ProposeKind.Bookmark]: "propose.kind.bookmark",
	[ProposeKind.Contact]: "propose.kind.contact",
	[ProposeKind.Row]: "propose.kind.row",
	[ProposeKind.Database]: "propose.kind.database",
};

const KIND_ICON: Record<ProposeKind, IconName> = {
	[ProposeKind.Note]: IconName.KindFile,
	[ProposeKind.Task]: IconName.CheckCircle,
	[ProposeKind.Event]: IconName.KindDate,
	[ProposeKind.Bookmark]: IconName.KindLink,
	[ProposeKind.Contact]: IconName.AddressBook,
	[ProposeKind.Row]: IconName.Entity,
	[ProposeKind.Database]: IconName.KindDictionary,
};

const descriptorFor = (artifact: ProposedArtifact) =>
	PROPOSE_DESCRIPTORS.find((d) => d.kind === artifact.kind) ?? null;

/** One editable line on a card: the field key, its label, and whether it takes
 *  a textarea. A simple entity's lines come from its descriptor; a database
 *  row's come from the target database's own columns (Agent-11d). */
type CardField = { key: string; label: string; multiline: boolean };

function cardFields(
	artifact: ProposedArtifact,
): { fields: CardField[]; primaryField: string } | null {
	if (artifact.database) {
		return {
			fields: [{ key: "name", label: t("propose.database.name"), multiline: false }],
			primaryField: "name",
		};
	}
	if (artifact.row) {
		return {
			fields: artifact.row.columns.map((column) => ({
				key: column.key,
				label: column.label,
				multiline: false,
			})),
			primaryField: artifact.row.columns[0]?.key ?? "",
		};
	}
	const descriptor = descriptorFor(artifact);
	if (!descriptor) return null;
	return {
		fields: descriptor.fields.map((field) => ({
			key: field,
			label: t(`propose.field.${field}` as AgentI18nKey),
			multiline: descriptor.longFields.includes(field),
		})),
		primaryField: descriptor.primaryField,
	};
}

/** Agent-11e — the seed-row grid of a proposed NEW database: a header row of
 *  column labels, then one editable input per cell. Read-only preview would be
 *  a weaker promise than every other card makes, so the cells edit in place
 *  (keyed by `rowCellKey`, exactly what the persist step reads back). */
function SeedRows({
	artifact,
	columns,
	rowCount,
	busy,
	onEditField,
}: {
	artifact: ProposedArtifact;
	columns: readonly RowColumn[];
	rowCount: number;
	busy: boolean;
	onEditField: (id: string, field: string, value: string) => void;
}): ReactElement | null {
	if (rowCount === 0) return null;
	return (
		<div
			className="agent-proposal__seed"
			style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
			data-testid="agent-proposal-seed-rows"
		>
			{columns.map((column) => (
				<span key={column.key} className="agent-proposal__seed-head">
					{column.label}
				</span>
			))}
			{Array.from({ length: rowCount }, (_, index) =>
				columns.map((column) => {
					const key = rowCellKey(index, column.key);
					return (
						<input
							key={key}
							type="text"
							className="bs-input agent-proposal__input"
							aria-label={`${column.label} ${index + 1}`}
							value={artifact.fields[key] ?? ""}
							disabled={busy}
							onChange={(e) => onEditField(artifact.id, key, e.target.value)}
						/>
					);
				}),
			)}
		</div>
	);
}

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
	const layout = cardFields(artifact);
	if (!layout) return null;
	const kindLabel = t(KIND_LABEL_KEY[artifact.kind]);
	const primaryEmpty = !(artifact.fields[layout.primaryField] ?? "").trim();

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
				{artifact.row ? (
					<span className="agent-proposal__target" data-testid="agent-proposal-database">
						{t("propose.row.into", { database: artifact.row.databaseName })}
					</span>
				) : null}
			</div>
			{artifact.database ? (
				<p className="agent-proposal__schema" data-testid="agent-proposal-schema">
					{t("propose.database.schema", {
						columns: artifact.database.columns.map((column) => column.label).join(", "),
					})}
				</p>
			) : null}
			<div
				className={
					artifact.row ? "agent-proposal__fields agent-proposal__fields--row" : "agent-proposal__fields"
				}
			>
				{layout.fields.map((field) => {
					const value = artifact.fields[field.key] ?? "";
					const inputId = `${artifact.id}-${field.key}`;
					return (
						<label key={field.key} className="agent-proposal__field" htmlFor={inputId}>
							<span className="agent-proposal__field-label">{field.label}</span>
							{field.multiline ? (
								<textarea
									id={inputId}
									className="bs-input bs-input--multiline agent-proposal__input"
									value={value}
									rows={3}
									disabled={busy}
									onChange={(e) => onEditField(artifact.id, field.key, e.target.value)}
								/>
							) : (
								<input
									id={inputId}
									type="text"
									className="bs-input agent-proposal__input"
									value={value}
									disabled={busy}
									onChange={(e) => onEditField(artifact.id, field.key, e.target.value)}
								/>
							)}
						</label>
					);
				})}
			</div>
			{artifact.database ? (
				<SeedRows
					artifact={artifact}
					columns={artifact.database.columns}
					rowCount={artifact.database.rowCount}
					busy={busy}
					onEditField={onEditField}
				/>
			) : null}
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
