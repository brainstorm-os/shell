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

import {
	PROPOSE_DESCRIPTORS,
	ProposeKind,
	type ProposedArtifact,
	type RowColumn,
} from "@brainstorm-os/sdk-types";
import type { ThemedToken } from "@brainstorm-os/sdk/code-highlight";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { languageDisplayLabel, shikiIdForLanguage } from "@brainstorm-os/sdk/language-detect";
import { ProposalTraySection } from "@brainstorm-os/sdk/proposal-tray";
import { type ReactElement, useEffect, useState } from "react";
import type { AgentI18nKey } from "./i18n";
import { t } from "./i18n";
import {
	CodeFileConflictChoice,
	type CodeFilePathRow,
	findCodeFilePathConflict,
	nextFreeCodeFilePath,
} from "./logic/code-file-conflict";
import { rowCellKey } from "./logic/propose-database";

const KIND_LABEL_KEY: Record<ProposeKind, AgentI18nKey> = {
	[ProposeKind.Note]: "propose.kind.note",
	[ProposeKind.Task]: "propose.kind.task",
	[ProposeKind.Event]: "propose.kind.event",
	[ProposeKind.Bookmark]: "propose.kind.bookmark",
	[ProposeKind.Contact]: "propose.kind.contact",
	[ProposeKind.Row]: "propose.kind.row",
	[ProposeKind.Database]: "propose.kind.database",
	[ProposeKind.CodeFile]: "propose.kind.codeFile",
};

const KIND_ICON: Record<ProposeKind, IconName> = {
	[ProposeKind.Note]: IconName.KindFile,
	[ProposeKind.Task]: IconName.CheckCircle,
	[ProposeKind.Event]: IconName.KindDate,
	[ProposeKind.Bookmark]: IconName.KindLink,
	[ProposeKind.Contact]: IconName.AddressBook,
	[ProposeKind.Row]: IconName.Entity,
	[ProposeKind.Database]: IconName.KindDictionary,
	// No dedicated code glyph in the shared IconName set yet — KindText reads
	// as "text content" and stays distinct from the Note card's KindFile.
	[ProposeKind.CodeFile]: IconName.KindText,
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
	if (artifact.codeFile) {
		// The content edits nowhere — the card previews it read-only (below);
		// only the filename is an editable line.
		return {
			fields: [{ key: "path", label: t("propose.field.path"), multiline: false }],
			primaryField: "path",
		};
	}
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
							className="bs-input bs-proposal__input"
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

/** Skip Shiki above this many code units — a huge draft previews as plain
 *  text instead of stalling the tray on tokenization. */
const PREVIEW_HIGHLIGHT_MAX = 20_000;

/**
 * AppForge-3 — the read-only, scroll-capped code preview on a proposed code
 * file. SECURITY: the content is untrusted model output and renders ONLY as
 * React text nodes (never markup), so injection-shaped content stays inert.
 * Highlighting is progressive enhancement: the Shiki tokenizer is
 * dynamic-imported (keeps shiki out of the agent's initial chunk) and any
 * failure — or an unhighlightable language — degrades to the same plain text.
 */
function CodeFilePreview({ artifact }: { artifact: ProposedArtifact }): ReactElement | null {
	const language = artifact.codeFile?.language;
	const content = artifact.fields.content ?? "";
	const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);

	useEffect(() => {
		if (!language || content.length === 0 || content.length > PREVIEW_HIGHLIGHT_MAX) {
			setTokens(null);
			return;
		}
		const shikiId = shikiIdForLanguage(language);
		if (!shikiId) {
			setTokens(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const shiki = await import("@brainstorm-os/sdk/code-highlight");
				const dark =
					shiki.shellAppearanceDark() ??
					(typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
				const theme = dark ? shiki.HighlightTheme.Dark : shiki.HighlightTheme.Light;
				const result = await shiki.tokenizeShiki(content, shikiId, theme);
				if (!cancelled) setTokens(result);
			} catch {
				// Plain-text fallback — the preview never blocks on the highlighter.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [content, language]);

	if (!artifact.codeFile) return null;
	return (
		<pre
			className="agent-proposal__code"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll-capped region must be keyboard-focusable to scroll (WCAG scrollable-region-focusable); role="region" + aria-label name it.
			tabIndex={0}
			role="region"
			aria-label={t("propose.codeFile.preview", { path: artifact.fields.path ?? "" })}
			data-testid="agent-proposal-code"
		>
			{tokens ? (
				<code>
					{tokens.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and the list fully re-renders on content change.
						<span key={i}>
							{line.map((token, j) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: same — tokens are positional within their line.
								<span key={j} style={token.color ? { color: token.color } : undefined}>
									{token.content}
								</span>
							))}
							{"\n"}
						</span>
					))}
				</code>
			) : (
				<code>{content}</code>
			)}
		</pre>
	);
}

export type ProposalTrayProps = {
	proposals: readonly ProposedArtifact[];
	/** Ids currently being persisted (approve in flight) — disables the card. */
	busyIds: ReadonlySet<string>;
	/** POLISH-FN-4 — every code file the app can see (vault snapshot + anything
	 *  persisted this session). A code-file card whose path is already taken
	 *  says so BEFORE approval and offers the two named outcomes instead of the
	 *  plain Add button, because a silent overwrite and a silent rename are both
	 *  surprises and the tray exists precisely so the user decides. */
	existingCodeFiles?: readonly CodeFilePathRow[];
	onApprove: (artifact: ProposedArtifact, choice?: CodeFileConflictChoice) => void;
	onDiscard: (id: string) => void;
	onEditField: (id: string, field: string, value: string) => void;
};

function ProposalCard({
	artifact,
	busy,
	existingCodeFiles,
	onApprove,
	onDiscard,
	onEditField,
}: {
	artifact: ProposedArtifact;
	busy: boolean;
	existingCodeFiles: readonly CodeFilePathRow[];
	onApprove: (artifact: ProposedArtifact, choice?: CodeFileConflictChoice) => void;
	onDiscard: (id: string) => void;
	onEditField: (id: string, field: string, value: string) => void;
}): ReactElement | null {
	const layout = cardFields(artifact);
	if (!layout) return null;
	const kindLabel = t(KIND_LABEL_KEY[artifact.kind]);
	const primaryEmpty = !(artifact.fields[layout.primaryField] ?? "").trim();
	// Recomputed on every keystroke in the path field, so renaming the draft is
	// the third way out of the conflict and the card clears the moment it is.
	const draftPath = artifact.fields.path ?? "";
	const conflict = artifact.codeFile ? findCodeFilePathConflict(existingCodeFiles, draftPath) : null;
	const copyPath = conflict ? nextFreeCodeFilePath(existingCodeFiles, draftPath) : "";

	return (
		<div
			className="bs-proposal"
			role="group"
			aria-label={t("propose.card.aria", { kind: kindLabel, summary: artifact.summary })}
			data-testid="agent-proposal"
			data-kind={artifact.kind}
		>
			<div className="bs-proposal__head">
				<span className="bs-proposal__kind">
					<Icon name={KIND_ICON[artifact.kind]} size={13} />
					{kindLabel}
				</span>
				{artifact.row ? (
					<span className="bs-proposal__meta" data-testid="agent-proposal-database">
						{t("propose.row.into", { database: artifact.row.databaseName })}
					</span>
				) : null}
				{artifact.codeFile ? (
					<span className="agent-proposal__language" data-testid="agent-proposal-language">
						{languageDisplayLabel(artifact.codeFile.language)}
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
					artifact.row ? "bs-proposal__fields agent-proposal__fields--row" : "bs-proposal__fields"
				}
			>
				{layout.fields.map((field) => {
					const value = artifact.fields[field.key] ?? "";
					const inputId = `${artifact.id}-${field.key}`;
					return (
						<label key={field.key} className="bs-proposal__field" htmlFor={inputId}>
							<span className="bs-proposal__field-label">{field.label}</span>
							{field.multiline ? (
								<textarea
									id={inputId}
									className="bs-input bs-input--multiline bs-proposal__input"
									value={value}
									rows={3}
									disabled={busy}
									onChange={(e) => onEditField(artifact.id, field.key, e.target.value)}
								/>
							) : (
								<input
									id={inputId}
									type="text"
									className="bs-input bs-proposal__input"
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
			{artifact.codeFile ? <CodeFilePreview artifact={artifact} /> : null}
			{conflict ? (
				<p className="agent-proposal__conflict" role="status" data-testid="agent-proposal-conflict">
					<Icon name={IconName.Warning} size={13} />
					{t("propose.codeFile.conflict", { path: conflict.path })}
				</p>
			) : null}
			<div className="bs-proposal__actions">
				{conflict ? (
					<>
						<button
							type="button"
							className="bs-btn"
							data-bs-primary=""
							disabled={busy}
							onClick={() => onApprove(artifact, CodeFileConflictChoice.Update)}
							data-testid="agent-proposal-update"
						>
							<Icon name={IconName.Check} size={13} />
							{t("propose.codeFile.update")}
						</button>
						<button
							type="button"
							className="bs-btn"
							disabled={busy}
							onClick={() => onApprove(artifact, CodeFileConflictChoice.SaveCopy)}
							data-testid="agent-proposal-save-copy"
						>
							{t("propose.codeFile.saveCopy", { path: copyPath })}
						</button>
					</>
				) : (
					<button
						type="button"
						className="bs-btn"
						data-bs-primary=""
						disabled={busy || primaryEmpty}
						onClick={() => onApprove(artifact)}
						data-testid="agent-proposal-approve"
					>
						<Icon name={IconName.Check} size={13} />
						{t("propose.card.approve")}
					</button>
				)}
				<button
					type="button"
					className="bs-btn"
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
	existingCodeFiles = [],
	onApprove,
	onDiscard,
	onEditField,
}: ProposalTrayProps): ReactElement | null {
	if (proposals.length === 0) return null;
	return (
		<ProposalTraySection
			icon={<Icon name={IconName.Sparkle} size={13} />}
			title={t("propose.tray.title")}
			subtitle={t("propose.tray.subtitle")}
		>
			{proposals.map((artifact) => (
				<ProposalCard
					key={artifact.id}
					artifact={artifact}
					busy={busyIds.has(artifact.id)}
					existingCodeFiles={existingCodeFiles}
					onApprove={onApprove}
					onDiscard={onDiscard}
					onEditField={onEditField}
				/>
			))}
		</ProposalTraySection>
	);
}
