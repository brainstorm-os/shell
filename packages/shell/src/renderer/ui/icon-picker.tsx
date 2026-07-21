/**
 * IconPicker — universal icon-chooser for entities, properties, dictionary
 * items, vaults. Four sources:
 *   1. Emoji   — searchable, category-switched, skin-tone aware
 *   2. Icon    — Phosphor pack with tint via colour picker
 *   3. Upload  — drag-drop or file dialog → stores under <vault>/icons/
 *   4. Library — pick from previously uploaded
 *
 * Returns an `Icon | null` to the caller's `onChange`. Caller owns
 * persistence.
 *
 * Migrates to `@react-fancy-menus/core` along with every other anchored menu
 * (task #36) when Stage 8 lands.
 */

import { type Icon, IconKind, type SkinTone } from "@brainstorm-os/sdk-types";
import { SkinTone as ST } from "@brainstorm-os/sdk-types";
import {
	Orientation,
	SelectionAttribute,
	useCompositeKeyboard,
	useEscapeStackEntry,
} from "@brainstorm-os/sdk/a11y";
import { type ChangeEvent, type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import type { IconEntry } from "../../preload";
import { t } from "../i18n/t";
import { EMOJI_CATEGORIES, type EmojiEntry, emojiUrl, searchEmoji } from "./emoji-set";
import { EntityIcon } from "./entity-icon";
import { Icon as Glyph, IconName } from "./icon";
import "./icon-picker.css";
import { PHOSPHOR_GLYPHS, PHOSPHOR_PACK_ID, type PackGlyph, searchPhosphor } from "./icon-packs";

export type IconPickerProps = {
	value: Icon | null;
	onChange: (icon: Icon | null) => void;
	onClose: () => void;
};

enum PickerTab {
	Emoji = "emoji",
	Icon = "icon",
	Upload = "upload",
	Library = "library",
}

const PICKER_TABS: readonly PickerTab[] = [
	PickerTab.Emoji,
	PickerTab.Icon,
	PickerTab.Upload,
	PickerTab.Library,
];

/** People-category base emojis that accept Fitzpatrick modifiers. Keeping
 *  this hand-maintained for v1 — narrower set than full Unicode-supported
 *  list, but matches what's in our curated category. */
const SKIN_TONE_SUPPORTING = new Set([
	"👋",
	"👍",
	"👎",
	"👏",
	"🙏",
	"💪",
	"🤝",
	"✋",
	"🤚",
	"👶",
	"🧑",
]);

const TINT_PALETTE: readonly string[] = [
	"currentColor",
	"#6b73f0", // accent
	"#dc2626", // red
	"#ea580c", // orange
	"#ca8a04", // amber
	"#16a34a", // green
	"#0891b2", // cyan
	"#2563eb", // blue
	"#9333ea", // purple
	"#db2777", // pink
];

export function IconPicker({ value, onChange, onClose }: IconPickerProps) {
	useEscapeStackEntry({ onEscape: onClose, label: "icon-picker" });

	const [tab, setTab] = useState<PickerTab>(initialTabFor(value));
	const [search, setSearch] = useState("");
	const [skinTone, setSkinTone] = useState<SkinTone>(ST.None);
	const [tintColor, setTintColor] = useState<string>(packTint(value) ?? "currentColor");

	// KBN-S-pickers: the tab row is a horizontal tablist (←/→ move + activate),
	// so the role flows through the hook (drops the hand-written literals).
	const selectTab = (index: number) => {
		const next = PICKER_TABS[index];
		if (next !== undefined) {
			setTab(next);
			setSearch("");
		}
	};
	const { containerProps: tabsProps, getItemProps: getTabProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: PICKER_TABS.length,
		activeIndex: PICKER_TABS.indexOf(tab),
		onActiveIndexChange: selectTab,
		onActivate: selectTab,
		role: "tablist",
		itemRole: "tab",
	});

	return (
		<div className="icon-picker" role="dialog" aria-label="Choose icon">
			<button
				type="button"
				className="icon-picker__backdrop"
				onClick={onClose}
				aria-label={t("shell.actions.close")}
			/>
			<div className="icon-picker__panel">
				<div className="icon-picker__tabs" {...tabsProps}>
					{PICKER_TABS.map((id, index) => (
						<button
							key={id}
							type="button"
							{...getTabProps(index)}
							className={tab === id ? "icon-picker__tab icon-picker__tab--active" : "icon-picker__tab"}
							onClick={() => {
								setTab(id);
								setSearch("");
							}}
						>
							{tabLabel(id)}
						</button>
					))}
					<div className="icon-picker__tabs-spacer" />
					<button
						type="button"
						className="icon-picker__action"
						aria-label={t("shell.iconPicker.remove")}
						title={t("shell.iconPicker.remove")}
						onClick={() => {
							onChange(null);
							onClose();
						}}
					>
						<Glyph name={IconName.Trash} size={18} />
					</button>
				</div>

				{(tab === PickerTab.Emoji || tab === PickerTab.Icon || tab === PickerTab.Library) && (
					<div className="icon-picker__search-row">
						<input
							type="text"
							className="icon-picker__search"
							placeholder={t("shell.iconPicker.search")}
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							// biome-ignore lint/a11y/noAutofocus: this is a search input inside a freshly-opened picker dialog — the user expects to type immediately.
							autoFocus
						/>
					</div>
				)}

				<div className="icon-picker__body">
					{tab === PickerTab.Emoji && (
						<EmojiTab
							search={search}
							skinTone={skinTone}
							onPick={(char) => {
								onChange({ kind: IconKind.Emoji, value: applySkinTone(char, skinTone) });
								onClose();
							}}
						/>
					)}
					{tab === PickerTab.Icon && (
						<IconTab
							search={search}
							tint={tintColor}
							onPick={(glyph) => {
								onChange({
									kind: IconKind.Pack,
									value: `${PHOSPHOR_PACK_ID}/${glyph.name}`,
									...(tintColor !== "currentColor" ? { color: tintColor } : {}),
								});
								onClose();
							}}
						/>
					)}
					{tab === PickerTab.Upload && (
						<UploadTab
							onUploaded={(url) => {
								onChange({ kind: IconKind.Image, value: url });
								onClose();
							}}
						/>
					)}
					{tab === PickerTab.Library && (
						<LibraryTab
							search={search}
							onPick={(url) => {
								onChange({ kind: IconKind.Image, value: url });
								onClose();
							}}
						/>
					)}
				</div>

				<div className="icon-picker__footer">
					{tab === PickerTab.Emoji && <SkinToneRow value={skinTone} onChange={setSkinTone} />}
					{tab === PickerTab.Icon && <TintRow value={tintColor} onChange={setTintColor} />}
				</div>
			</div>
		</div>
	);
}

// ─── tabs ───────────────────────────────────────────────────────────────

function EmojiTab({
	search,
	skinTone,
	onPick,
}: {
	search: string;
	skinTone: SkinTone;
	onPick: (char: string) => void;
}) {
	if (search.trim()) {
		const matches = searchEmoji(search);
		return (
			<div className="icon-picker__grid">
				{matches.map((e) => (
					<EmojiButton key={e.char} emoji={e} skinTone={skinTone} onPick={onPick} />
				))}
				{matches.length === 0 && (
					<div className="icon-picker__empty">{t("shell.iconPicker.noMatch")}</div>
				)}
			</div>
		);
	}
	return (
		<div className="icon-picker__categories">
			{EMOJI_CATEGORIES.map((cat) => (
				<section key={cat.id} className="icon-picker__category">
					<header className="icon-picker__category-label">{cat.label}</header>
					<div className="icon-picker__grid">
						{cat.emojis.map((e) => (
							<EmojiButton key={e.char} emoji={e} skinTone={skinTone} onPick={onPick} />
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function EmojiButton({
	emoji,
	skinTone,
	onPick,
}: {
	emoji: EmojiEntry;
	skinTone: SkinTone;
	onPick: (char: string) => void;
}) {
	const final = applySkinTone(emoji.char, skinTone);
	return (
		<button
			type="button"
			className="icon-picker__cell"
			aria-label={emoji.keywords.split(/\s+/)[0] ?? "emoji"}
			onClick={() => onPick(emoji.char)}
		>
			<img src={emojiUrl(final)} alt="" width={24} height={24} draggable={false} />
		</button>
	);
}

function IconTab({
	search,
	tint,
	onPick,
}: {
	search: string;
	tint: string;
	onPick: (glyph: PackGlyph) => void;
}) {
	const glyphs = useMemo(() => (search.trim() ? searchPhosphor(search) : PHOSPHOR_GLYPHS), [search]);
	return (
		<div className="icon-picker__grid">
			{glyphs.map((g) => {
				const Glyph = g.comp;
				return (
					<button
						key={g.name}
						type="button"
						className="icon-picker__cell"
						aria-label={g.name}
						onClick={() => onPick(g)}
						style={{ color: tint }}
					>
						<Glyph size={20} weight="regular" />
					</button>
				);
			})}
			{glyphs.length === 0 && (
				<div className="icon-picker__empty">{t("shell.iconPicker.noMatch")}</div>
			)}
		</div>
	);
}

function UploadTab({ onUploaded }: { onUploaded: (url: string) => void }) {
	const [active, setActive] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);

	const handleFiles = async (files: File[]) => {
		const file = files[0];
		if (!file) return;
		setUploading(true);
		setError(null);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const result = await window.brainstorm.icons.uploadBytes(file.name, bytes);
			onUploaded(result.url);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setUploading(false);
		}
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setActive(false);
		void handleFiles(Array.from(event.dataTransfer.files));
	};

	return (
		<div className="icon-picker__upload">
			<button
				type="button"
				className={
					active ? "icon-picker__dropzone icon-picker__dropzone--active" : "icon-picker__dropzone"
				}
				onDragOver={(e) => {
					e.preventDefault();
					setActive(true);
				}}
				onDragLeave={() => setActive(false)}
				onDrop={onDrop}
				onClick={async () => {
					setUploading(true);
					setError(null);
					try {
						const result = await window.brainstorm.icons.uploadFromDialog();
						if (result) onUploaded(result.url);
					} catch (e) {
						setError((e as Error).message);
					} finally {
						setUploading(false);
					}
				}}
				disabled={uploading}
			>
				<p className="icon-picker__dropzone-hint">
					{uploading ? t("shell.iconPicker.uploading") : t("shell.iconPicker.dropHint")}
				</p>
			</button>
			{error && <p className="icon-picker__error">{error}</p>}
		</div>
	);
}

function LibraryTab({ search, onPick }: { search: string; onPick: (url: string) => void }) {
	const [entries, setEntries] = useState<IconEntry[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.icons.list().then((list) => {
			if (!cancelled) setEntries(list);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	if (entries === null) {
		return <div className="icon-picker__empty">{t("shell.common.loading")}</div>;
	}
	if (entries.length === 0) {
		return <div className="icon-picker__empty">{t("shell.iconPicker.libraryEmpty")}</div>;
	}
	// Library has no text-searchable metadata yet; filter by hash prefix as a
	// minimal "find by id" affordance, otherwise show all.
	const filtered = search.trim()
		? entries.filter((e) => e.hash.startsWith(search.trim().toLowerCase()))
		: entries;
	return (
		<div className="icon-picker__grid icon-picker__grid--large">
			{filtered.map((entry) => (
				<button
					key={entry.hash}
					type="button"
					className="icon-picker__cell icon-picker__cell--image"
					aria-label="Uploaded icon"
					onClick={() => onPick(entry.url)}
				>
					<img src={entry.thumbUrl} alt="" width={40} height={40} draggable={false} />
				</button>
			))}
		</div>
	);
}

// ─── footer rows ────────────────────────────────────────────────────────

function SkinToneRow({
	value,
	onChange,
}: {
	value: SkinTone;
	onChange: (next: SkinTone) => void;
}) {
	const tones: { id: SkinTone; preview: string; labelKey: string }[] = [
		{ id: ST.None, preview: "👋", labelKey: "shell.iconPicker.skinTone.none" },
		{ id: ST.Light, preview: "👋🏻", labelKey: "shell.iconPicker.skinTone.light" },
		{ id: ST.MediumLight, preview: "👋🏼", labelKey: "shell.iconPicker.skinTone.mediumLight" },
		{ id: ST.Medium, preview: "👋🏽", labelKey: "shell.iconPicker.skinTone.medium" },
		{ id: ST.MediumDark, preview: "👋🏾", labelKey: "shell.iconPicker.skinTone.mediumDark" },
		{ id: ST.Dark, preview: "👋🏿", labelKey: "shell.iconPicker.skinTone.dark" },
	];
	// KBN-S-pickers: skin tones are a horizontal radiogroup — ←/→ move + select
	// (aria-checked via SelectionAttribute.AriaChecked); role flows through the
	// hook, dropping the hand-written role="radiogroup"/role="radio".
	const selectTone = (index: number) => {
		const tone = tones[index];
		if (tone !== undefined) onChange(tone.id);
	};
	const { containerProps: groupProps, getItemProps: getToneProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: tones.length,
		activeIndex: tones.findIndex((tone) => tone.id === value),
		onActiveIndexChange: selectTone,
		onActivate: selectTone,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.AriaChecked,
	});
	return (
		<div
			className="icon-picker__skin-row"
			{...groupProps}
			aria-label={t("shell.iconPicker.skinToneRegion")}
		>
			{tones.map((tone, index) => (
				<button
					key={tone.id}
					type="button"
					{...getToneProps(index)}
					aria-label={t(tone.labelKey)}
					className={
						value === tone.id ? "icon-picker__skin icon-picker__skin--active" : "icon-picker__skin"
					}
					onClick={() => onChange(tone.id)}
				>
					<img src={emojiUrl(tone.preview)} alt="" width={20} height={20} draggable={false} />
				</button>
			))}
		</div>
	);
}

function TintRow({ value, onChange }: { value: string; onChange: (next: string) => void }) {
	const onCustom = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value);
	const customInput = useRef<HTMLInputElement | null>(null);
	return (
		<div className="icon-picker__tint-row" aria-label={t("shell.iconPicker.tintRegion")}>
			{TINT_PALETTE.map((color) => (
				<button
					key={color}
					type="button"
					className={
						value === color ? "icon-picker__swatch icon-picker__swatch--active" : "icon-picker__swatch"
					}
					aria-label={t("shell.iconPicker.tintOption", { color })}
					onClick={() => onChange(color)}
					style={{ color }}
				>
					<span
						className="icon-picker__swatch-fill"
						style={color === "currentColor" ? { background: "transparent" } : { background: color }}
					/>
				</button>
			))}
			<button
				type="button"
				className="icon-picker__swatch icon-picker__swatch--custom"
				aria-label={t("shell.iconPicker.tintCustom")}
				onClick={() => customInput.current?.click()}
			>
				<input
					ref={customInput}
					type="color"
					className="icon-picker__color-input"
					value={value.startsWith("#") ? value : "#000000"}
					onChange={onCustom}
					aria-label={t("shell.iconPicker.tintCustom")}
				/>
			</button>
		</div>
	);
}

// ─── helpers ────────────────────────────────────────────────────────────

function initialTabFor(value: Icon | null): PickerTab {
	if (!value) return PickerTab.Emoji;
	if (value.kind === IconKind.Emoji) return PickerTab.Emoji;
	if (value.kind === IconKind.Pack) return PickerTab.Icon;
	return PickerTab.Library;
}

function packTint(value: Icon | null): string | null {
	if (value && value.kind === IconKind.Pack) return value.color ?? null;
	return null;
}

function tabLabel(id: PickerTab): string {
	switch (id) {
		case PickerTab.Emoji:
			return t("shell.iconPicker.tab.emoji");
		case PickerTab.Icon:
			return t("shell.iconPicker.tab.icon");
		case PickerTab.Upload:
			return t("shell.iconPicker.tab.upload");
		case PickerTab.Library:
			return t("shell.iconPicker.tab.library");
	}
}

/** Apply a Fitzpatrick skin-tone modifier to a base emoji character. v1
 *  only supports single-character base emojis (no ZWJ sequence splitting),
 *  so the modifier appends. For unsupported emojis (e.g. animals) the
 *  modifier silently drops — those will keep their default skin tone in
 *  the picker preview too. */
function applySkinTone(char: string, tone: SkinTone): string {
	if (tone === ST.None) return char;
	if (!SKIN_TONE_SUPPORTING.has(char)) return char;
	const cp = Number.parseInt(tone, 16);
	return char + String.fromCodePoint(cp);
}
