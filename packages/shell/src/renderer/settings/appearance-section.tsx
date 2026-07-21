/**
 * Settings → Appearance section. Implements
 * §Appearance modes & pair slots.
 *
 * Layout:
 *   1. Mode segmented control (Light / Dark / Auto). Auto follows the OS
 *      via `matchMedia("(prefers-color-scheme: dark)")` — the renderer
 *      watches it to drive the "currently resolves to" hint; the
 *      authoritative resolution still happens main-side (`nativeTheme`)
 *      so app windows pick up the right theme too.
 *   2. Two pair cards (Light slot + Dark slot). Each card is theme picker
 *      + wallpaper picker; the active slot (decided by mode + OS) gets a
 *      highlight + "Active" badge.
 *
 * Mode + slot writes go through dedicated IPC (`setAppearanceMode`,
 * `setAppearancePair`); the existing `setTheme` / `setWallpaper` calls
 * still work (Marketplace and the simple flow) — they target the slot
 * matching the theme's declared `ThemeAppearance` (theme) or the active
 * slot (wallpaper).
 */

import {
	AppearanceMode,
	AppearanceSlot,
	effectiveSlotFor,
} from "@brainstorm-os/protocol/appearance";
import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import {
	ThemeAppearance,
	type ThemeCatalogEntry,
	type ThemeName,
	themeCatalog,
} from "@brainstorm-os/tokens";
import { useCallback, useEffect, useState } from "react";
import type { AppearancePair, DashboardWallpaper } from "../../preload";
import { onSystemPreferenceChange, systemPrefersDark } from "../dashboard/appearance-watcher";
import { useDashboard } from "../dashboard/use-dashboard";
import { wallpaperBackground } from "../dashboard/wallpaper";
import { t } from "../i18n/t";
import { Icon, IconName } from "../ui/icon";
import { WallpaperKind } from "./wallpaper-kind";

type Preset = { id: string; labelKey: string; wallpaper: DashboardWallpaper };

// Wallpapers are theme-independent so every preset is a fixed value, but
// the user-visible label flows through `t()` per the i18n rule (every
// user-visible string wraps in `t(key)` — see CLAUDE.md). The keys are
// declared in `renderer/i18n/t.ts` under `shell.settings.appearance.preset.*`.
const SOLID_PRESETS: readonly Preset[] = [
	{
		id: "obsidian",
		labelKey: "shell.settings.appearance.preset.obsidian",
		wallpaper: solid("#14161b"),
	},
	{
		id: "graphite",
		labelKey: "shell.settings.appearance.preset.graphite",
		wallpaper: solid("#2a2d33"),
	},
	{ id: "ink", labelKey: "shell.settings.appearance.preset.ink", wallpaper: solid("#0b1220") },
	{ id: "paper", labelKey: "shell.settings.appearance.preset.paper", wallpaper: solid("#f5f3ef") },
	{ id: "moss", labelKey: "shell.settings.appearance.preset.moss", wallpaper: solid("#1f3a2b") },
	{ id: "sand", labelKey: "shell.settings.appearance.preset.sand", wallpaper: solid("#d6c7a8") },
];

const GRADIENT_PRESETS: readonly Preset[] = [
	{
		id: "aurora",
		labelKey: "shell.settings.appearance.preset.aurora",
		wallpaper: gradient("linear-gradient(135deg, #4a90ff 0%, #22d3ee 50%, #16a34a 100%)"),
	},
	{
		id: "sunset",
		labelKey: "shell.settings.appearance.preset.sunset",
		wallpaper: gradient("linear-gradient(135deg, #fbbf24 0%, #f87171 60%, #6b21a8 100%)"),
	},
	{
		id: "midnight",
		labelKey: "shell.settings.appearance.preset.midnight",
		wallpaper: gradient(
			"radial-gradient(ellipse at 30% 20%, #1e3a8a 0%, transparent 50%), radial-gradient(ellipse at 80% 80%, #6b21a8 0%, transparent 55%), linear-gradient(180deg, #0b1220 0%, #1d2436 100%)",
		),
	},
	{
		id: "forest",
		labelKey: "shell.settings.appearance.preset.forest",
		wallpaper: gradient("linear-gradient(180deg, #14532d 0%, #064e3b 100%)"),
	},
	{
		id: "fog",
		labelKey: "shell.settings.appearance.preset.fog",
		wallpaper: gradient("linear-gradient(180deg, #e2e8f0 0%, #cbd5e1 100%)"),
	},
	{
		id: "ember",
		labelKey: "shell.settings.appearance.preset.ember",
		wallpaper: gradient(
			"radial-gradient(ellipse at 50% 100%, #dc2626 0%, transparent 60%), linear-gradient(180deg, #1c1917 0%, #292524 100%)",
		),
	},
];

function solid(value: string): DashboardWallpaper {
	return { kind: WallpaperKind.Solid, value };
}

function gradient(value: string): DashboardWallpaper {
	return { kind: WallpaperKind.Gradient, value };
}

const SLOT_BY_APPEARANCE: Record<ThemeAppearance, AppearanceSlot> = {
	[ThemeAppearance.Light]: AppearanceSlot.Light,
	[ThemeAppearance.Dark]: AppearanceSlot.Dark,
};

type UploadedWallpaper = { url: string; thumbUrl: string };

export function AppearanceSection() {
	const snapshot = useDashboard();
	const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());
	const [uploaded, setUploaded] = useState<readonly UploadedWallpaper[]>([]);

	const refreshUploaded = useCallback(async () => {
		const list = await window.brainstorm.dashboard.listWallpapers();
		setUploaded(list);
	}, []);

	useEffect(() => {
		void refreshUploaded();
	}, [refreshUploaded]);

	useEffect(() => onSystemPreferenceChange(setPrefersDark), []);

	if (!snapshot) {
		return <p className="settings__loading">{t("shell.common.loading")}</p>;
	}

	const { appearance } = snapshot;
	const effectiveSlot = effectiveSlotFor(appearance.mode, prefersDark);

	const setMode = (mode: AppearanceMode) => {
		if (mode === appearance.mode) return;
		void window.brainstorm.dashboard.setAppearanceMode(mode);
	};

	const setSlotTheme = (slot: AppearanceSlot, theme: ThemeName) => {
		const current = slot === AppearanceSlot.Dark ? appearance.dark : appearance.light;
		const next: AppearancePair = { theme, wallpaper: current.wallpaper };
		void window.brainstorm.dashboard.setAppearancePair(slot, next);
	};

	const setSlotWallpaper = (slot: AppearanceSlot, wallpaper: DashboardWallpaper) => {
		const current = slot === AppearanceSlot.Dark ? appearance.dark : appearance.light;
		const next: AppearancePair = { theme: current.theme, wallpaper };
		void window.brainstorm.dashboard.setAppearancePair(slot, next);
	};

	const uploadImage = async (slot: AppearanceSlot) => {
		const result = await window.brainstorm.dashboard.uploadWallpaper();
		if (result?.url) {
			setSlotWallpaper(slot, { kind: WallpaperKind.Image, value: result.url });
			await refreshUploaded();
		}
	};

	return (
		<>
			<section className="settings__section">
				<p className="settings__section-summary">{t("shell.settings.appearance.summary")}</p>
				<ModeSegmented mode={appearance.mode} onChange={setMode} />
			</section>

			<section className="settings__section">
				<div className="settings__appearance-pairs">
					<PairCard
						slot={AppearanceSlot.Light}
						pair={appearance.light}
						active={effectiveSlot === AppearanceSlot.Light}
						uploaded={uploaded}
						onPickTheme={(theme) => setSlotTheme(AppearanceSlot.Light, theme)}
						onPickWallpaper={(wp) => setSlotWallpaper(AppearanceSlot.Light, wp)}
						onUpload={() => void uploadImage(AppearanceSlot.Light)}
					/>
					<PairCard
						slot={AppearanceSlot.Dark}
						pair={appearance.dark}
						active={effectiveSlot === AppearanceSlot.Dark}
						uploaded={uploaded}
						onPickTheme={(theme) => setSlotTheme(AppearanceSlot.Dark, theme)}
						onPickWallpaper={(wp) => setSlotWallpaper(AppearanceSlot.Dark, wp)}
						onUpload={() => void uploadImage(AppearanceSlot.Dark)}
					/>
				</div>
			</section>
		</>
	);
}

function ModeSegmented({
	mode,
	onChange,
}: {
	mode: AppearanceMode;
	onChange: (mode: AppearanceMode) => void;
}) {
	const options: ReadonlyArray<{ id: AppearanceMode; labelKey: string; icon: IconName }> = [
		{
			id: AppearanceMode.Light,
			labelKey: "shell.settings.appearance.mode.light",
			icon: IconName.Sun,
		},
		{ id: AppearanceMode.Dark, labelKey: "shell.settings.appearance.mode.dark", icon: IconName.Moon },
		{
			id: AppearanceMode.Auto,
			labelKey: "shell.settings.appearance.mode.auto",
			icon: IconName.AppearanceAuto,
		},
	];
	// KBN: appearance mode is a horizontal radiogroup — ←/→ move + select
	// (aria-checked via the hook); roles flow through useCompositeKeyboard.
	const selectMode = (index: number) => {
		const option = options[index];
		if (option) onChange(option.id);
	};
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: options.length,
		activeIndex: options.findIndex((option) => option.id === mode),
		onActiveIndexChange: selectMode,
		onActivate: selectMode,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.AriaChecked,
	});
	return (
		<div className="settings__appearance-mode">
			<div
				className="settings__segmented"
				{...containerProps}
				aria-label={t("shell.settings.appearance.mode.label")}
			>
				{options.map((option, index) => (
					<button
						key={option.id}
						type="button"
						{...getItemProps(index)}
						className={
							mode === option.id
								? "settings__segmented-option settings__segmented-option--selected"
								: "settings__segmented-option"
						}
						onClick={() => onChange(option.id)}
					>
						<Icon name={option.icon} size={14} />
						<span>{t(option.labelKey)}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function PairCard({
	slot,
	pair,
	active,
	uploaded,
	onPickTheme,
	onPickWallpaper,
	onUpload,
}: {
	slot: AppearanceSlot;
	pair: AppearancePair;
	active: boolean;
	uploaded: readonly UploadedWallpaper[];
	onPickTheme: (theme: ThemeName) => void;
	onPickWallpaper: (wp: DashboardWallpaper) => void;
	onUpload: () => void;
}) {
	const titleKey =
		slot === AppearanceSlot.Light
			? "shell.settings.appearance.slot.light"
			: "shell.settings.appearance.slot.dark";
	const slotIcon = slot === AppearanceSlot.Light ? IconName.Sun : IconName.Moon;
	const themes = themeCatalog.filter((entry) => SLOT_BY_APPEARANCE[entry.appearance] === slot);
	const themeEntry = themeCatalog.find((entry) => entry.id === pair.theme);
	const previewWallpaper = previewWallpaperFor(pair.wallpaper, uploaded);
	return (
		<article
			className={
				active
					? "settings__appearance-pair settings__appearance-pair--active"
					: "settings__appearance-pair"
			}
			data-slot={slot}
		>
			<PairPreview wallpaper={previewWallpaper} themePreview={themeEntry?.preview ?? null} />
			<header className="settings__appearance-pair-header">
				<span className="settings__appearance-pair-title">
					<Icon name={slotIcon} size={14} />
					<span>{t(titleKey)}</span>
				</span>
				{active && (
					<span className="settings__appearance-pair-active">
						<Icon name={IconName.CheckCircle} size={12} />
						<span>{t("shell.settings.appearance.slot.active")}</span>
					</span>
				)}
			</header>

			<div className="settings__appearance-pair-section">
				<p className="settings__appearance-pair-label">
					{t("shell.settings.appearance.slot.themeLabel")}
				</p>
				<div className="settings__appearance-theme-list">
					{themes.map((entry) => (
						<ThemeChip
							key={entry.id}
							entry={entry}
							selected={entry.id === pair.theme}
							onPick={() => onPickTheme(entry.id)}
						/>
					))}
				</div>
			</div>

			<div className="settings__appearance-pair-section">
				<p className="settings__appearance-pair-label">
					{t("shell.settings.appearance.slot.wallpaperLabel")}
				</p>
				<WallpaperGrid
					current={pair.wallpaper}
					uploaded={uploaded}
					onPick={onPickWallpaper}
					onUpload={onUpload}
				/>
			</div>
		</article>
	);
}

/** Live preview band at the top of each pair card — the slot's actual
 *  wallpaper with a miniaturised "window" overlay sampling the theme's
 *  surface + accent colors so the user sees what the pair looks like before
 *  it goes live. Composes the same `wallpaperBackground` the dashboard uses
 *  so a gradient/image preset previews exactly as it'll render. */
function PairPreview({
	wallpaper,
	themePreview,
}: {
	wallpaper: DashboardWallpaper;
	themePreview: { background: string; surface: string; accent: string; text: string } | null;
}) {
	return (
		<div
			className="settings__appearance-pair-preview"
			aria-hidden="true"
			style={{ background: wallpaperBackground(wallpaper) }}
		>
			{themePreview && (
				<span
					className="settings__appearance-pair-preview-window"
					style={{ background: themePreview.surface, color: themePreview.text }}
				>
					<span
						className="settings__appearance-pair-preview-line"
						style={{ background: themePreview.text }}
					/>
					<span
						className="settings__appearance-pair-preview-line settings__appearance-pair-preview-line--short"
						style={{ background: themePreview.text }}
					/>
					<span
						className="settings__appearance-pair-preview-accent"
						style={{ background: themePreview.accent }}
					/>
				</span>
			)}
		</div>
	);
}

function ThemeChip({
	entry,
	selected,
	onPick,
}: {
	entry: ThemeCatalogEntry;
	selected: boolean;
	onPick: () => void;
}) {
	const label = t(entry.labelKey);
	return (
		<button
			type="button"
			className={
				selected
					? "settings__appearance-theme-chip settings__appearance-theme-chip--selected"
					: "settings__appearance-theme-chip"
			}
			aria-label={t("shell.settings.themes.pick", { label })}
			aria-pressed={selected}
			onClick={onPick}
			data-theme-id={entry.id}
		>
			<span
				className="settings__appearance-theme-swatch"
				style={{ background: entry.preview.background }}
				aria-hidden="true"
			>
				<span
					className="settings__appearance-theme-swatch-accent"
					style={{ background: entry.preview.accent }}
				/>
			</span>
			<span className="settings__appearance-theme-chip-label">{label}</span>
		</button>
	);
}

function WallpaperGrid({
	current,
	uploaded,
	onPick,
	onUpload,
}: {
	current: DashboardWallpaper;
	uploaded: readonly UploadedWallpaper[];
	onPick: (wp: DashboardWallpaper) => void;
	onUpload: () => void;
}) {
	const isMatch = (w: DashboardWallpaper) => current.kind === w.kind && current.value === w.value;
	return (
		<div className="settings__appearance-wallpapers">
			<div className="settings__swatch-grid">
				{SOLID_PRESETS.map((preset) => (
					<MiniSwatch
						key={`s-${preset.id}`}
						preset={preset}
						selected={isMatch(preset.wallpaper)}
						onPick={() => onPick(preset.wallpaper)}
					/>
				))}
				{GRADIENT_PRESETS.map((preset) => (
					<MiniSwatch
						key={`g-${preset.id}`}
						preset={preset}
						selected={isMatch(preset.wallpaper)}
						onPick={() => onPick(preset.wallpaper)}
					/>
				))}
				{uploaded.map((entry) => (
					<button
						key={`u-${entry.url}`}
						type="button"
						className={
							current.kind === WallpaperKind.Image && current.value === entry.url
								? "settings__swatch settings__swatch--selected settings__swatch--uploaded"
								: "settings__swatch settings__swatch--uploaded"
						}
						aria-pressed={current.kind === WallpaperKind.Image && current.value === entry.url}
						aria-label={t("shell.settings.wallpaper.applyUploaded")}
						onClick={() => onPick({ kind: WallpaperKind.Image, value: entry.url })}
					>
						<span
							className="settings__swatch-fill"
							style={{ background: `center / cover no-repeat url(${cssUrl(entry.thumbUrl)})` }}
							aria-hidden="true"
						/>
					</button>
				))}
				<button
					type="button"
					className="settings__swatch settings__swatch--upload"
					onClick={onUpload}
					aria-label={t("shell.settings.wallpaper.imageUpload")}
					title={t("shell.settings.wallpaper.imageUpload")}
				>
					<span className="settings__swatch-fill settings__swatch-fill--upload" aria-hidden="true">
						<Icon name={IconName.Plus} size={20} />
					</span>
				</button>
			</div>
		</div>
	);
}

function MiniSwatch({
	preset,
	selected,
	onPick,
}: {
	preset: Preset;
	selected: boolean;
	onPick: () => void;
}) {
	const label = t(preset.labelKey);
	return (
		<button
			type="button"
			className={selected ? "settings__swatch settings__swatch--selected" : "settings__swatch"}
			onClick={onPick}
			aria-label={label}
			aria-pressed={selected}
			title={label}
		>
			<span
				className="settings__swatch-fill"
				style={{ background: wallpaperBackground(preset.wallpaper) }}
				aria-hidden="true"
			/>
		</button>
	);
}

function cssUrl(value: string | undefined | null): string {
	const safe = value ?? "";
	return `"${safe.replace(/"/g, '\\"')}"`;
}

/** Substitute the uploaded-cover thumb for the full-resolution image when
 *  rendering the slot preview. A 4K wallpaper decoded twice per Settings
 *  open (Light + Dark slot) was the dominant frame-time hit; the thumb URL
 *  is what the swatch grid already uses below. Falls through unchanged for
 *  solid / gradient / unmatched-image kinds. */
function previewWallpaperFor(
	wallpaper: DashboardWallpaper,
	uploaded: readonly UploadedWallpaper[],
): DashboardWallpaper {
	if (wallpaper.kind !== WallpaperKind.Image) return wallpaper;
	const match = uploaded.find((entry) => entry.url === wallpaper.value);
	if (!match) return wallpaper;
	return { kind: WallpaperKind.Image, value: match.thumbUrl };
}
