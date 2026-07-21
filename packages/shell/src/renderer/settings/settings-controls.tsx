/**
 * Small shared controls for the settings-overhaul sections (Interface,
 * Language & Region, Notifications). Extracted because all three sections need
 * the same labelled-row + dropdown shapes — three call sites, so it lives here
 * rather than being copied (CLAUDE.md DRY rule).
 *
 * Enumerated choices ride the shared select control
 * (`@brainstorm-os/sdk/select-menu` — fancy-menus chrome, keyboard model, a11y).
 * Booleans use the shared `<Checkbox>`. Every visible string is passed in
 * already-translated by the caller via `t()`.
 */

import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import { useEffect, useId, useState } from "react";
import { CheckboxGlyph } from "../ui/checkbox";

type Option<T extends string> = {
	value: T;
	label: string;
};

/** A labelled row: title + optional description on the left, control on the
 *  right. The shared layout for every settings line in these sections. */
export function SettingRow({
	title,
	description,
	control,
	htmlFor,
}: {
	title: string;
	description?: string;
	control: React.ReactNode;
	htmlFor?: string;
}) {
	return (
		<div className="setting-row">
			<div className="setting-row__text">
				{htmlFor ? (
					<label className="setting-row__title" htmlFor={htmlFor}>
						{title}
					</label>
				) : (
					<span className="setting-row__title">{title}</span>
				)}
				{description ? <span className="setting-row__desc">{description}</span> : null}
			</div>
			<div className="setting-row__control">{control}</div>
		</div>
	);
}

/** A boolean settings line where the WHOLE row is the click target: the row
 *  is the `<label>` for a single checkbox, so clicking the title, the empty
 *  space, or the painted box all toggle it (a 18px box alone read as
 *  "unclickable"). Keyboard focus + Space land on the hidden input; the focus
 *  ring rides the painted box via the shared checkbox sheet. */
export function ToggleRow({
	title,
	description,
	checked,
	onChange,
	disabled = false,
	ariaLabel,
}: {
	title: string;
	description?: string;
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	ariaLabel?: string;
}) {
	// Reflect the click immediately rather than waiting for the async write to
	// round-trip back through the dashboard snapshot push. The snapshot stays the
	// source of truth — this local mirror reconciles to it whenever `checked`
	// changes — but the box no longer reads as "unclickable" while the push is in
	// flight (or when a stale, un-restarted main process never pushes at all).
	const [optimistic, setOptimistic] = useState(checked);
	useEffect(() => setOptimistic(checked), [checked]);
	const toggle = (next: boolean) => {
		setOptimistic(next);
		onChange(next);
	};

	const className = disabled
		? "setting-row setting-row--toggle setting-row--disabled"
		: "setting-row setting-row--toggle";
	return (
		<label className={className}>
			<span className="setting-row__text">
				<span className="setting-row__title">{title}</span>
				{description ? <span className="setting-row__desc">{description}</span> : null}
			</span>
			<span className="setting-row__control">
				<input
					type="checkbox"
					className="checkbox__input"
					checked={optimistic}
					disabled={disabled}
					onChange={(event) => toggle(event.target.checked)}
					{...(ariaLabel ? { "aria-label": ariaLabel } : {})}
				/>
				<CheckboxGlyph checked={optimistic} />
			</span>
		</label>
	);
}

/** A labelled dropdown for enumerated choices. Returns its own id so a
 *  paired `<SettingRow htmlFor>` can target it. */
export function SettingSelect<T extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	id,
}: {
	value: T;
	options: readonly Option<T>[];
	onChange: (next: T) => void;
	ariaLabel: string;
	id?: string;
}) {
	const fallbackId = useId();
	return (
		<SelectMenu
			id={id ?? fallbackId}
			className="setting-select"
			value={value}
			options={options}
			onChange={onChange}
			ariaLabel={ariaLabel}
		/>
	);
}
