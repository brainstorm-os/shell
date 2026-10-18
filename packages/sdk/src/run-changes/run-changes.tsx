/**
 * `<RunChanges>` (Agent-15) — the shared "what this agent run changed" list
 * and its one-click "Undo this run". Rendered by the Agent app beside a
 * conversation and by Settings → AI → Agent activity in a run's detail, so
 * both read identically.
 *
 * A leaf component: the host fetches the diff and performs the undo (each
 * through its own authorized path — the app-facing `agent-trace` service, or
 * the privileged Settings bridge) and passes already-translated labels, since
 * the shell renderer and sandboxed apps use different `t()`s. Every value
 * rendered here arrives pre-bounded and control-stripped from the shell, and
 * renders as React text — never markup.
 *
 * Accessibility: the list is a labelled `<ul>`; each object title is a native
 * button when the host can open it; the undo is a native button whose result
 * (done / refused with the reason) lands in a `role="status"` line.
 */

import {
	type AgentFieldChange,
	type AgentRunChanges,
	AgentUndoRefusal,
	type AgentUndoResult,
	AgentWriteKind,
} from "@brainstorm-os/sdk-types";
import { type ReactElement, useState } from "react";
import { Icon, IconName } from "../icon";

export type RunChangesLabels = {
	heading: string;
	empty: string;
	untitled: string;
	oversize: string;
	kind: Readonly<Record<AgentWriteKind, string>>;
	/** One field row: `before` / `after` are bounded previews or null. */
	field: (key: string, before: string | null, after: string | null) => string;
	lines: (added: number, removed: number) => string;
	more: (count: number) => string;
	undo: string;
	undoing: string;
	undone: string;
	/** The sentence for a refused undo; `field` names the blocking field when
	 *  one is known. */
	refusal: (reason: AgentUndoRefusal, field: string | null) => string;
	failed: string;
};

export type RunChangesProps = {
	changes: AgentRunChanges;
	labels: RunChangesLabels;
	onOpenEntity?: (entityId: string) => void;
	/** Omit to render a read-only diff (no undo affordance). */
	onUndo?: () => Promise<AgentUndoResult>;
	/** Called after a successful undo so the host can refetch. */
	onUndone?: () => void;
	testId?: string;
};

const KIND_ICON: Readonly<Record<AgentWriteKind, IconName>> = {
	[AgentWriteKind.Created]: IconName.Plus,
	[AgentWriteKind.Updated]: IconName.Pencil,
	[AgentWriteKind.Trashed]: IconName.Trash,
};

function FieldRow({
	field,
	labels,
}: { field: AgentFieldChange; labels: RunChangesLabels }): ReactElement {
	return (
		<li className="bs-run-changes__field">
			<span>{labels.field(field.key, field.before, field.after)}</span>
			{field.lines ? (
				<span className="bs-run-changes__lines">
					{labels.lines(field.lines.added, field.lines.removed)}
				</span>
			) : null}
		</li>
	);
}

export function RunChanges({
	changes,
	labels,
	onOpenEntity,
	onUndo,
	onUndone,
	testId,
}: RunChangesProps): ReactElement {
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const undone = changes.revertedAt !== null;

	const runUndo = async (): Promise<void> => {
		if (!onUndo || busy) return;
		setBusy(true);
		setStatus(null);
		try {
			const result = await onUndo();
			if (result.ok) {
				setStatus(labels.undone);
				onUndone?.();
			} else {
				setStatus(labels.refusal(result.reason, result.field));
			}
		} catch {
			setStatus(labels.failed);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			className="bs-run-changes"
			aria-label={labels.heading}
			data-testid={testId ?? "run-changes"}
		>
			<h4 className="bs-run-changes__heading">{labels.heading}</h4>
			{changes.changes.length === 0 ? (
				<p className="bs-run-changes__empty">{labels.empty}</p>
			) : (
				<ul className="bs-run-changes__list">
					{changes.changes.map((change, i) => {
						const title = change.title ?? labels.untitled;
						return (
							<li
								key={`${change.entityId}:${change.at}:${i}`}
								className="bs-run-changes__item"
								data-kind={change.kind}
							>
								<div className="bs-run-changes__item-head">
									<Icon name={KIND_ICON[change.kind]} size={12} />
									<span className="bs-run-changes__kind">{labels.kind[change.kind]}</span>
									{onOpenEntity ? (
										<button
											type="button"
											className="bs-run-changes__title"
											onClick={() => onOpenEntity(change.entityId)}
										>
											{title}
										</button>
									) : (
										<span className="bs-run-changes__title">{title}</span>
									)}
								</div>
								{change.oversize ? (
									<p className="bs-run-changes__note">{labels.oversize}</p>
								) : change.fields.length > 0 ? (
									<ul className="bs-run-changes__fields">
										{change.fields.map((field) => (
											<FieldRow key={field.key} field={field} labels={labels} />
										))}
										{change.moreFields > 0 ? (
											<li className="bs-run-changes__field">{labels.more(change.moreFields)}</li>
										) : null}
									</ul>
								) : null}
							</li>
						);
					})}
					{changes.moreChanges > 0 ? (
						<li className="bs-run-changes__item">{labels.more(changes.moreChanges)}</li>
					) : null}
				</ul>
			)}
			{onUndo && changes.changes.length > 0 ? (
				<div className="bs-run-changes__actions">
					<button
						type="button"
						className="bs-btn bs-btn--neutral"
						disabled={busy || undone}
						onClick={() => void runUndo()}
					>
						{undone ? labels.undone : busy ? labels.undoing : labels.undo}
					</button>
					{status ? (
						<p className="bs-run-changes__status" role="status">
							{status}
						</p>
					) : null}
				</div>
			) : null}
		</section>
	);
}

/** Exhaustive refusal → label-key mapping a host can use to build
 *  {@link RunChangesLabels.refusal} from its own catalog. */
export const RUN_UNDO_REFUSAL_KEYS: Readonly<Record<AgentUndoRefusal, string>> = {
	[AgentUndoRefusal.NotFound]: "notFound",
	[AgentUndoRefusal.NothingToUndo]: "nothingToUndo",
	[AgentUndoRefusal.AlreadyUndone]: "alreadyUndone",
	[AgentUndoRefusal.EditedSince]: "editedSince",
	[AgentUndoRefusal.Purged]: "purged",
	[AgentUndoRefusal.InBin]: "inBin",
	[AgentUndoRefusal.Locked]: "locked",
	[AgentUndoRefusal.Denied]: "denied",
	[AgentUndoRefusal.NotRecorded]: "notRecorded",
};
