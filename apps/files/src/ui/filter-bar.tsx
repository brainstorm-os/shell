/**
 * The property-filter row (9.8.16): Kind · Size · Modified · Extension, each
 * a shared `<SelectMenu>`, plus Clear. Lives under the toolbar band; the
 * toolbar's Filter toggle shows it, and it stays up while any filter is
 * active so a narrowed list is never unexplained.
 */

import { CountBadge, CountBadgeTone } from "@brainstorm-os/sdk/count-badge";
import type { RelativeDateRange } from "@brainstorm-os/sdk/predicate-eval";
import { SelectMenu, type SelectMenuOption } from "@brainstorm-os/sdk/select-menu";
import { type ReactNode, useMemo } from "react";
import { type TranslationKey, t } from "../i18n";
import {
	type FileFilters,
	KIND_FILTERS,
	KindFilter,
	MODIFIED_RANGES,
	SIZE_FILTERS,
	SizeFilter,
	countActiveFilters,
} from "../logic/filters";

/** SelectMenu values are strings; "any" for the nullable axes is the empty
 *  string, which no real extension or range token can collide with. */
const ANY = "";

const KIND_LABEL_KEY: Record<KindFilter, TranslationKey> = {
	[KindFilter.Any]: "brainstorm.files.filter.any",
	[KindFilter.Folder]: "brainstorm.files.filter.kind.folder",
	[KindFilter.Image]: "brainstorm.files.filter.kind.image",
	[KindFilter.Document]: "brainstorm.files.filter.kind.document",
	[KindFilter.Audio]: "brainstorm.files.filter.kind.audio",
	[KindFilter.Video]: "brainstorm.files.filter.kind.video",
	[KindFilter.Archive]: "brainstorm.files.filter.kind.archive",
	[KindFilter.Other]: "brainstorm.files.filter.kind.other",
};

const SIZE_LABEL_KEY: Record<SizeFilter, TranslationKey> = {
	[SizeFilter.Any]: "brainstorm.files.filter.any",
	[SizeFilter.Tiny]: "brainstorm.files.filter.size.tiny",
	[SizeFilter.Small]: "brainstorm.files.filter.size.small",
	[SizeFilter.Medium]: "brainstorm.files.filter.size.medium",
	[SizeFilter.Large]: "brainstorm.files.filter.size.large",
	[SizeFilter.Huge]: "brainstorm.files.filter.size.huge",
};

function modifiedLabelKey(range: RelativeDateRange): TranslationKey {
	return `brainstorm.files.filter.modified.${range}` as TranslationKey;
}

export function FilterToggleButton({
	open,
	filters,
	onToggle,
}: {
	open: boolean;
	filters: FileFilters;
	onToggle(): void;
}) {
	const active = countActiveFilters(filters);
	return (
		<button
			type="button"
			className="bs-btn bs-btn--secondary toolbar__filter"
			data-testid="toolbar-filter"
			aria-pressed={open}
			aria-controls="files-filterbar"
			data-bs-tooltip={t("brainstorm.files.filter.toggle")}
			onClick={onToggle}
		>
			<span>{t("brainstorm.files.filter.label")}</span>
			{active > 0 ? <CountBadge count={active} tone={CountBadgeTone.Accent} /> : null}
		</button>
	);
}

export function FilterBar({
	filters,
	extensions,
	onChange,
	onClear,
}: {
	filters: FileFilters;
	extensions: readonly string[];
	onChange(patch: Partial<FileFilters>): void;
	onClear(): void;
}) {
	const kindOptions = useMemo<readonly SelectMenuOption<KindFilter>[]>(
		() => KIND_FILTERS.map((kind) => ({ value: kind, label: t(KIND_LABEL_KEY[kind]) })),
		[],
	);
	const sizeOptions = useMemo<readonly SelectMenuOption<SizeFilter>[]>(
		() => SIZE_FILTERS.map((size) => ({ value: size, label: t(SIZE_LABEL_KEY[size]) })),
		[],
	);
	const modifiedOptions = useMemo<readonly SelectMenuOption<string>[]>(
		() => [
			{ value: ANY, label: t("brainstorm.files.filter.any") },
			...MODIFIED_RANGES.map((range) => ({ value: range, label: t(modifiedLabelKey(range)) })),
		],
		[],
	);
	const extensionOptions = useMemo<readonly SelectMenuOption<string>[]>(
		() => [
			{ value: ANY, label: t("brainstorm.files.filter.any") },
			...extensions.map((ext) => ({ value: ext, label: `.${ext}` })),
		],
		[extensions],
	);
	const active = countActiveFilters(filters) > 0;

	return (
		<div
			className="files-filterbar"
			id="files-filterbar"
			data-testid="filter-bar"
			role="group"
			aria-label={t("brainstorm.files.filter.label")}
		>
			<FilterField label={t("brainstorm.files.filter.kind")}>
				<SelectMenu<KindFilter>
					data-testid="filter-kind"
					ariaLabel={t("brainstorm.files.filter.kind")}
					value={filters.kind}
					options={kindOptions}
					onChange={(kind) => onChange({ kind })}
				/>
			</FilterField>
			<FilterField label={t("brainstorm.files.filter.size")}>
				<SelectMenu<SizeFilter>
					data-testid="filter-size"
					ariaLabel={t("brainstorm.files.filter.size")}
					value={filters.size}
					options={sizeOptions}
					onChange={(size) => onChange({ size })}
				/>
			</FilterField>
			<FilterField label={t("brainstorm.files.filter.modified")}>
				<SelectMenu<string>
					data-testid="filter-modified"
					ariaLabel={t("brainstorm.files.filter.modified")}
					value={filters.modified ?? ANY}
					options={modifiedOptions}
					onChange={(value) =>
						onChange({ modified: value === ANY ? null : (value as RelativeDateRange) })
					}
				/>
			</FilterField>
			<FilterField label={t("brainstorm.files.filter.extension")}>
				<SelectMenu<string>
					data-testid="filter-extension"
					ariaLabel={t("brainstorm.files.filter.extension")}
					value={filters.extension ?? ANY}
					options={extensionOptions}
					onChange={(value) => onChange({ extension: value === ANY ? null : value })}
				/>
			</FilterField>
			<button
				type="button"
				className="bs-btn bs-btn--ghost files-filterbar__clear"
				data-testid="filter-clear"
				disabled={!active}
				onClick={onClear}
			>
				{t("brainstorm.files.filter.clear")}
			</button>
		</div>
	);
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
	return (
		<span className="files-filterbar__field">
			<span className="files-filterbar__label" aria-hidden="true">
				{label}
			</span>
			{children}
		</span>
	);
}
