/**
 * RichTextCell — the `ValueType.RichText` cell (9.12.26).
 *
 * The stored value is a {@link RichTextValue}: serialized compact-editor state
 * plus its plain-text projection. Where room is tight (a grid cell —
 * `CellPresentation.Compact`) the resting face is the one-line projection and
 * editing happens in an anchored popover; in an inspector row
 * (`CellPresentation.Expanded`) the full editor is mounted in place. The
 * editing surface itself is the host-injected `richTextEditor` seam (the
 * shared `CompactEditor`); without one, the cell edits the plain projection in
 * a textarea, so a RichText value is never uneditable.
 *
 * Writes persist when an editing session ends — popover close, or focus
 * leaving the expanded editor — and only if the value actually changed.
 */

import {
	CellPresentation,
	type CellProps,
	type RichTextValue,
	richTextPlain,
} from "@brainstorm-os/sdk-types";
import { type FocusEvent, type JSX, useCallback, useEffect, useRef } from "react";
import { usePropertyUiSeams } from "../use-properties";
import { CellPopover } from "./cell-popover";
import { InlineEditTextarea } from "./inline-edit-textarea";

function asRichText(value: unknown): RichTextValue | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return { text: value };
	if (typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
		const v = value as { text: string; state?: unknown };
		return typeof v.state === "string" ? { text: v.text, state: v.state } : { text: v.text };
	}
	return null;
}

function sameValue(a: RichTextValue | null, b: RichTextValue | null): boolean {
	return (a?.text ?? "") === (b?.text ?? "") && (a?.state ?? "") === (b?.state ?? "");
}

/** Normalises an edit to the stored shape: blank text clears the value. */
function toStored(next: RichTextValue): RichTextValue | null {
	return next.text.trim().length === 0 ? null : next;
}

/** Holds the latest edit of one session and persists it once, on `flush`. */
function useEditSession(
	initial: RichTextValue | null,
	onChange: (next: RichTextValue | null) => void,
): { record: (next: RichTextValue) => void; flush: () => void } {
	const latest = useRef<RichTextValue | null>(initial);
	const dirty = useRef(false);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const record = useCallback((next: RichTextValue) => {
		latest.current = toStored(next);
		dirty.current = true;
	}, []);
	const flush = useCallback(() => {
		if (!dirty.current) return;
		dirty.current = false;
		if (!sameValue(latest.current, initial)) onChangeRef.current(latest.current);
	}, [initial]);
	return { record, flush };
}

function RichTextSurface({
	initial,
	ariaLabel,
	toolbar,
	autoFocus,
	onRecord,
}: {
	initial: RichTextValue | null;
	ariaLabel: string;
	toolbar: boolean;
	autoFocus: boolean;
	onRecord: (next: RichTextValue) => void;
}): JSX.Element {
	const { richTextEditor: Editor } = usePropertyUiSeams();
	if (Editor) {
		return (
			<Editor
				initialValue={initial}
				ariaLabel={ariaLabel}
				toolbar={toolbar}
				autoFocus={autoFocus}
				onChange={onRecord}
			/>
		);
	}
	return (
		<InlineEditTextarea
			initialValue={initial?.text ?? ""}
			className="bs-cell-multiline-input"
			ariaLabel={ariaLabel}
			onCommit={(text) => onRecord({ text })}
			onCancel={() => undefined}
		/>
	);
}

/** Popover body: persists the session when the popover unmounts (closes). */
function PopoverEditor({
	initial,
	ariaLabel,
	onChange,
}: {
	initial: RichTextValue | null;
	ariaLabel: string;
	onChange: (next: RichTextValue | null) => void;
}): JSX.Element {
	const { record, flush } = useEditSession(initial, onChange);
	const flushRef = useRef(flush);
	flushRef.current = flush;
	useEffect(() => () => flushRef.current(), []);
	return (
		<div className="bs-cell-richtext-pop">
			<RichTextSurface
				initial={initial}
				ariaLabel={ariaLabel}
				toolbar={false}
				autoFocus
				onRecord={record}
			/>
		</div>
	);
}

function ExpandedEditor({
	initial,
	ariaLabel,
	onChange,
}: {
	initial: RichTextValue | null;
	ariaLabel: string;
	onChange: (next: RichTextValue | null) => void;
}): JSX.Element {
	const { record, flush } = useEditSession(initial, onChange);
	const flushRef = useRef(flush);
	flushRef.current = flush;
	useEffect(() => () => flushRef.current(), []);
	const onBlur = useCallback(
		(e: FocusEvent<HTMLDivElement>) => {
			const to = e.relatedTarget as Node | null;
			if (to && e.currentTarget.contains(to)) return;
			flush();
		},
		[flush],
	);
	return (
		<div className="bs-cell-richtext-editor" onBlur={onBlur}>
			<RichTextSurface
				initial={initial}
				ariaLabel={ariaLabel}
				toolbar
				autoFocus={false}
				onRecord={record}
			/>
		</div>
	);
}

export function RichTextCell(props: CellProps): JSX.Element {
	const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled, presentation } = props;
	const { labels } = usePropertyUiSeams();
	const initial = asRichText(value);
	const text = richTextPlain(initial);
	const ariaLabel = labels.cellEditValueFor(property.name);
	const commit = useCallback((next: RichTextValue | null) => onChange(next as never), [onChange]);

	const empty = text.trim().length === 0;
	if (presentation === CellPresentation.Expanded) {
		if (!readOnly) {
			return <ExpandedEditor initial={initial} ariaLabel={ariaLabel} onChange={commit} />;
		}
		return (
			<div className={empty ? "bs-cell-multiline bs-cell-multiline--empty" : "bs-cell-multiline"}>
				{empty ? labels.cellEmpty : text}
			</div>
		);
	}

	return (
		<CellPopover
			trigger={empty ? labels.cellEmpty : text}
			triggerClassName={empty ? "bs-cell-richtext bs-cell-richtext--empty" : "bs-cell-richtext"}
			triggerAriaLabel={ariaLabel}
			disabled={readOnly}
			panelAriaLabel={ariaLabel}
			panelClassName="bs-cell-richtext-panel"
			autoOpen={autoEdit}
			onAutoOpenHandled={onAutoEditHandled}
		>
			{() => <PopoverEditor initial={initial} ariaLabel={ariaLabel} onChange={commit} />}
		</CellPopover>
	);
}
