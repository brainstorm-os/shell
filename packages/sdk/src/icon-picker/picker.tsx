/**
 * IconPicker — the ONE universal icon chooser, shared by every app via
 * `@brainstorm-os/sdk/icon-picker` (the React twin of `createEntityIconElement`
 * / `<EntityCover>`). Coverage cranked all the way up:
 *
 *   - Emoji tab: every emoji from `unicode-emoji-json` (10 groups,
 *     ~3700 entries), virtualised so paint stays cheap.
 *   - Icon tab: every Phosphor icon from `@phosphor-icons/core`
 *     (1530 glyphs, 18 categories), virtualised; the React components
 *     come from a lazy chunk so the host bundle stays small.
 *   - Upload + Library: tabs render placeholders pending an SDK
 *     `icons` service for apps (B7.2).
 *
 * Both grids share a column-count driven by ResizeObserver so cells stay
 * uniformly sized across resizes.
 *
 * Host-agnostic per the SDK convention (cf. `InlinePropertyForm`): every
 * user-visible string arrives via `labels` (the host wraps each in its
 * own `t()`); the host owns the close shortcut and renders this inside
 * its own overlay, so there is no app-keyboard-registry coupling here.
 */

import { type Icon, IconKind, type SkinTone } from "@brainstorm-os/sdk-types";
import { SkinTone as ST } from "@brainstorm-os/sdk-types";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type ChangeEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type CompositeContainerProps,
	type CompositeItemProps,
	Orientation,
	SelectionAttribute,
	type VirtualGridRow,
	VirtualGridRowKind,
	type VirtualGridSection,
	useCompositeKeyboard,
	useVirtualGridNav,
} from "../a11y";
import { DEFAULT_ICON_PICKER_LABELS, type IconPickerLabels } from "../i18n/common-labels";
import { Icon as Glyph, IconName } from "../icon";
import { EMOJI_GROUPS, type EmojiData, applySkinTone, emojiUrl, searchEmojis } from "./emoji-data";
import "./icon-picker.css";

export type { IconPickerLabels } from "../i18n/common-labels";
import {
	PHOSPHOR_GROUPS,
	PHOSPHOR_PACK_ID,
	type PhosphorComponent,
	type PhosphorMeta,
	loadPhosphorReact,
	searchPhosphor,
	subscribePhosphorReact,
} from "./phosphor-data";

/** Backing store for the Upload + Library tabs (B11.14 custom emoji). When a
 *  host wires one, the Upload tab uploads an image and the Library tab lists
 *  previously-uploaded ones; without it, both tabs show the `*Pending`
 *  placeholder. Decoupled from the SDK runtime so the picker stays
 *  host-agnostic — the host adapts `services.icons`. */
export type IconUploadService = {
	upload(filename: string, bytes: Uint8Array): Promise<{ url: string; thumbUrl: string }>;
	list(): Promise<{ url: string; thumbUrl: string }[]>;
};

export type IconPickerProps = {
	value: Icon | null;
	onChange: (icon: Icon | null) => void;
	onClose: () => void;
	/** Optional per-host overrides; omitted keys fall back to the
	 *  canonical `DEFAULT_ICON_PICKER_LABELS` (SDK i18n convention —
	 *  see `@brainstorm-os/sdk/i18n`). */
	labels?: Partial<IconPickerLabels> | undefined;
	/** Custom-image upload backing (B11.14). When omitted the Upload + Library
	 *  tabs stay placeholders. */
	iconUpload?: IconUploadService | undefined;
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

const TINT_PALETTE: readonly string[] = [
	"currentColor",
	"#6b73f0",
	"#dc2626",
	"#ea580c",
	"#ca8a04",
	"#16a34a",
	"#0891b2",
	"#2563eb",
	"#9333ea",
	"#db2777",
];

const CELL_SIZE = 36;
const ROW_HEIGHT = 38;
const HEADER_HEIGHT = 28;
const PANEL_PADDING_X = 24;

export function IconPicker({ value, onChange, onClose, labels, iconUpload }: IconPickerProps) {
	const L: IconPickerLabels = { ...DEFAULT_ICON_PICKER_LABELS, ...labels };
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
		<div className="icon-picker" role="dialog" aria-label={L.region}>
			<button type="button" className="icon-picker__backdrop" onClick={onClose} aria-label={L.close} />
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
							{tabLabel(id, L)}
						</button>
					))}
					<div className="icon-picker__tabs-spacer" />
					<button
						type="button"
						className="icon-picker__action"
						aria-label={L.remove}
						data-bs-tooltip={L.remove}
						onClick={() => {
							onChange(null);
							onClose();
						}}
					>
						<Glyph name={IconName.Trash} size={18} />
					</button>
				</div>

				{(tab === PickerTab.Emoji || tab === PickerTab.Icon) && (
					<div className="icon-picker__search-row">
						<input
							type="text"
							className="icon-picker__search"
							placeholder={L.search}
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
							noMatch={L.noMatch}
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
							noMatch={L.noMatch}
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
					{tab === PickerTab.Upload &&
						(iconUpload ? (
							<UploadTab
								service={iconUpload}
								labels={L}
								onPick={(url) => {
									onChange({ kind: IconKind.Image, value: url });
									onClose();
								}}
							/>
						) : (
							<PendingTab message={L.uploadPending} />
						))}
					{tab === PickerTab.Library &&
						(iconUpload ? (
							<LibraryTab
								service={iconUpload}
								labels={L}
								onPick={(url) => {
									onChange({ kind: IconKind.Image, value: url });
									onClose();
								}}
							/>
						) : (
							<PendingTab message={L.libraryPending} />
						))}
				</div>

				<div className="icon-picker__footer">
					{tab === PickerTab.Emoji && <SkinToneRow value={skinTone} onChange={setSkinTone} labels={L} />}
					{tab === PickerTab.Icon && <TintRow value={tintColor} onChange={setTintColor} labels={L} />}
				</div>
			</div>
		</div>
	);
}

// ─── Emoji tab ──────────────────────────────────────────────────────────

function EmojiTab({
	search,
	skinTone,
	noMatch,
	onPick,
}: {
	search: string;
	skinTone: SkinTone;
	noMatch: string;
	onPick: (char: string) => void;
}) {
	const { scrollRef, cellsPerRow } = useVirtualGridContainer();

	const sections = useMemo<readonly VirtualGridSection<EmojiData>[]>(() => {
		const q = search.trim();
		if (q) return [{ key: "results", label: null, items: searchEmojis(q) }];
		return EMOJI_GROUPS.map((group) => ({
			key: group.slug,
			label: group.name,
			items: group.emojis,
		}));
	}, [search]);

	// KBN-S-pickers: the virtual grid is one Tab stop; arrows move an
	// aria-activedescendant cursor, Enter picks (see `useVirtualGridNav`).
	const { rows, containerProps, getCellProps, activeRow } = useVirtualGridNav(
		sections,
		cellsPerRow,
		(e: EmojiData) => onPick(e.char),
	);

	return (
		<VirtualGrid
			scrollRef={scrollRef}
			rows={rows}
			containerProps={containerProps}
			activeRow={activeRow}
			emptyMessage={noMatch}
			renderCell={(emoji, index) => (
				<EmojiCell
					key={emoji.char}
					emoji={emoji}
					skinTone={skinTone}
					onPick={onPick}
					cellProps={getCellProps(index)}
				/>
			)}
		/>
	);
}

function EmojiCell({
	emoji,
	skinTone,
	onPick,
	cellProps,
}: {
	emoji: EmojiData;
	skinTone: SkinTone;
	onPick: (char: string) => void;
	cellProps: CompositeItemProps;
}) {
	const final = applySkinTone(emoji.char, skinTone);
	return (
		<button
			type="button"
			{...cellProps}
			className="icon-picker__cell"
			aria-label={emoji.name}
			title={emoji.name}
			onClick={() => onPick(emoji.char)}
		>
			<img
				src={emojiUrl(final)}
				alt=""
				width={24}
				height={24}
				draggable={false}
				loading="lazy"
				decoding="async"
				onError={(e) => {
					e.currentTarget.style.visibility = "hidden";
				}}
			/>
		</button>
	);
}

// ─── Icon tab ───────────────────────────────────────────────────────────

function IconTab({
	search,
	tint,
	noMatch,
	onPick,
}: {
	search: string;
	tint: string;
	noMatch: string;
	onPick: (icon: PhosphorMeta) => void;
}) {
	const { scrollRef, cellsPerRow } = useVirtualGridContainer();
	const components = usePhosphorComponents();

	const sections = useMemo<readonly VirtualGridSection<PhosphorMeta>[]>(() => {
		const q = search.trim();
		if (q) return [{ key: "results", label: null, items: searchPhosphor(q) }];
		return PHOSPHOR_GROUPS.map((group) => ({
			key: group.name,
			label: group.name,
			items: group.icons,
		}));
	}, [search]);

	const { rows, containerProps, getCellProps, activeRow } = useVirtualGridNav(
		sections,
		cellsPerRow,
		onPick,
	);

	return (
		<VirtualGrid
			scrollRef={scrollRef}
			rows={rows}
			containerProps={containerProps}
			activeRow={activeRow}
			emptyMessage={noMatch}
			renderCell={(icon, index) => (
				<PhosphorCell
					key={icon.name}
					icon={icon}
					tint={tint}
					Component={components?.[icon.pascal] ?? null}
					onPick={onPick}
					cellProps={getCellProps(index)}
				/>
			)}
		/>
	);
}

function PhosphorCell({
	icon,
	tint,
	Component,
	onPick,
	cellProps,
}: {
	icon: PhosphorMeta;
	tint: string;
	Component: PhosphorComponent | null;
	onPick: (icon: PhosphorMeta) => void;
	cellProps: CompositeItemProps;
}) {
	return (
		<button
			type="button"
			{...cellProps}
			className="icon-picker__cell"
			aria-label={icon.name}
			title={icon.name}
			onClick={() => onPick(icon)}
			style={{ color: tint }}
		>
			{Component ? (
				<Component size={20} weight="regular" />
			) : (
				<span className="icon-picker__cell-placeholder" />
			)}
		</button>
	);
}

function PendingTab({ message }: { message: string }) {
	return <div className="icon-picker__pending">{message}</div>;
}

// ─── Upload + Library tabs (B11.14 custom emoji) ────────────────────────

const ICON_UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.avif,.svg";

function UploadTab({
	service,
	labels,
	onPick,
}: {
	service: IconUploadService;
	labels: IconPickerLabels;
	onPick: (url: string) => void;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onFile(file: File | undefined) {
		if (!file) return;
		setBusy(true);
		setError(null);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const result = await service.upload(file.name, bytes);
			onPick(result.url);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="icon-picker__upload">
			<input
				ref={inputRef}
				type="file"
				accept={ICON_UPLOAD_ACCEPT}
				className="icon-picker__upload-input"
				aria-label={labels.uploadAction}
				onChange={(e) => void onFile(e.target.files?.[0])}
				disabled={busy}
			/>
			<button
				type="button"
				className="icon-picker__action"
				onClick={() => inputRef.current?.click()}
				disabled={busy}
			>
				{busy ? labels.uploading : labels.uploadAction}
			</button>
			{error && <div className="icon-picker__upload-error">{error}</div>}
		</div>
	);
}

function LibraryTab({
	service,
	labels,
	onPick,
}: {
	service: IconUploadService;
	labels: IconPickerLabels;
	onPick: (url: string) => void;
}) {
	const [items, setItems] = useState<{ url: string; thumbUrl: string }[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		service
			.list()
			.then((list) => {
				if (!cancelled) setItems(list);
			})
			.catch(() => {
				if (!cancelled) setItems([]);
			});
		return () => {
			cancelled = true;
		};
	}, [service]);

	if (items === null) return <div className="icon-picker__pending">{labels.uploading}</div>;
	if (items.length === 0) return <div className="icon-picker__pending">{labels.libraryEmpty}</div>;
	// Plain focusable buttons in a grid — natively Tab-reachable + Enter/Space
	// activate, so the library is keyboard-accessible without a custom listbox.
	return (
		<div className="icon-picker__library" aria-label={labels.tabLibrary}>
			{items.map((item) => (
				<button
					key={item.url}
					type="button"
					className="icon-picker__library-cell"
					title={labels.tabLibrary}
					onClick={() => onPick(item.url)}
				>
					<img src={item.thumbUrl} alt="" className="icon-picker__library-img" />
				</button>
			))}
		</div>
	);
}

// ─── Virtual grid plumbing ──────────────────────────────────────────────

function VirtualGrid<T>({
	scrollRef,
	rows,
	containerProps,
	activeRow,
	renderCell,
	emptyMessage,
}: {
	scrollRef: React.RefObject<HTMLDivElement | null>;
	rows: readonly VirtualGridRow<T>[];
	containerProps: CompositeContainerProps;
	activeRow: number | null;
	/** Renders the cell at a FLAT item index (`row.start + offsetInRow`). */
	renderCell: (item: T, index: number) => ReactNode;
	emptyMessage: string;
}) {
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) =>
			rows[index]?.kind === VirtualGridRowKind.Header ? HEADER_HEIGHT : ROW_HEIGHT,
		overscan: 6,
		getItemKey: (index) => rows[index]?.key ?? `i:${index}`,
	});

	// Keep the keyboard cursor's row mounted so `aria-activedescendant`
	// always resolves to a live cell.
	useEffect(() => {
		if (activeRow !== null && activeRow < rows.length) virtualizer.scrollToIndex(activeRow);
	}, [activeRow, rows.length, virtualizer]);

	const { ref: setComposite, ...gridProps } = containerProps;
	const setRefs = (node: HTMLDivElement | null) => {
		scrollRef.current = node;
		setComposite(node);
	};

	if (rows.length === 0) {
		return <div className="icon-picker__empty">{emptyMessage}</div>;
	}

	const items = virtualizer.getVirtualItems();
	return (
		<div ref={setRefs} className="icon-picker__scroll" {...gridProps}>
			<div className="icon-picker__virtual-inner" style={{ height: virtualizer.getTotalSize() }}>
				{items.map((item) => {
					const row = rows[item.index];
					if (!row) return null;
					return (
						<div
							key={item.key}
							className="icon-picker__virtual-item"
							style={{ transform: `translateY(${item.start}px)`, height: item.size }}
						>
							{row.kind === VirtualGridRowKind.Header ? (
								<div className="icon-picker__category-label" role="presentation">
									{row.label}
								</div>
							) : (
								// biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant grid — focus stays on the scroll container; rows/cells track the cursor and are intentionally not in the tab order.
								<div className="icon-picker__virtual-row" role="row">
									{row.items.map((cell, j) => renderCell(cell, row.start + j))}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function useVirtualGridContainer() {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const update = () => setWidth(el.clientWidth);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const cellsPerRow = useMemo(() => {
		const usable = Math.max(0, width - PANEL_PADDING_X);
		return Math.max(1, Math.floor(usable / CELL_SIZE));
	}, [width]);

	return { scrollRef, cellsPerRow };
}

function usePhosphorComponents() {
	const [components, setComponents] = useState<Record<string, PhosphorComponent> | null>(null);
	useEffect(() => {
		let cancelled = false;
		void loadPhosphorReact().then((mod) => {
			if (!cancelled) setComponents(mod);
		});
		const unsubscribe = subscribePhosphorReact(() => {
			void loadPhosphorReact().then((mod) => {
				if (!cancelled) setComponents(mod);
			});
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);
	return components;
}

// ─── Footer rows ────────────────────────────────────────────────────────

function SkinToneRow({
	value,
	onChange,
	labels,
}: {
	value: SkinTone;
	onChange: (next: SkinTone) => void;
	labels: IconPickerLabels;
}) {
	const tones: {
		id: SkinTone;
		preview: string;
		nameKey: keyof IconPickerLabels["skinToneNames"];
	}[] = [
		{ id: ST.None, preview: "👋", nameKey: "none" },
		{ id: ST.Light, preview: "👋🏻", nameKey: "light" },
		{ id: ST.MediumLight, preview: "👋🏼", nameKey: "mediumLight" },
		{ id: ST.Medium, preview: "👋🏽", nameKey: "medium" },
		{ id: ST.MediumDark, preview: "👋🏾", nameKey: "mediumDark" },
		{ id: ST.Dark, preview: "👋🏿", nameKey: "dark" },
	];
	// KBN-S-pickers: skin tones are a horizontal radiogroup — ←/→ move + select
	// (aria-checked via the hook's SelectionAttribute.AriaChecked); the role flows
	// through the hook, dropping the hand-written role="radiogroup"/role="radio".
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
		<div className="icon-picker__skin-row" {...groupProps} aria-label={labels.skinToneRegion}>
			{tones.map((tone, index) => (
				<button
					key={tone.id}
					type="button"
					{...getToneProps(index)}
					aria-label={labels.skinToneOption.replace(/\{tone\}/g, labels.skinToneNames[tone.nameKey])}
					className={
						value === tone.id ? "icon-picker__skin icon-picker__skin--active" : "icon-picker__skin"
					}
					onClick={() => onChange(tone.id)}
				>
					<img
						src={emojiUrl(tone.preview)}
						alt=""
						width={20}
						height={20}
						draggable={false}
						decoding="async"
					/>
				</button>
			))}
		</div>
	);
}

function TintRow({
	value,
	onChange,
	labels,
}: {
	value: string;
	onChange: (next: string) => void;
	labels: IconPickerLabels;
}) {
	const onCustom = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value);
	const customInput = useRef<HTMLInputElement | null>(null);
	return (
		<div className="icon-picker__tint-row" aria-label={labels.tintRegion}>
			{TINT_PALETTE.map((color) => (
				<button
					key={color}
					type="button"
					className={
						value === color ? "icon-picker__swatch icon-picker__swatch--active" : "icon-picker__swatch"
					}
					aria-label={labels.tintOption.replace(/\{color\}/g, color)}
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
				aria-label={labels.tintCustom}
				onClick={() => customInput.current?.click()}
			>
				<input
					ref={customInput}
					type="color"
					className="icon-picker__color-input"
					value={value.startsWith("#") ? value : "#000000"}
					onChange={onCustom}
					aria-label={labels.tintCustom}
				/>
			</button>
		</div>
	);
}

// ─── Helpers ────────────────────────────────────────────────────────────

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

function tabLabel(id: PickerTab, labels: IconPickerLabels): string {
	switch (id) {
		case PickerTab.Emoji:
			return labels.tabEmoji;
		case PickerTab.Icon:
			return labels.tabIcon;
		case PickerTab.Upload:
			return labels.tabUpload;
		case PickerTab.Library:
			return labels.tabLibrary;
	}
}
