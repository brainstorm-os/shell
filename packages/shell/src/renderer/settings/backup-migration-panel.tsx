/**
 * Settings → Backup & Migration (IE-3).
 *
 * The dashboard surface over the IE-1 `.bsbundle` codec + the IE-2/IE-4 import
 * engine + the IE-5 Obsidian importer, via `window.brainstorm.importExport.*`
 * (privileged; apps never see it). Three flows:
 *   - Export: write the whole vault to a `.bsbundle` takeout (save dialog).
 *   - Import data: pick a JSON/JSONL/CSV/MD/HTML file → choose the target type →
 *     a non-destructive dry-run plan → interactive column remap (rename target
 *     property, toggle include) → commit, with the run report.
 *   - Import an Obsidian vault: pick a folder → choose the target type → commit
 *     (frontmatter → properties, [[wikilinks]]/![[embeds]] → links, #tags kept).
 *
 * Streaming/cancel + the "Migrating from…" connector picker are the IE-3 tail.
 *
 * Conventions: every label via `t(key)`; shared `<Button>` / `<TextField>` /
 * `<Icon>` primitives; outline-on-border focus per the shared rule.
 */

import { AnimatePresence } from "framer-motion";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type {
	ImportMappingEdit,
	ImportPlan,
	ImportRunReport,
	ImportSourcePreview,
} from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Icon, IconName } from "../ui/icon";
import { Popover } from "../ui/popover";
import { PopoverSize } from "../ui/popover-types";
import { TextField, TextFieldSize } from "../ui/text-field";
import "./backup-migration-panel.css";

/** One editable mapping row in the wizard (carries the inferred valueType for
 *  display alongside the user-editable property + include). */
type MappingRow = ImportMappingEdit & { readonly valueType: string };

type ImportPhase =
	| { kind: "idle" }
	| { kind: "picked"; source: ImportSourcePreview }
	| { kind: "planned"; source: ImportSourcePreview; plan: ImportPlan }
	| { kind: "done"; report: ImportRunReport };

export function BackupMigrationPanel() {
	return (
		<section className="settings__section backup-migration" data-testid="backup-migration-panel">
			<p className="settings__section-summary">{t("shell.settings.backupMigration.summary")}</p>
			<ExportSection />
			<ImportSection />
			<ObsidianSection />
			<NotionSection />
			<AnytypeSection />
		</section>
	);
}

/** Icon-led card header shared by every flow: an accent icon chip beside the
 *  title + one-line description. */
function SectionHead({ icon, title, hint }: { icon: IconName; title: string; hint: string }) {
	return (
		<div className="backup-migration__group-head">
			<span className="backup-migration__group-icon" aria-hidden="true">
				<Icon name={icon} size={18} />
			</span>
			<div className="backup-migration__group-text">
				<h4 className="backup-migration__group-title">{title}</h4>
				<p className="settings__hint">{hint}</p>
			</div>
		</div>
	);
}

/** Shared chrome for the three import flows: the configuration form (source
 *  line + target-type field + flow-specific extras) opens in the shared
 *  `<Popover>` over the cards, so a flow never expands its card inline. */
function ImportFlowPopover({
	title,
	formTestId,
	sourceLine,
	targetType,
	onTargetType,
	targetTypeHint,
	targetTypeTestId,
	footer,
	onClose,
	children,
}: {
	title: string;
	formTestId: string;
	sourceLine: ReactNode;
	targetType: string;
	onTargetType: (value: string) => void;
	targetTypeHint: string;
	targetTypeTestId: string;
	footer: ReactNode;
	onClose: () => void;
	children?: ReactNode;
}) {
	return (
		<Popover title={title} onClose={onClose} size={PopoverSize.Medium} footer={footer}>
			<div className="backup-migration__stack" data-testid={formTestId}>
				<p className="settings__hint">{sourceLine}</p>
				<TextField
					label={t("shell.settings.backupMigration.import.targetTypeLabel")}
					size={TextFieldSize.Sm}
					value={targetType}
					onChange={onTargetType}
					placeholder="brainstorm/Note/v1"
					hint={targetTypeHint}
					data-testid={targetTypeTestId}
				/>
				{children}
			</div>
		</Popover>
	);
}

// ---------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------

function ExportSection() {
	const [busy, setBusy] = useState(false);
	const [savedPath, setSavedPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const onExport = useCallback(async () => {
		setBusy(true);
		setError(null);
		setSavedPath(null);
		try {
			const result = await window.brainstorm.importExport.exportVault();
			if (result) setSavedPath(result.path);
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.backupMigration.export.failed"));
		} finally {
			setBusy(false);
		}
	}, []);

	return (
		<div className="backup-migration__group" data-testid="backup-migration-export">
			<SectionHead
				icon={IconName.Download}
				title={t("shell.settings.backupMigration.export.title")}
				hint={t("shell.settings.backupMigration.export.hint")}
			/>
			<Button
				variant={ButtonVariant.Primary}
				size={ButtonSize.Md}
				iconLeft={IconName.Download}
				loading={busy}
				onClick={() => void onExport()}
				data-testid="backup-migration-export-btn"
			>
				{t("shell.settings.backupMigration.export.action")}
			</Button>
			{savedPath && (
				<p className="settings__hint" data-testid="backup-migration-export-done">
					{t("shell.settings.backupMigration.export.done", { path: savedPath })}
				</p>
			)}
			{error && (
				<p className="settings__error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------

function ImportSection() {
	const [phase, setPhase] = useState<ImportPhase>({ kind: "idle" });
	const [targetType, setTargetType] = useState("");
	const [rows, setRows] = useState<readonly MappingRow[]>([]);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reset = useCallback(() => {
		setPhase({ kind: "idle" });
		setTargetType("");
		setRows([]);
		setError(null);
		setProgress(null);
	}, []);

	const editsFor = useCallback(
		(): ImportMappingEdit[] =>
			rows.map((r) => ({ column: r.column, property: r.property, include: r.include })),
		[rows],
	);

	const onPick = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const source = await window.brainstorm.importExport.pickSource();
			if (!source) return;
			setRows([]);
			setPhase({ kind: "picked", source });
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.backupMigration.import.pickFailed"));
		} finally {
			setBusy(false);
		}
	}, []);

	const onPlan = useCallback(async () => {
		if (phase.kind !== "picked") return;
		const type = targetType.trim();
		if (type.length === 0) {
			setError(t("shell.settings.backupMigration.import.typeRequired"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const [mapping, plan] = await Promise.all([
				window.brainstorm.importExport.previewMapping(type),
				window.brainstorm.importExport.plan(type),
			]);
			setRows(
				mapping.map((m) => ({
					column: m.column,
					property: m.property,
					include: m.include,
					valueType: m.valueType,
				})),
			);
			setPhase({ kind: "planned", source: phase.source, plan });
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.backupMigration.import.planFailed"));
		} finally {
			setBusy(false);
		}
	}, [phase, targetType]);

	const onRun = useCallback(async () => {
		if (phase.kind !== "planned") return;
		const type = targetType.trim();
		setBusy(true);
		setError(null);
		setProgress({ done: 0, total: phase.plan.total });
		const stopProgress = window.brainstorm.importExport.onProgress(setProgress);
		try {
			const report = await window.brainstorm.importExport.run(type, editsFor());
			setPhase({ kind: "done", report });
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.backupMigration.import.runFailed"));
		} finally {
			stopProgress();
			setProgress(null);
			setBusy(false);
		}
	}, [phase, targetType, editsFor]);

	const onCancelRun = useCallback(() => {
		void window.brainstorm.importExport.cancel();
	}, []);

	const updateRow = useCallback((column: string, patch: Partial<MappingRow>) => {
		setRows((prev) => prev.map((r) => (r.column === column ? { ...r, ...patch } : r)));
	}, []);

	return (
		<div className="backup-migration__group" data-testid="backup-migration-import">
			<SectionHead
				icon={IconName.KindFile}
				title={t("shell.settings.backupMigration.import.title")}
				hint={t("shell.settings.backupMigration.import.hint")}
			/>

			{phase.kind === "idle" && (
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Md}
					iconLeft={IconName.Folder}
					loading={busy}
					onClick={() => void onPick()}
					data-testid="backup-migration-import-pick"
				>
					{t("shell.settings.backupMigration.import.pick")}
				</Button>
			)}

			<AnimatePresence>
				{(phase.kind === "picked" || phase.kind === "planned") && (
					<ImportFlowPopover
						title={t("shell.settings.backupMigration.import.title")}
						formTestId="backup-migration-import-form"
						sourceLine={t("shell.settings.backupMigration.import.source", {
							file: phase.source.fileName,
							count: phase.source.recordCount,
						})}
						targetType={targetType}
						onTargetType={setTargetType}
						targetTypeHint={t("shell.settings.backupMigration.import.targetTypeHint")}
						targetTypeTestId="backup-migration-import-type"
						onClose={reset}
						footer={
							<>
								<Button variant={ButtonVariant.Neutral} size={ButtonSize.Sm} onClick={reset}>
									{t("shell.settings.backupMigration.import.cancel")}
								</Button>
								{phase.kind === "picked" ? (
									<Button
										variant={ButtonVariant.Primary}
										size={ButtonSize.Sm}
										loading={busy}
										onClick={() => void onPlan()}
										data-testid="backup-migration-import-preview"
									>
										{t("shell.settings.backupMigration.import.preview")}
									</Button>
								) : (
									<Button
										variant={ButtonVariant.Primary}
										size={ButtonSize.Sm}
										loading={busy}
										onClick={() => void onRun()}
										data-testid="backup-migration-import-run"
									>
										{t("shell.settings.backupMigration.import.run")}
									</Button>
								)}
							</>
						}
					>
						{phase.kind === "planned" && (
							<>
								<p className="settings__hint" data-testid="backup-migration-import-plan">
									{t("shell.settings.backupMigration.import.plan", {
										create: phase.plan.willCreate,
										update: phase.plan.willUpdate,
										total: phase.plan.total,
									})}
								</p>
								<MappingEditor rows={rows} onChange={updateRow} />
							</>
						)}
						{progress && (
							<div className="backup-migration__progress" data-testid="backup-migration-import-progress">
								<p className="settings__hint">
									{t("shell.settings.backupMigration.import.progress", {
										done: progress.done,
										total: progress.total,
									})}
								</p>
								<Button
									variant={ButtonVariant.Ghost}
									size={ButtonSize.Sm}
									onClick={onCancelRun}
									data-testid="backup-migration-import-stop"
								>
									{t("shell.settings.backupMigration.import.stop")}
								</Button>
							</div>
						)}
					</ImportFlowPopover>
				)}
			</AnimatePresence>

			{phase.kind === "done" && (
				<div className="backup-migration__stack" data-testid="backup-migration-import-done">
					<p className="settings__hint">
						<Icon name={IconName.CheckCircle} size={14} />{" "}
						{t("shell.settings.backupMigration.import.done", {
							created: phase.report.created,
							updated: phase.report.updated,
							failed: phase.report.failed.length,
						})}
					</p>
					<Button variant={ButtonVariant.Neutral} size={ButtonSize.Sm} onClick={reset}>
						{t("shell.settings.backupMigration.import.again")}
					</Button>
				</div>
			)}

			{error && (
				<p className="settings__error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------
// Obsidian vault import (IE-5)
// ---------------------------------------------------------------------

type ObsidianPhase =
	| { kind: "idle" }
	| { kind: "picked"; folderName: string; noteCount: number }
	| { kind: "done"; report: ImportRunReport };

function ObsidianSection() {
	const [phase, setPhase] = useState<ObsidianPhase>({ kind: "idle" });
	const [targetType, setTargetType] = useState("brainstorm/Note/v1");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onPick = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const source = await window.brainstorm.importExport.pickObsidian();
			if (!source) return;
			setPhase({ kind: "picked", folderName: source.folderName, noteCount: source.noteCount });
		} catch (e) {
			setError(
				e instanceof Error ? e.message : t("shell.settings.backupMigration.obsidian.pickFailed"),
			);
		} finally {
			setBusy(false);
		}
	}, []);

	const onRun = useCallback(async () => {
		const type = targetType.trim();
		if (type.length === 0) {
			setError(t("shell.settings.backupMigration.import.typeRequired"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const report = await window.brainstorm.importExport.runObsidian(type);
			setPhase({ kind: "done", report });
		} catch (e) {
			setError(
				e instanceof Error ? e.message : t("shell.settings.backupMigration.obsidian.runFailed"),
			);
		} finally {
			setBusy(false);
		}
	}, [targetType]);

	return (
		<div className="backup-migration__group" data-testid="backup-migration-obsidian">
			<SectionHead
				icon={IconName.Folder}
				title={t("shell.settings.backupMigration.obsidian.title")}
				hint={t("shell.settings.backupMigration.obsidian.hint")}
			/>

			{phase.kind === "idle" && (
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Md}
					iconLeft={IconName.Folder}
					loading={busy}
					onClick={() => void onPick()}
					data-testid="backup-migration-obsidian-pick"
				>
					{t("shell.settings.backupMigration.obsidian.pick")}
				</Button>
			)}

			<AnimatePresence>
				{phase.kind === "picked" && (
					<ImportFlowPopover
						title={t("shell.settings.backupMigration.obsidian.title")}
						formTestId="backup-migration-obsidian-form"
						sourceLine={t("shell.settings.backupMigration.obsidian.source", {
							folder: phase.folderName,
							count: phase.noteCount,
						})}
						targetType={targetType}
						onTargetType={setTargetType}
						targetTypeHint={t("shell.settings.backupMigration.obsidian.targetTypeHint")}
						targetTypeTestId="backup-migration-obsidian-type"
						onClose={() => setPhase({ kind: "idle" })}
						footer={
							<>
								<Button
									variant={ButtonVariant.Neutral}
									size={ButtonSize.Sm}
									onClick={() => setPhase({ kind: "idle" })}
								>
									{t("shell.settings.backupMigration.import.cancel")}
								</Button>
								<Button
									variant={ButtonVariant.Primary}
									size={ButtonSize.Sm}
									loading={busy}
									onClick={() => void onRun()}
									data-testid="backup-migration-obsidian-run"
								>
									{t("shell.settings.backupMigration.obsidian.run")}
								</Button>
							</>
						}
					/>
				)}
			</AnimatePresence>

			{phase.kind === "done" && (
				<p className="settings__hint" data-testid="backup-migration-obsidian-done">
					<Icon name={IconName.CheckCircle} size={14} />{" "}
					{t("shell.settings.backupMigration.import.done", {
						created: phase.report.created,
						updated: phase.report.updated,
						failed: phase.report.failed.length,
					})}
				</p>
			)}

			{error && (
				<p className="settings__error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------
// Anytype export import (IE-7)
// ---------------------------------------------------------------------

type AnytypePhase =
	| { kind: "idle" }
	| { kind: "picked"; archiveName: string; objectCount: number }
	| { kind: "done"; report: ImportRunReport };

function AnytypeSection() {
	const [phase, setPhase] = useState<AnytypePhase>({ kind: "idle" });
	const [targetType, setTargetType] = useState("brainstorm/Note/v1");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onPick = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const source = await window.brainstorm.importExport.pickAnytype();
			if (!source) return;
			setPhase({ kind: "picked", archiveName: source.archiveName, objectCount: source.objectCount });
		} catch (e) {
			setError(
				e instanceof Error ? e.message : t("shell.settings.backupMigration.anytype.pickFailed"),
			);
		} finally {
			setBusy(false);
		}
	}, []);

	const onRun = useCallback(async () => {
		const type = targetType.trim();
		if (type.length === 0) {
			setError(t("shell.settings.backupMigration.import.typeRequired"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const report = await window.brainstorm.importExport.runAnytype(type);
			setPhase({ kind: "done", report });
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.backupMigration.anytype.runFailed"));
		} finally {
			setBusy(false);
		}
	}, [targetType]);

	return (
		<div className="backup-migration__group" data-testid="backup-migration-anytype">
			<SectionHead
				icon={IconName.Archive}
				title={t("shell.settings.backupMigration.anytype.title")}
				hint={t("shell.settings.backupMigration.anytype.hint")}
			/>

			{phase.kind === "idle" && (
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Md}
					iconLeft={IconName.Archive}
					loading={busy}
					onClick={() => void onPick()}
					data-testid="backup-migration-anytype-pick"
				>
					{t("shell.settings.backupMigration.anytype.pick")}
				</Button>
			)}

			<AnimatePresence>
				{phase.kind === "picked" && (
					<ImportFlowPopover
						title={t("shell.settings.backupMigration.anytype.title")}
						formTestId="backup-migration-anytype-form"
						sourceLine={t("shell.settings.backupMigration.anytype.source", {
							archive: phase.archiveName,
							count: phase.objectCount,
						})}
						targetType={targetType}
						onTargetType={setTargetType}
						targetTypeHint={t("shell.settings.backupMigration.anytype.targetTypeHint")}
						targetTypeTestId="backup-migration-anytype-type"
						onClose={() => setPhase({ kind: "idle" })}
						footer={
							<>
								<Button
									variant={ButtonVariant.Neutral}
									size={ButtonSize.Sm}
									onClick={() => setPhase({ kind: "idle" })}
								>
									{t("shell.settings.backupMigration.import.cancel")}
								</Button>
								<Button
									variant={ButtonVariant.Primary}
									size={ButtonSize.Sm}
									loading={busy}
									onClick={() => void onRun()}
									data-testid="backup-migration-anytype-run"
								>
									{t("shell.settings.backupMigration.anytype.run")}
								</Button>
							</>
						}
					/>
				)}
			</AnimatePresence>

			{phase.kind === "done" && (
				<p className="settings__hint" data-testid="backup-migration-anytype-done">
					<Icon name={IconName.CheckCircle} size={14} />{" "}
					{t("shell.settings.backupMigration.import.done", {
						created: phase.report.created,
						updated: phase.report.updated,
						failed: phase.report.failed.length,
					})}
				</p>
			)}

			{error && (
				<p className="settings__error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------
// Notion export import (IE-6)
// ---------------------------------------------------------------------

type NotionPhase =
	| { kind: "idle" }
	| { kind: "picked"; archiveName: string; pageCount: number }
	| { kind: "done"; report: ImportRunReport };

function NotionSection() {
	const [phase, setPhase] = useState<NotionPhase>({ kind: "idle" });
	const [targetType, setTargetType] = useState("brainstorm/Note/v1");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onPick = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const source = await window.brainstorm.importExport.pickNotion();
			if (!source) return;
			setPhase({ kind: "picked", archiveName: source.archiveName, pageCount: source.pageCount });
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.backupMigration.notion.pickFailed"));
		} finally {
			setBusy(false);
		}
	}, []);

	const onRun = useCallback(async () => {
		const type = targetType.trim();
		if (type.length === 0) {
			setError(t("shell.settings.backupMigration.import.typeRequired"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const report = await window.brainstorm.importExport.runNotion(type);
			setPhase({ kind: "done", report });
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.backupMigration.notion.runFailed"));
		} finally {
			setBusy(false);
		}
	}, [targetType]);

	return (
		<div className="backup-migration__group" data-testid="backup-migration-notion">
			<SectionHead
				icon={IconName.Archive}
				title={t("shell.settings.backupMigration.notion.title")}
				hint={t("shell.settings.backupMigration.notion.hint")}
			/>

			{phase.kind === "idle" && (
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Md}
					iconLeft={IconName.Archive}
					loading={busy}
					onClick={() => void onPick()}
					data-testid="backup-migration-notion-pick"
				>
					{t("shell.settings.backupMigration.notion.pick")}
				</Button>
			)}

			<AnimatePresence>
				{phase.kind === "picked" && (
					<ImportFlowPopover
						title={t("shell.settings.backupMigration.notion.title")}
						formTestId="backup-migration-notion-form"
						sourceLine={t("shell.settings.backupMigration.notion.source", {
							archive: phase.archiveName,
							count: phase.pageCount,
						})}
						targetType={targetType}
						onTargetType={setTargetType}
						targetTypeHint={t("shell.settings.backupMigration.notion.targetTypeHint")}
						targetTypeTestId="backup-migration-notion-type"
						onClose={() => setPhase({ kind: "idle" })}
						footer={
							<>
								<Button
									variant={ButtonVariant.Neutral}
									size={ButtonSize.Sm}
									onClick={() => setPhase({ kind: "idle" })}
								>
									{t("shell.settings.backupMigration.import.cancel")}
								</Button>
								<Button
									variant={ButtonVariant.Primary}
									size={ButtonSize.Sm}
									loading={busy}
									onClick={() => void onRun()}
									data-testid="backup-migration-notion-run"
								>
									{t("shell.settings.backupMigration.notion.run")}
								</Button>
							</>
						}
					/>
				)}
			</AnimatePresence>

			{phase.kind === "done" && (
				<p className="settings__hint" data-testid="backup-migration-notion-done">
					<Icon name={IconName.CheckCircle} size={14} />{" "}
					{t("shell.settings.backupMigration.import.done", {
						created: phase.report.created,
						updated: phase.report.updated,
						failed: phase.report.failed.length,
					})}
				</p>
			)}

			{error && (
				<p className="settings__error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

function MappingEditor({
	rows,
	onChange,
}: {
	rows: readonly MappingRow[];
	onChange: (column: string, patch: Partial<MappingRow>) => void;
}) {
	if (rows.length === 0) return null;
	return (
		<table className="backup-migration__table" data-testid="backup-migration-mapping">
			<thead>
				<tr>
					<th>{t("shell.settings.backupMigration.import.mapping.include")}</th>
					<th>{t("shell.settings.backupMigration.import.mapping.column")}</th>
					<th>{t("shell.settings.backupMigration.import.mapping.property")}</th>
					<th>{t("shell.settings.backupMigration.import.mapping.type")}</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((r) => (
					<tr key={r.column} data-testid={`backup-migration-mapping-row-${r.column}`}>
						<td>
							<Checkbox
								checked={r.include}
								onChange={(next) => onChange(r.column, { include: next })}
								label=""
								aria-label={t("shell.settings.backupMigration.import.mapping.includeLabel", {
									column: r.column,
								})}
							/>
						</td>
						<td>{r.column}</td>
						<td>
							<TextField
								size={TextFieldSize.Sm}
								value={r.property}
								onChange={(next) => onChange(r.column, { property: next })}
								disabled={!r.include}
								aria-label={t("shell.settings.backupMigration.import.mapping.propertyLabel", {
									column: r.column,
								})}
							/>
						</td>
						<td>{r.valueType}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
