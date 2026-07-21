/**
 * F-241 / doc 75 — the "Add to note" picker. Opened from an assistant
 * message's action row; the user chooses WHAT to file (the reply's content,
 * or just a link to this chat) and WHICH note, then the host dispatches the
 * cap-checked `insert` intent (see `logic/insert-to-note.ts`). Pure
 * presentation over the pure candidate filter — the parent owns the vault
 * snapshot and the dispatch.
 *
 * Keyboard path: the search input auto-focuses; ArrowUp/ArrowDown move the
 * active row, Enter picks it, Escape closes (shared `<Popover>` behaviour).
 * Rows are real buttons, so Tab + Enter works without the arrow keys too.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { Popover, PopoverSize } from "@brainstorm-os/sdk/popover";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { t } from "./i18n";
import { AddToNoteMode, type NoteCandidate, noteCandidates } from "./logic/insert-to-note";

export type AddToNotePopoverProps = {
	/** The vault snapshot the candidate filter runs over. */
	entities: readonly { id: string; type: string; properties: Record<string, unknown> }[];
	onClose: () => void;
	onPick: (note: NoteCandidate, mode: AddToNoteMode) => void;
};

export function AddToNotePopover({
	entities,
	onClose,
	onPick,
}: AddToNotePopoverProps): ReactElement {
	const [mode, setMode] = useState<AddToNoteMode>(AddToNoteMode.InsertReply);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const candidates = useMemo(() => noteCandidates(entities, query), [entities, query]);
	const active = candidates[Math.min(activeIndex, candidates.length - 1)];

	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	// Clamp the active row when the filter shrinks the list.
	useEffect(() => {
		setActiveIndex((i) => Math.max(0, Math.min(i, candidates.length - 1)));
	}, [candidates.length]);

	const modeButton = (value: AddToNoteMode, label: string) => (
		<button
			type="button"
			className="bs-btn bs-btn--sm agent-insert__mode"
			aria-pressed={mode === value}
			onClick={() => setMode(value)}
			data-testid={`agent-insert-mode-${value}`}
		>
			{label}
		</button>
	);

	return (
		<Popover
			title={t("insert.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			testId="agent-insert-popover"
		>
			<div className="agent-insert">
				<div className="agent-insert__modes" role="group" aria-label={t("insert.mode.label")}>
					{modeButton(AddToNoteMode.InsertReply, t("insert.mode.reply"))}
					{modeButton(AddToNoteMode.LinkChat, t("insert.mode.link"))}
				</div>
				<p className="agent-insert__hint">
					{mode === AddToNoteMode.InsertReply ? t("insert.hint.reply") : t("insert.hint.link")}
				</p>
				<input
					ref={inputRef}
					type="text"
					className="bs-input bs-input--sm agent-insert__search"
					placeholder={t("insert.search.placeholder")}
					aria-label={t("insert.search.label")}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActiveIndex(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setActiveIndex((i) => Math.min(i + 1, candidates.length - 1));
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							setActiveIndex((i) => Math.max(i - 1, 0));
						} else if (e.key === "Enter" && active) {
							e.preventDefault();
							onPick(active, mode);
						}
					}}
				/>
				{candidates.length === 0 ? (
					<p className="agent-insert__empty">{t("insert.empty")}</p>
				) : (
					<ul className="agent-insert__list" data-testid="agent-insert-list">
						{candidates.map((note, i) => (
							<li key={note.id}>
								<button
									type="button"
									className="agent-insert__row"
									data-active={active?.id === note.id ? "true" : "false"}
									onMouseEnter={() => setActiveIndex(i)}
									onClick={() => onPick(note, mode)}
									data-testid="agent-insert-row"
								>
									<Icon name={IconName.KindFile} size={14} />
									<span className="agent-insert__row-title">{note.title}</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</Popover>
	);
}
