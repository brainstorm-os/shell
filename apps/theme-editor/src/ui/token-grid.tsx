/**
 * The semantic-token editor grid. One section per token family; each row
 * shows the token name, a live **swatch that is itself the colour-picker
 * trigger** (colour tokens; clicking it opens the shared rich
 * `@brainstorm/sdk/color-picker` menu — a 2D area + hue + hex), an
 * authoritative text input, and a reset button shown only while the token
 * is overridden.
 *
 * Controlled inputs report edits up through `onChange` / `onReset`; the app
 * owns the `TokenSetDef` + live preview. Switching the base theme changes
 * the base column — the caller re-renders with fresh `baseVars`.
 *
 * KBN-A-theme-editor: the grid is a vertical listbox with an
 * `aria-activedescendant` cursor (real focus stays on the inputs via Tab),
 * so Arrow keys move the cursor without fighting editing.
 */

import type { TokenSetDef } from "@brainstorm/sdk-types";
import { type ColorPickerLabels, openColorPicker } from "@brainstorm/sdk/color-picker";
import { type ReactElement, useId, useRef, useState } from "react";
import { toColorInputValue } from "../logic/color-input";
import type { TokenSectionGroup } from "../logic/token-rows";
import { effectiveValue, isOverridden } from "../logic/token-set-edit";
import type { Translate } from "./translate";

function pickerLabels(t: Translate): ColorPickerLabels {
	return {
		hex: t("picker.hex"),
		apply: t("picker.apply"),
		cancel: t("picker.cancel"),
		saturationValue: t("picker.saturationValue"),
		hue: t("picker.hue"),
	};
}

export type TokenGridHandlers = {
	onChange(name: string, value: string): void;
	onReset(name: string): void;
};

export type TokenGridProps = {
	groups: TokenSectionGroup[];
	baseVars: Record<string, string>;
	set: TokenSetDef;
	t: Translate;
	handlers: TokenGridHandlers;
};

type FlatRow = { name: string; isColor: boolean };

export function TokenGrid({ groups, baseVars, set, t, handlers }: TokenGridProps): ReactElement {
	const flat: FlatRow[] = groups.flatMap((g) =>
		g.rows.map((r) => ({ name: r.name, isColor: r.isColor })),
	);
	const [cursor, setCursor] = useState(0);
	const idBase = useId();
	const rowId = (index: number): string => `${idBase}-row-${index}`;

	const onKeyDown = (event: React.KeyboardEvent): void => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setCursor((c) => Math.min(c + 1, flat.length - 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setCursor((c) => Math.max(c - 1, 0));
		}
	};

	let index = -1;
	return (
		<div
			className="te-grid"
			aria-label={t("grid.region")}
			role={/* kbn-roles-exempt: hand-rolled arrow-key nav */ "listbox"}
			tabIndex={0}
			aria-activedescendant={flat.length > 0 ? rowId(cursor) : undefined}
			onKeyDown={onKeyDown}
		>
			{groups.map((group) => (
				<div key={group.section}>
					<h2 className="te-grid__section">{group.section}</h2>
					{group.rows.map((row) => {
						index += 1;
						const i = index;
						return (
							<TokenRow
								key={row.name}
								id={rowId(i)}
								active={i === cursor}
								name={row.name}
								isColor={row.isColor}
								baseVars={baseVars}
								set={set}
								t={t}
								handlers={handlers}
							/>
						);
					})}
				</div>
			))}
		</div>
	);
}

function TokenRow({
	id,
	active,
	name,
	isColor,
	baseVars,
	set,
	t,
	handlers,
}: {
	id: string;
	active: boolean;
	name: string;
	isColor: boolean;
	baseVars: Record<string, string>;
	set: TokenSetDef;
	t: Translate;
	handlers: TokenGridHandlers;
}): ReactElement {
	const base = baseVars[name] ?? "";
	const value = effectiveValue(baseVars, set, name);
	const overridden = isOverridden(set, name);
	const swatchRef = useRef<HTMLButtonElement>(null);

	const onText = (next: string): void => {
		if (next.trim().length === 0) handlers.onReset(name);
		else handlers.onChange(name, next);
	};

	const openPicker = (): void => {
		const anchor = swatchRef.current;
		if (!anchor) return;
		// Snapshot the override state at open so dismissing without applying
		// (Cancel / Escape / outside-click) restores exactly what was there.
		const wasOverridden = overridden;
		const openingValue = value;
		openColorPicker({
			anchor,
			initial: toColorInputValue(openingValue),
			labels: pickerLabels(t),
			onPreview: (hex) => handlers.onChange(name, hex),
			onSelect: (hex) => handlers.onChange(name, hex),
			onCancel: () => {
				if (wasOverridden) handlers.onChange(name, openingValue);
				else handlers.onReset(name);
			},
		});
	};

	return (
		// biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant listbox — focus stays on the grid container, the options track selection only and are intentionally not in the tab order.
		<div
			id={id}
			role="option"
			aria-selected={active}
			className={overridden ? "te-row te-row--overridden" : "te-row"}
		>
			<code className="te-row__name">{name}</code>
			<div className="te-row__controls">
				{isColor && (
					<button
						ref={swatchRef}
						type="button"
						className="te-row__swatch"
						style={{ background: value }}
						data-bs-tooltip={t("grid.pickColor", { name })}
						aria-label={t("grid.pickColor", { name })}
						aria-haspopup="dialog"
						onClick={openPicker}
					/>
				)}
				<input
					type="text"
					className="bs-input bs-input--sm te-row__value"
					value={value}
					aria-label={name}
					spellCheck={false}
					onChange={(e) => onText(e.target.value)}
				/>
				<button
					type="button"
					className="te-row__reset"
					aria-label={t("grid.resetToken", { name })}
					onClick={() => handlers.onReset(name)}
				>
					{t("grid.reset")}
				</button>
			</div>
		</div>
	);
}
