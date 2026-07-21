/**
 * CoverPicker — the ONE object-cover chooser, shared by every app via
 * `@brainstorm-os/sdk/cover-picker` (the visual companion to `<IconPicker>`,
 * realising the per-object-covers-everywhere invariant of B7.3).
 *
 *   - Image      : drag-and-drop / click upload (→ injected
 *                  `covers.uploadBytes`) or pick from the vault library
 *                  (`covers.list`). Pure selection — the library is
 *                  row-virtualised since it can grow unbounded.
 *   - Color      : the curated `ALL_COVER_GRADIENTS` gradients and a
 *                  curated solid palette in ONE grid (gradients and a
 *                  flat fill are the same kind of pick — no reason to
 *                  split tabs). Theme tokens lead (follow the active
 *                  theme); curated literals are the explicit absolute
 *                  escape hatch (OQ-COV-1 (3)).
 *   - Reposition : the focal-point drag control. A *distinct step* from
 *                  selection (stacking the live banner + the drag
 *                  surface read as two duplicate images) — the tab only
 *                  exists while an image cover is staged.
 *   - Remove     : an icon button that clears `properties.cover`.
 *
 * Every tab stages a *pending* cover that the live preview band reflects
 * (except Reposition, where the drag surface *is* the preview); one
 * Apply commits it (Remove is the immediate escape hatch).
 *
 * Host-agnostic per the SDK convention (cf. `IconPicker` /
 * `InlinePropertyForm`): every user-visible string arrives via `labels`;
 * the cover content store arrives via the injected `covers` service
 * (`runtime.services.covers`); the host owns its close shortcut and
 * renders this inside its own overlay. Reuses the `.icon-picker` chrome
 * so the two pickers are visibly one family.
 */

import { type Cover, type CoverFocal, CoverKind } from "@brainstorm-os/sdk-types";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Orientation, VirtualGridRowKind, useCompositeKeyboard, useVirtualGridNav } from "../a11y";
import { ALL_COVER_GRADIENTS, coverGradientCss, createEntityCoverElement } from "../entity-cover";
import { type CoverPickerLabels, DEFAULT_COVER_PICKER_LABELS } from "../i18n/common-labels";
import { Icon, IconName } from "../icon";
import "../icon-picker/icon-picker.css";
import "./cover-picker.css";

export type { CoverPickerLabels } from "../i18n/common-labels";

/** The slice of the `covers` SDK service the picker needs (inject
 *  `runtime.services.covers`). Kept structural so hosts/tests can pass a
 *  stub without depending on the runtime. */
export type CoverPickerService = {
	uploadBytes(filename: string, bytes: Uint8Array): Promise<{ url: string; thumbUrl: string }>;
	list(): Promise<ReadonlyArray<{ url: string; thumbUrl: string }>>;
};

export type CoverPickerProps = {
	value: Cover | null;
	onChange: (cover: Cover | null) => void;
	onClose: () => void;
	/** Optional per-host overrides; omitted keys fall back to the
	 *  canonical `DEFAULT_COVER_PICKER_LABELS` (SDK i18n convention —
	 *  see `@brainstorm-os/sdk/i18n`). */
	labels?: Partial<CoverPickerLabels> | undefined;
	covers: CoverPickerService;
};

enum PickerTab {
	Image = "image",
	Palette = "palette",
	Reposition = "reposition",
}

/**
 * The Color tab's swatches: theme tokens first (they follow the active
 * theme — the default), then a curated saturated solid palette in the
 * `--token`/literal shorthand `normalizeCoverColor` accepts. Only
 * cover-worthy hues; an unrecognised value still degrades to the
 * id-seeded gradient at render (OQ-COV-1), never a broken paint. The
 * curated literals echo the gradient end-stops so the whole grid reads
 * as one family.
 */
const COLOR_CHOICES: readonly string[] = [
	"--color-accent-default",
	"--color-state-success",
	"--color-state-info",
	"--color-state-warning",
	"--color-state-error",
	"#e0815f",
	"#4faa92",
	"#8867d0",
	"#5491cf",
	"#c66a8c",
	"#b89150",
	"#d39a3f",
	"#3f9aa0",
	"#5d5bcb",
	"#4aa6cf",
	"#84a83f",
	"#b85bb0",
	"#6c7a8c",
	"#3f7fb0",
];

const ALLOWED_UPLOAD_EXTS = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

export function CoverPicker({ value, onChange, onClose, labels, covers }: CoverPickerProps) {
	const L: CoverPickerLabels = { ...DEFAULT_COVER_PICKER_LABELS, ...labels };
	const [tab, setTab] = useState<PickerTab>(initialTabFor(value));
	const [pending, setPending] = useState<Cover | null>(value);

	const dirty = !sameCover(pending, value);
	const imageStaged = pending?.kind === CoverKind.Image;
	// Reposition only makes sense for an image cover; if the staged cover
	// stops being an image while that tab is open, fall back to selection.
	const activeTab = tab === PickerTab.Reposition && !imageStaged ? PickerTab.Image : tab;
	const tabs = imageStaged
		? [PickerTab.Image, PickerTab.Palette, PickerTab.Reposition]
		: [PickerTab.Image, PickerTab.Palette];

	// KBN-S-pickers: the tab row is a horizontal tablist — ←/→ move + activate
	// (automatic-activation), so the role flows through the hook (drops the
	// hand-written role="tablist"/role="tab" literals).
	const selectTab = (index: number) => {
		const next = tabs[index];
		if (next !== undefined) setTab(next);
	};
	const { containerProps: tabsProps, getItemProps: getTabProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: tabs.length,
		activeIndex: tabs.indexOf(activeTab),
		onActiveIndexChange: selectTab,
		onActivate: selectTab,
		role: "tablist",
		itemRole: "tab",
	});

	return (
		<div className="icon-picker cover-picker" role="dialog" aria-label={L.region}>
			<button type="button" className="icon-picker__backdrop" onClick={onClose} aria-label={L.close} />
			<div className="icon-picker__panel">
				<div className="icon-picker__tabs" {...tabsProps}>
					{tabs.map((id, index) => (
						<button
							key={id}
							type="button"
							{...getTabProps(index)}
							className={
								activeTab === id ? "icon-picker__tab icon-picker__tab--active" : "icon-picker__tab"
							}
							onClick={() => setTab(id)}
						>
							{tabLabel(id, L)}
						</button>
					))}
					<div className="icon-picker__tabs-spacer" />
					<button
						type="button"
						className="icon-picker__action cover-picker__remove"
						aria-label={L.remove}
						data-bs-tooltip={L.remove}
						onClick={() => {
							onChange(null);
							onClose();
						}}
					>
						<Icon name={IconName.Trash} />
					</button>
				</div>

				<div className="icon-picker__body">
					{pending && activeTab !== PickerTab.Reposition && (
						<PreviewBand cover={pending} regionLabel={L.region} />
					)}

					{activeTab === PickerTab.Image && (
						<ImageTab
							value={pending && pending.kind === CoverKind.Image ? pending : null}
							labels={L}
							covers={covers}
							onStage={(cover) => {
								setPending(cover);
								// Freshly chosen image → jump straight to framing it.
								setTab(PickerTab.Reposition);
							}}
						/>
					)}
					{activeTab === PickerTab.Palette && (
						<PaletteTab regionLabel={L.galleryRegion} pending={pending} onPick={setPending} />
					)}
					{activeTab === PickerTab.Reposition && imageStaged && (
						<RepositionTab
							cover={pending as { kind: CoverKind.Image; value: string; focal?: CoverFocal }}
							hint={L.focalHint}
							onStage={setPending}
						/>
					)}

					<div className="cover-picker__footer">
						<button
							type="button"
							className="bs-btn cover-picker__apply"
							data-bs-primary
							disabled={!dirty}
							onClick={() => {
								onChange(pending);
								onClose();
							}}
						>
							{L.useCover}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── Live preview band (reflects the pending cover, all tabs) ────────────

function PreviewBand({ cover, regionLabel }: { cover: Cover; regionLabel: string }) {
	const hostRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const el = createEntityCoverElement(
			{ id: "cover-preview", properties: { cover } },
			{ aspect: 16 / 6 },
			cover,
		);
		host.replaceChildren(el);
		return () => host.replaceChildren();
	}, [cover]);

	return <div ref={hostRef} className="cover-picker__preview" role="img" aria-label={regionLabel} />;
}

// ─── Image tab (drag-and-drop / library + focal-point drag) ─────────────

function ImageTab({
	value,
	labels,
	covers,
	onStage,
}: {
	value: { kind: CoverKind.Image; value: string; focal?: CoverFocal } | null;
	labels: CoverPickerLabels;
	covers: CoverPickerService;
	onStage: (cover: Cover) => void;
}) {
	const [library, setLibrary] = useState<ReadonlyArray<{ url: string; thumbUrl: string }>>([]);
	const [uploading, setUploading] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const fileRef = useRef<HTMLInputElement | null>(null);

	const selectedUrl = value?.value ?? null;

	const refresh = () => {
		void covers.list().then(setLibrary);
	};
	// `covers` is a stable injected service — list once on mount.
	useEffect(refresh, []);

	const onFile = async (file: File) => {
		if (!ALLOWED_UPLOAD_EXTS.test(file.name)) return;
		setUploading(true);
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const { url } = await covers.uploadBytes(file.name, bytes);
			onStage({ kind: CoverKind.Image, value: url, focal: { x: 0.5, y: 0.5 } });
			refresh();
		} finally {
			setUploading(false);
		}
	};

	return (
		<div className="cover-picker__image">
			<input
				ref={fileRef}
				type="file"
				className="cover-picker__file"
				accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml"
				onChange={(e) => {
					const f = e.target.files?.[0];
					if (f) void onFile(f);
					e.target.value = "";
				}}
				aria-label="Choose cover image file"
			/>
			<button
				type="button"
				className={[
					"cover-picker__dropzone",
					dragOver ? "cover-picker__dropzone--over" : "",
					// Once an image is chosen the big drop target is redundant
					// and pushes the focal control + Apply off-screen — slim it
					// to a single "replace" bar.
					selectedUrl ? "cover-picker__dropzone--compact" : "",
				]
					.filter(Boolean)
					.join(" ")}
				disabled={uploading}
				onClick={() => fileRef.current?.click()}
				onDragOver={(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragOver(false);
					const f = e.dataTransfer.files?.[0];
					if (f) void onFile(f);
				}}
			>
				<span className="cover-picker__dropzone-title">
					{uploading ? labels.uploading : labels.upload}
				</span>
				{!selectedUrl && <span className="cover-picker__dropzone-hint">{labels.dropHint}</span>}
			</button>

			{library.length === 0 ? (
				<p className="icon-picker__empty">{labels.libraryEmpty}</p>
			) : (
				<VirtualCoverGrid
					cells={library.map((entry) => ({
						key: entry.url,
						label: "",
						active: entry.url === selectedUrl,
						className: "cover-picker__lib-cell",
						content: (
							<img src={entry.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} />
						),
						onPick: () => onStage({ kind: CoverKind.Image, value: entry.url, focal: { x: 0.5, y: 0.5 } }),
					}))}
				/>
			)}
		</div>
	);
}

// ─── Reposition tab — focal-point framing (image covers only) ───────────

function RepositionTab({
	cover,
	hint,
	onStage,
}: {
	cover: { kind: CoverKind.Image; value: string; focal?: CoverFocal };
	hint: string;
	onStage: (cover: Cover) => void;
}) {
	return (
		<FocalControl
			url={cover.value}
			focal={cover.focal ?? { x: 0.5, y: 0.5 }}
			hint={hint}
			onChange={(next) => onStage({ kind: CoverKind.Image, value: cover.value, focal: next })}
		/>
	);
}

function FocalControl({
	url,
	focal,
	hint,
	onChange,
}: {
	url: string;
	focal: CoverFocal;
	hint: string;
	onChange: (next: CoverFocal) => void;
}) {
	const boxRef = useRef<HTMLDivElement | null>(null);
	const dragging = useRef(false);

	const apply = (clientX: number, clientY: number) => {
		const box = boxRef.current;
		if (!box) return;
		const r = box.getBoundingClientRect();
		const x = clamp01((clientX - r.left) / Math.max(1, r.width));
		const y = clamp01((clientY - r.top) / Math.max(1, r.height));
		onChange({ x, y });
	};

	return (
		<div className="cover-picker__focal-wrap">
			<div
				ref={boxRef}
				className="cover-picker__focal"
				style={{ backgroundImage: `url("${url.replace(/"/g, "%22")}")` }}
				onPointerDown={(e) => {
					dragging.current = true;
					(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
					apply(e.clientX, e.clientY);
				}}
				onPointerMove={(e) => {
					if (dragging.current) apply(e.clientX, e.clientY);
				}}
				onPointerUp={() => {
					dragging.current = false;
				}}
			>
				<span
					className="cover-picker__focal-dot"
					style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
					aria-hidden="true"
				/>
			</div>
			<p className="cover-picker__focal-hint">{hint}</p>
		</div>
	);
}

// ─── Color tab — gradients + solids in one grid ─────────────────────────

function PaletteTab({
	regionLabel,
	pending,
	onPick,
}: {
	regionLabel: string;
	pending: Cover | null;
	onPick: (cover: Cover) => void;
}) {
	const gradientSel = pending?.kind === CoverKind.Gradient ? pending.value : null;
	const colorSel = pending?.kind === CoverKind.Color ? pending.value : null;

	return (
		<div className="cover-picker__swatch-grid" aria-label={regionLabel}>
			{Object.keys(ALL_COVER_GRADIENTS).map((key) => (
				<Swatch
					key={`g:${key}`}
					label={key}
					active={key === gradientSel}
					background={coverGradientCss(key, key)}
					onPick={() => onPick({ kind: CoverKind.Gradient, value: key })}
				/>
			))}
			{COLOR_CHOICES.map((value) => (
				<Swatch
					key={`c:${value}`}
					label={value}
					active={value === colorSel}
					background={value.startsWith("--") ? `var(${value})` : value}
					onPick={() => onPick({ kind: CoverKind.Color, value })}
				/>
			))}
		</div>
	);
}

function Swatch({
	label,
	active,
	background,
	onPick,
}: {
	label: string;
	active: boolean;
	background: string;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			className={active ? "cover-picker__swatch cover-picker__swatch--active" : "cover-picker__swatch"}
			aria-label={label}
			aria-pressed={active}
			title={label}
			onClick={onPick}
		>
			<span className="cover-picker__swatch-fill" style={{ background }} aria-hidden="true" />
		</button>
	);
}

// ─── Virtualised cover grid (unbounded uploaded library) ────────────────

type CoverGridCell = {
	key: string;
	label: string;
	active: boolean;
	className: string;
	content: ReactNode;
	onPick: () => void;
};

/** Target cell min-width + gap, kept in sync with the CSS so the
 *  virtualised library and the plain swatch grid size cells identically
 *  (the user-reported mismatch). */
const CELL_MIN = 116;
const GRID_GAP = 8;
const CELL_ASPECT = 9 / 16;

/**
 * Row-virtualised grid for the uploaded library — that list grows
 * unbounded so it cannot paint all at once. The curated swatch palette
 * stays a plain grid (a small fixed set; virtualising it would only add
 * a layout-dependent scroll element that renders empty under jsdom).
 */
function VirtualCoverGrid({ cells }: { cells: readonly CoverGridCell[] }) {
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

	const cols = Math.max(1, Math.floor((width + GRID_GAP) / (CELL_MIN + GRID_GAP)));
	const cellWidth = cols > 0 ? (width - GRID_GAP * (cols - 1)) / cols : CELL_MIN;
	const rowHeight = cellWidth * CELL_ASPECT + GRID_GAP;

	// KBN-S-pickers: one Tab stop for the whole library; arrows move an
	// aria-activedescendant cursor, Enter picks (see `useVirtualGridNav`).
	const sections = useMemo(() => [{ key: "lib", label: null, items: cells }], [cells]);
	const { rows, containerProps, getCellProps, activeRow } = useVirtualGridNav(
		sections,
		cols,
		(cell: CoverGridCell) => cell.onPick(),
	);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => rowHeight,
		overscan: 4,
		getItemKey: (i) => rows[i]?.key ?? `r:${i}`,
	});

	useEffect(() => {
		if (activeRow !== null && activeRow < rows.length) virtualizer.scrollToIndex(activeRow);
	}, [activeRow, rows.length, virtualizer]);

	const { ref: setComposite, ...gridProps } = containerProps;
	const setRefs = (node: HTMLDivElement | null) => {
		scrollRef.current = node;
		setComposite(node);
	};

	return (
		<div ref={setRefs} className="cover-picker__lib" {...gridProps}>
			<div className="cover-picker__lib-inner" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((item) => {
					const row = rows[item.index];
					if (!row || row.kind !== VirtualGridRowKind.Cells) return null;
					return (
						// biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant grid — focus stays on the scroll container; rows/cells track the cursor and are intentionally not in the tab order.
						<div
							key={item.key}
							className="cover-picker__lib-row"
							role="row"
							style={{
								transform: `translateY(${item.start}px)`,
								height: item.size,
								gridTemplateColumns: `repeat(${cols}, 1fr)`,
							}}
						>
							{row.items.map((cell, j) => (
								<button
									key={cell.key}
									type="button"
									{...getCellProps(row.start + j)}
									className={cell.active ? `${cell.className} ${cell.className}--active` : cell.className}
									aria-label={cell.label || undefined}
									aria-pressed={cell.active}
									onClick={cell.onPick}
								>
									{cell.content}
								</button>
							))}
						</div>
					);
				})}
			</div>
		</div>
	);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp01(n: number): number {
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Pending-vs-applied equality so Apply can disable on a no-op. */
function sameCover(a: Cover | null, b: Cover | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.kind !== b.kind || a.value !== b.value) return false;
	const af = a.kind === CoverKind.Image ? a.focal : undefined;
	const bf = b.kind === CoverKind.Image ? b.focal : undefined;
	return (af?.x ?? 0.5) === (bf?.x ?? 0.5) && (af?.y ?? 0.5) === (bf?.y ?? 0.5);
}

function initialTabFor(value: Cover | null): PickerTab {
	if (value?.kind === CoverKind.Gradient || value?.kind === CoverKind.Color)
		return PickerTab.Palette;
	return PickerTab.Image;
}

function tabLabel(id: PickerTab, labels: CoverPickerLabels): string {
	if (id === PickerTab.Image) return labels.tabImage;
	if (id === PickerTab.Reposition) return labels.tabReposition;
	return labels.tabGallery;
}
