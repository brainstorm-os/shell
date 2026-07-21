/**
 * Agent-7 — the long-term-memory manager (scope + redaction). Built on the
 * shared `@brainstorm-os/sdk/popover` + `.bs-btn` primitives (no bespoke chrome).
 * Pure presentation over the pure helpers in `logic/memory.ts`; the parent owns
 * the opt-in flag persistence and the cap-checked entity writes.
 *
 * PRIVACY (the surface for the user's control): an OFF-by-default opt-in
 * toggle, a list of every stored memory with per-row edit (redact) + delete,
 * and a clear-all. The user sees + controls everything; nothing is stored
 * without an explicit user action (parent gates writes on the toggle).
 */

import { Checkbox } from "@brainstorm-os/sdk/checkbox";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { Popover, PopoverSize } from "@brainstorm-os/sdk/popover";
import { useState } from "react";
import type { ReactElement } from "react";
import { t } from "./i18n";
import type { MemoryItem } from "./logic/memory";

export type MemoryPopoverProps = {
	enabled: boolean;
	memories: readonly MemoryItem[];
	onClose: () => void;
	onToggleEnabled: (enabled: boolean) => void;
	onEdit: (entityId: string, text: string) => void;
	onDelete: (entityId: string) => void;
	onClearAll: () => void;
};

function MemoryRow({
	memory,
	onEdit,
	onDelete,
}: {
	memory: MemoryItem;
	onEdit: (entityId: string, text: string) => void;
	onDelete: (entityId: string) => void;
}): ReactElement {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(memory.text);

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next && next !== memory.text) onEdit(memory.entityId, next);
		else setDraft(memory.text);
	};

	return (
		<li className="agent-memory__row" data-testid="agent-memory-row">
			{editing ? (
				<input
					type="text"
					className="bs-input bs-input--sm agent-memory__edit"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commit();
						} else if (e.key === "Escape") {
							e.preventDefault();
							setDraft(memory.text);
							setEditing(false);
						}
					}}
					aria-label={t("memory.edit.label")}
					data-testid="agent-memory-edit"
					// biome-ignore lint/a11y/noAutofocus: a row enters edit only on explicit user click.
					autoFocus
				/>
			) : (
				<span className="agent-memory__text">{memory.text}</span>
			)}
			<div className="agent-memory__row-actions">
				<button
					type="button"
					className="bs-btn bs-btn--icon bs-btn--ghost"
					onClick={() => {
						setDraft(memory.text);
						setEditing(true);
					}}
					aria-label={t("memory.edit.label")}
					title={t("memory.edit.label")}
				>
					<Icon name={IconName.Pencil} size={14} />
				</button>
				<button
					type="button"
					className="bs-btn bs-btn--icon bs-btn--ghost"
					onClick={() => onDelete(memory.entityId)}
					aria-label={t("memory.delete")}
					title={t("memory.delete")}
					data-testid="agent-memory-delete"
				>
					<Icon name={IconName.Trash} size={14} />
				</button>
			</div>
		</li>
	);
}

export function MemoryPopover({
	enabled,
	memories,
	onClose,
	onToggleEnabled,
	onEdit,
	onDelete,
	onClearAll,
}: MemoryPopoverProps): ReactElement {
	return (
		<Popover
			title={t("memory.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			testId="agent-memory"
		>
			<div className="agent-settings">
				<section className="agent-settings__section">
					<p className="agent-settings__blurb">{t("memory.blurb")}</p>
					<Checkbox
						label={t("memory.enable")}
						checked={enabled}
						onChange={onToggleEnabled}
						testId="agent-memory-enabled"
					/>
				</section>

				<section className="agent-settings__section">
					<div className="agent-memory__list-head">
						<h3 className="agent-settings__heading">{t("memory.list.heading")}</h3>
						{memories.length > 0 ? (
							<button
								type="button"
								className="bs-btn bs-btn--ghost bs-btn--danger"
								onClick={onClearAll}
								data-testid="agent-memory-clear-all"
							>
								{t("memory.clearAll")}
							</button>
						) : null}
					</div>
					{memories.length === 0 ? (
						<p className="agent-settings__empty">{t("memory.list.empty")}</p>
					) : (
						<ul className="agent-memory__list">
							{memories.map((m) => (
								<MemoryRow key={m.entityId} memory={m} onEdit={onEdit} onDelete={onDelete} />
							))}
						</ul>
					)}
				</section>
			</div>
		</Popover>
	);
}
