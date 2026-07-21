/**
 * DashboardIconsLayer — renders the icons placed on the dashboard. The wire
 * format stays `{x, y}` pixels (legacy DashboardStore shape), but display
 * positions come from `layoutIcons`: it clamps stored intents to the
 * currently visible grid (so resizing the window doesn't leave icons
 * stranded off-screen) and resolves collisions deterministically (so two
 * icons can never occupy the same cell with one hidden under the other).
 */

import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { IconName } from "@brainstorm-os/sdk/icon";
import { type ContextMenuItem, openContextMenu, sdkMenuIcon } from "@brainstorm-os/sdk/menus";
import {
	type CSSProperties,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { DashboardIcon, PinResolution } from "../../preload";
import { t } from "../i18n/t";
import { EntityIcon } from "../ui/entity-icon";
import { confirmAndUninstallApp } from "./app-actions";
import { AppIcon } from "./app-icon";
import { resolveAppIconSrc, setAppIcons } from "./app-icon-cache";
import "./app-icon.css";
import { Icon } from "../ui/icon";
import {
	GRID_OUTER_MARGIN,
	GRID_UNIT,
	type GridCell,
	type GridPoint,
	type GridSize,
	ICON_FOOTPRINT_W,
	ICON_PIN_GLYPH_RATIO,
	type IconSize,
	cellToPoint,
	getCellSize,
	getIconSize,
	isLegacyIconLayout,
	layoutIcons,
	pointToCell,
	repackIcons,
} from "./grid";
import { SHELL_SURFACES, type ShellSurfaceId, isShellSurfaceId } from "./shell-surfaces";
import { SQUIRCLE_RADIUS_PERCENT } from "./squircle";

type DragState = {
	id: string;
	pointerId: number;
	offsetX: number;
	offsetY: number;
	x: number;
	y: number;
	startClientX: number;
	startClientY: number;
	element: HTMLElement;
};

/** Below this much pointer movement we treat pointer-down/up as a click, not
 *  a drag. Matches the platform-typical 4-5 px slop for click vs drag. */
const CLICK_MOVEMENT_THRESHOLD_PX = 5;

export type DashboardIconsLayerProps = {
	icons: Record<string, DashboardIcon>;
	/** Live-resolved presentation for every `kind: "entity"` icon, keyed
	 *  by icon id (Stage 7.13). App icons have no entry. */
	pins: Record<string, PinResolution>;
	onMoveIcon: (id: string, x: number, y: number) => void;
	onActivate: (id: string, icon: DashboardIcon) => void;
	/** Whether the one-shot pre-8px → 8px re-pack has already run for this vault
	 *  (persisted). When true the migration effect is skipped entirely, so a
	 *  top-left-clustered layout isn't reset on every launch. */
	gridMigrated: boolean;
	/** Called once after the migration runs (or is determined unnecessary) to
	 *  persist the flag so it never runs again. */
	onGridMigrated: () => void;
};

function DashboardIconsLayerInner({
	icons,
	pins,
	onMoveIcon,
	onActivate,
	gridMigrated,
	onGridMigrated,
}: DashboardIconsLayerProps) {
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	// Live drag position lives in a ref + direct DOM transform on the
	// dragged button. We re-render only when a drag starts/ends (via
	// `draggingId`), never on every pointermove — that keeps the icon
	// tracking the pointer 1:1 even under load, and avoids reflowing all
	// the other icons 60–120 times a second.
	const dragRef = useRef<DragState | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [running, setRunning] = useState<Set<string>>(new Set());
	// App-icon presence/version lives in a module-scope + localStorage cache
	// (see `app-icon-cache`) so it survives the lock→unlock unmount and the
	// first paint after unlock already resolves real icon `src`s. This tick
	// only forces a re-render when `listInstalled` brings a change.
	const [, bumpIconCache] = useState(0);
	// Optimistic position holdover: between `onPointerUp` (which sets the
	// snapped target) and the DashboardStore snapshot round-tripping back
	// via IPC, the `icons` prop still carries the pre-drag cell. Rendering
	// against that for those few ms makes the icon flash back before
	// jumping to the new one. The holdover map paints the snapped target
	// until the snapshot catches up, then clears the entry. Stored as
	// `{col, row}` to match the wire format.
	const [pending, setPending] = useState<Record<string, GridCell>>({});
	// Surface size in CSS pixels. Recomputed via ResizeObserver so icon
	// positions reflow proportionally when the window changes. Initialised
	// from `window` so the first render already paints in the right spot.
	const [viewport, setViewport] = useState<GridPoint>(() => ({
		x: window.innerWidth,
		y: window.innerHeight,
	}));

	useEffect(() => {
		const el = surfaceRef.current;
		if (!el) return;
		// Coalesce ResizeObserver bursts to a single rAF tick. macOS Live
		// Resize fires the observer many times per frame; without the rAF
		// gate every tick triggers a synchronous setState → re-render. The
		// per-icon position is now CSS-driven (container-query units in
		// `icons-layer.css`), so this state only drives inner-element
		// sizing (AppIcon `size`, drag pixel math) — one frame of lag
		// there is invisible.
		let raf = 0;
		const apply = () => {
			raf = 0;
			const rect = el.getBoundingClientRect();
			setViewport((prev) =>
				prev.x === rect.width && prev.y === rect.height ? prev : { x: rect.width, y: rect.height },
			);
		};
		const schedule = () => {
			if (raf !== 0) return;
			raf = requestAnimationFrame(apply);
		};
		apply();
		const observer = new ResizeObserver(schedule);
		observer.observe(el);
		return () => {
			observer.disconnect();
			if (raf !== 0) cancelAnimationFrame(raf);
		};
	}, []);

	const cellSize = useMemo(() => getCellSize(viewport), [viewport]);
	const iconSize = useMemo(() => getIconSize(cellSize), [cellSize]);

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.apps.listRunning().then((ids) => {
			if (!cancelled) setRunning(new Set(ids));
		});
		const off = window.brainstorm.apps.onRunningChanged((ids) => {
			setRunning(new Set(ids));
		});
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	// Refetch installed apps when the visible icon set changes — so newly
	// pinned apps pick up their `hasIcon` flag and version, and we stop
	// issuing `brainstorm://app-icon/...` requests for apps that ship no
	// icon asset. The result feeds the persistent cache; we only re-render
	// when it actually changed.
	const iconTargetsKey = Object.values(icons)
		.map((i) => `${i.kind}:${i.target}`)
		.sort()
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: iconTargetsKey is a refresh-trigger string derived from the current icons; the effect intentionally re-runs when the visible icon set changes.
	useEffect(() => {
		let cancelled = false;
		const refetch = () => {
			void window.brainstorm.apps.listInstalled().then((list) => {
				if (cancelled) return;
				if (setAppIcons(list)) bumpIconCache((n) => n + 1);
			});
		};
		refetch();
		// An app (re)install mid-session must refresh the cache too — a
		// `listInstalled` that lands during the installer's uninstall→install
		// window persists `hasIcon:false` and every icon paints initials until
		// the next boot (F-380).
		const off = window.brainstorm.apps.onChanged?.(refetch);
		return () => {
			cancelled = true;
			off?.();
		};
	}, [iconTargetsKey]);

	// When pointerup decides the gesture was a drag (movement above threshold),
	// the browser may still fire a click event on the same element. The ref
	// below tells the onClick handler to swallow that trailing click so a drag
	// doesn't accidentally launch the app.
	const suppressNextClickRef = useRef(false);

	// Cell-coord placements (`{col, row}`) — pixel positions are computed
	// at paint time in CSS from container-query units (see `icons-layer.css`),
	// so this memo no longer needs to re-run on viewport changes.
	const placements = useMemo(() => {
		const intents = Object.entries(icons).map(([id, icon]) => {
			const override = pending[id];
			if (override) return { id, col: override.col, row: override.row };
			const cell = storedIconCell(icon);
			return { id, col: cell.col, row: cell.row };
		});
		const map = new Map<string, GridCell>();
		for (const p of layoutIcons(intents)) {
			map.set(p.id, { col: p.col, row: p.row });
		}
		return map;
	}, [icons, pending]);

	// Element whose `style.transform` was imperatively set by the last
	// pointer-move. Cleared in a layout effect after the drag-end commit
	// lands, so the CSS-driven (container-query) placement takes over
	// without flashing through the stale pixel transform.
	const justDraggedRef = useRef<HTMLElement | null>(null);

	const endDrag = useCallback(() => {
		if (dragRef.current) {
			justDraggedRef.current = dragRef.current.element;
		}
		dragRef.current = null;
		setDraggingId(null);
	}, []);

	useLayoutEffect(() => {
		if (draggingId !== null) return;
		const el = justDraggedRef.current;
		if (!el) return;
		el.style.transform = "";
		justDraggedRef.current = null;
	}, [draggingId]);

	// Free placement on the 8px grid: snap the icon's top-left to the nearest cell
	// and keep it there — no collision resolution (overlap is allowed; the user
	// owns the layout). `pointToCell` clamps so the icon stays on-screen.
	const commitDrop = useCallback(
		(drag: DragState) => {
			suppressNextClickRef.current = true;
			const target = pointToCell({ x: drag.x, y: drag.y }, viewport);
			setPending((prev) => ({ ...prev, [drag.id]: target }));
			onMoveIcon(drag.id, target.col, target.row);
			endDrag();
		},
		[endDrag, onMoveIcon, viewport],
	);

	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>, id: string, icon: DashboardIcon) => {
			if (event.button !== 0) return;
			event.currentTarget.setPointerCapture(event.pointerId);
			// Seed the drag from where the icon is *actually rendered* (the
			// placement after collision-resolution + pending overrides), not
			// from its stored cell. Otherwise an icon displaced by a sibling
			// (or sitting in a pending-drop holdover) would teleport to its
			// stored cell the instant you touch it.
			const cell = placements.get(id) ?? storedIconCell(icon);
			const startPoint = centerInCell(cell, viewport, iconSize, cellSize);
			dragRef.current = {
				id,
				pointerId: event.pointerId,
				offsetX: event.clientX - startPoint.x,
				offsetY: event.clientY - startPoint.y,
				x: startPoint.x,
				y: startPoint.y,
				startClientX: event.clientX,
				startClientY: event.clientY,
				element: event.currentTarget,
			};
			setDraggingId(id);
		},
		[placements, viewport, iconSize, cellSize],
	);

	const onPointerMove = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			const drag = dragRef.current;
			if (!drag || event.pointerId !== drag.pointerId) return;
			// Safety net: if the primary button is no longer pressed, the
			// pointer was released somewhere we didn't observe (focus loss,
			// release outside the window, dialog steal). Without this, the
			// icon keeps chasing the cursor — it "runs away from the mouse"
			// because `dragRef` is still set so every move re-positions it.
			if ((event.buttons & 1) === 0) {
				commitDrop(drag);
				return;
			}
			const x = event.clientX - drag.offsetX;
			const y = event.clientY - drag.offsetY;
			drag.x = x;
			drag.y = y;
			drag.element.style.transform = `translate(${x}px, ${y}px)`;
		},
		[commitDrop],
	);

	const onPointerUp = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			const drag = dragRef.current;
			if (!drag || event.pointerId !== drag.pointerId) return;
			event.currentTarget.releasePointerCapture(event.pointerId);
			const dx = Math.abs(event.clientX - drag.startClientX);
			const dy = Math.abs(event.clientY - drag.startClientY);
			if (dx <= CLICK_MOVEMENT_THRESHOLD_PX && dy <= CLICK_MOVEMENT_THRESHOLD_PX) {
				// Below the slop — treat as a click. Let the trailing `onClick`
				// fire to activate (it also handles keyboard Enter/Space).
				endDrag();
				return;
			}
			commitDrop(drag);
		},
		[endDrag, commitDrop],
	);

	const onIconClick = useCallback(
		(id: string, icon: DashboardIcon) => {
			if (suppressNextClickRef.current) {
				suppressNextClickRef.current = false;
				return;
			}
			onActivate(id, icon);
		},
		[onActivate],
	);

	const buildMenuItems = useCallback(
		(iconId: string, icon: DashboardIcon): ContextMenuItem[] => {
			const items: ContextMenuItem[] = [
				{
					id: "open",
					label: t("shell.dashboard.iconMenu.open"),
					icon: sdkMenuIcon(IconName.OpenExternal),
					onSelect: () => onActivate(iconId, icon),
				},
				{
					id: "remove",
					// A pin (entity/view) is "unpinned"; an app tile is
					// "removed from dashboard". Both are pure dashboard-state
					// — the underlying object/app is untouched (OQ-DASH-1).
					label:
						icon.kind === "app"
							? t("shell.dashboard.iconMenu.removeFromDashboard")
							: t("shell.dashboard.iconMenu.removePin"),
					icon: sdkMenuIcon(IconName.PinSlash),
					onSelect: () => {
						void window.brainstorm.dashboard.removeIcon(iconId);
					},
				},
			];
			if (icon.kind === "app") {
				items.push({
					id: "uninstall",
					label: t("shell.dashboard.iconMenu.uninstall"),
					icon: sdkMenuIcon(IconName.Trash),
					destructive: true,
					onSelect: () => {
						void confirmAndUninstallApp(icon.target, icon.label);
					},
				});
			}
			return items;
		},
		[onActivate],
	);

	const onContextMenu = useCallback(
		(event: React.MouseEvent<HTMLButtonElement>, iconId: string, icon: DashboardIcon) => {
			event.preventDefault();
			// macOS trackpad two-finger-tap dispatches both `contextmenu` AND a
			// synthesized button-0 `click` — without this flag the menu opens
			// AND the app launches. Suppress the trailing click so right-click
			// only ever opens the menu.
			suppressNextClickRef.current = true;
			openContextMenu({ x: event.clientX, y: event.clientY }, buildMenuItems(iconId, icon), {
				menuLabel: t("shell.dashboard.iconMenu.open"),
			});
		},
		[buildMenuItems],
	);

	// Clear pending entries once the prop catches up to the optimistic
	// target. Storage round-trips integer cell indices, so equality is
	// exact.
	useEffect(() => {
		setPending((prev) => {
			let changed = false;
			const next: Record<string, GridCell> = {};
			for (const [id, cell] of Object.entries(prev)) {
				const live = icons[id];
				if (!live) {
					changed = true;
					continue;
				}
				const liveCell = storedIconCell(live);
				if (liveCell.col === cell.col && liveCell.row === cell.row) {
					changed = true;
					continue;
				}
				next[id] = cell;
			}
			return changed ? next : prev;
		});
	}, [icons]);

	// One-time migration off the pre-8px coarse 14-col grid. Gated on a PERSISTED
	// flag, not re-derived from coordinates every launch: a valid 8px layout
	// clustered top-left is indistinguishable from the old coarse format by
	// position alone (both sit within `LEGACY_GRID_MAX`), so a per-launch
	// heuristic re-packed — reset — the user's arrangement on every restart. Once
	// the flag is set the migration never runs again; we set it as soon as icons
	// have loaded (re-packing first only if the layout actually looks legacy). The
	// session ref makes it robust to the IPC round-trip: the persisted flag lags
	// the `onGridMigrated()` call by a snapshot, and `viewport`/`icons` can tick
	// in that window — without the guard the repack would run twice.
	const migratedThisSessionRef = useRef(false);
	useEffect(() => {
		if (gridMigrated || migratedThisSessionRef.current) return;
		const entries = Object.entries(icons);
		// Wait for icons to load before marking migrated, so an empty first frame
		// doesn't burn the one-shot before the real layout arrives.
		if (entries.length === 0) return;
		migratedThisSessionRef.current = true;
		const cells = entries.map(([, icon]) => ({
			col: Math.max(0, Math.floor(icon.x)),
			row: Math.max(0, Math.floor(icon.y)),
		}));
		if (isLegacyIconLayout(cells)) {
			const columns = Math.floor(
				(viewport.x - 2 * GRID_OUTER_MARGIN) / (ICON_FOOTPRINT_W * GRID_UNIT),
			);
			for (const placed of repackIcons(
				entries.map(([id]) => id),
				columns,
			)) {
				onMoveIcon(placed.id, placed.col, placed.row);
			}
		}
		onGridMigrated();
	}, [gridMigrated, onGridMigrated, icons, onMoveIcon, viewport]);

	// KBN-S-dashboard: the icon grid is a spatial composite — arrow keys move a
	// roving cursor to the nearest icon in that direction (macOS-Desktop style,
	// `Orientation.Spatial` over each icon's `{col, row}` cell), Enter/Space
	// activates, a click syncs the cursor. The container is a labelled `group`
	// of native icon buttons (no item role, no selection-state attribute) — one
	// Tab stop into the grid, not one per icon.
	const entryList = useMemo(() => Object.entries(icons), [icons]);
	const cells = useMemo(
		() => entryList.map(([id, icon]) => placements.get(id) ?? storedIconCell(icon)),
		[entryList, placements],
	);
	const [cursor, setCursor] = useState(0);
	useEffect(() => {
		setCursor((prev) =>
			entryList.length === 0 ? -1 : Math.min(Math.max(prev, 0), entryList.length - 1),
		);
	}, [entryList.length]);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Spatial,
		count: entryList.length,
		activeIndex: cursor,
		onActiveIndexChange: setCursor,
		onActivate: (index) => {
			const entry = entryList[index];
			if (entry) onActivate(entry[0], entry[1]);
		},
		cells,
		role: "group",
		selectionAttribute: SelectionAttribute.None,
	});
	// Merge the hook's container ref with `surfaceRef` (used by the ResizeObserver).
	const setSurface = useCallback(
		(el: HTMLDivElement | null) => {
			surfaceRef.current = el;
			containerProps.ref(el);
		},
		[containerProps.ref],
	);

	return (
		<div
			{...containerProps}
			ref={setSurface}
			className={draggingId !== null ? "dashboard-icons dashboard-icons--dragging" : "dashboard-icons"}
			aria-label={t("shell.dashboard.iconGrid")}
		>
			{entryList.map(([id, icon], index) => {
				const isDragging = draggingId === id;
				// Non-dragging icons get their pixel position from CSS
				// (container-query units in `icons-layer.css`), driven by
				// the `--icon-col` / `--icon-row` custom props below — so
				// resizing the window doesn't shake them while React
				// catches up. The dragging icon has its `style.transform`
				// imperatively driven by `onPointerMove`, which wins over
				// the CSS rule; on drag-end the layout effect above clears
				// it so CSS takes back over.
				const cell = placements.get(id) ?? storedIconCell(icon);
				const isRunning = icon.kind === "app" && running.has(icon.target);
				return (
					<button
						key={id}
						type="button"
						{...getItemProps(index)}
						className={
							isDragging
								? "dashboard-icons__icon dashboard-icons__icon--dragging"
								: "dashboard-icons__icon"
						}
						style={
							{
								"--icon-col": cell.col,
								"--icon-row": cell.row,
							} as CSSProperties
						}
						onPointerDown={(e) => onPointerDown(e, id, icon)}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
						onPointerCancel={endDrag}
						onClick={() => {
							setCursor(index);
							onIconClick(id, icon);
						}}
						onContextMenu={(e) => onContextMenu(e, id, icon)}
						data-testid={`dashboard-icon-${id}`}
					>
						{icon.kind === "app" ? (
							<AppIcon
								name={icon.label}
								seed={icon.target}
								size={iconSize.tile}
								src={resolveAppIconSrc(icon.target)}
								withRunningIndicator={true}
								running={isRunning}
							/>
						) : icon.kind === "shell-surface" && isShellSurfaceId(icon.target) ? (
							<ShellSurfaceTile surfaceId={icon.target} tileSize={iconSize.tile} />
						) : (
							<PinTile
								resolution={pins[id]}
								fallbackLabel={icon.label}
								tileSize={iconSize.tile}
								badgeSize={Math.round(iconSize.tile * 0.4)}
							/>
						)}
						<span className="dashboard-icons__label">{resolveLabel(pins[id], icon.label)}</span>
					</button>
				);
			})}
		</div>
	);
}

/* Memoised so the layer doesn't reconcile its (potentially many) icon
 * tiles when an unrelated Dashboard re-render fires — props are
 * referentially stable (icons/pins from the snapshot, callbacks via
 * useCallback). */
export const DashboardIconsLayer = memo(DashboardIconsLayerInner);

/** Resolve a stored icon's `{x, y}` into an 8px cell. `x`/`y` are cell indices
 *  (the icon's top-left); a pre-8px coarse-grid layout is re-packed once (see the
 *  migration effect), so no per-icon translation is needed here. */
function storedIconCell(icon: DashboardIcon): GridCell {
	return {
		col: Math.max(0, Math.floor(icon.x)),
		row: Math.max(0, Math.floor(icon.y)),
	};
}

/** Top-left pixel position of an icon button. On the fixed 8px grid the stored
 *  cell IS the icon's top-left anchor (no centring within a large cell), so this
 *  is just the cell origin. */
function centerInCell(
	cell: GridCell,
	viewport: GridPoint,
	_icon: IconSize,
	_cellSize: GridSize,
): GridPoint {
	return cellToPoint(cell, viewport);
}

/** The pinned object's label: the live-resolved title, falling back to
 *  the persisted `IconRecord.label` (which is also the tombstone caption
 *  once the object is gone). */
function resolveLabel(resolution: PinResolution | undefined, fallback: string): string {
	return resolution?.label || fallback;
}

/** Glyph hue for shell surfaces (Bin today). Shell chrome isn't a branded
 *  app, so it gets a single cool-slate rather than an entry in the per-app
 *  `APP_ICON_NEON` map — deepened to match the app glyphs' on-tile weight so
 *  it reads on both the light and graphite themed tile. */
const SHELL_SURFACE_GLYPH = "#7e8aa1";

/** Fraction of the tile the Bin's `<Icon>` glyph occupies so it matches the
 *  app glyphs (those sit at ~41% of the tile). */
const SHELL_SURFACE_GLYPH_SCALE = 0.51;

/**
 * Pinned shell-surface tile (Bin today; Settings / Marketplace could follow).
 * Mirrors `AppIcon`'s DOM and theme-following tile treatment: the shared
 * `.glass--strong` frosted `.app-icon__tile` surface (+ its gloss sheen and
 * edge from CSS) with the glyph in a deepened cool-slate, and the below-tile
 * dot reserve — so the Bin sits beside sibling app icons with identical chrome
 * and label baseline.
 */
function ShellSurfaceTile({
	surfaceId,
	tileSize,
}: { surfaceId: ShellSurfaceId; tileSize: number }) {
	const meta = SHELL_SURFACES[surfaceId];
	return (
		<span className="app-icon" aria-hidden="true">
			<span
				className="app-icon__tile glass--strong"
				style={{
					width: tileSize,
					height: tileSize,
					borderRadius: SQUIRCLE_RADIUS_PERCENT,
				}}
			>
				<span
					className="app-icon__surface-glyph"
					style={{ color: SHELL_SURFACE_GLYPH, display: "inline-flex" }}
				>
					<Icon
						name={meta.icon}
						size={Math.round(tileSize * SHELL_SURFACE_GLYPH_SCALE)}
						weight="regular"
					/>
				</span>
			</span>
			<span className="app-icon__dot" aria-hidden="true" />
		</span>
	);
}

/**
 * The visual for a pinned object (Stage 7.13): the object's **own**
 * universal icon (per [[per-object-icons-everywhere]] — never a
 * per-type map), with the opener app as a small bottom-right badge so
 * the user can tell which app it lives in at a glance. A dangling
 * target (deleted / binned) renders a greyed tombstone — the icon is
 * never auto-removed (OQ-DASH-1), the context menu's "Remove pin" is
 * the only way out.
 */
function PinTile({
	resolution,
	fallbackLabel,
	tileSize,
	badgeSize,
}: {
	resolution: PinResolution | undefined;
	fallbackLabel: string;
	tileSize: number;
	badgeSize: number;
}) {
	const missing = resolution?.missing ?? false;
	const label = resolveLabel(resolution, fallbackLabel);
	const appId = resolution?.appId ?? null;
	const appName = resolution?.appName ?? "";
	// The object's own icon (emoji / pack glyph) is inset inside the
	// tile-square box so it carries the same optical weight as a sibling
	// app squircle glyph (which has large built-in artwork padding). The
	// AppIcon fallback fills the box edge-to-edge — like an app tile —
	// so it is NOT inset.
	const hasOwnIcon = (resolution?.icon ?? null) !== null;
	const glyphSize = hasOwnIcon ? Math.round(tileSize * ICON_PIN_GLYPH_RATIO) : tileSize;
	// When the object has NO own icon the tile already renders the opener
	// app's squircle as its fallback (filling the whole box) — adding the
	// bottom-right app badge on top of that produces two identical app
	// glyphs on the same pin (canonical case: a `CodeFile` with no custom
	// icon pinned to the dashboard rendered two Code-Editor squircles).
	// The badge exists to disambiguate WHICH app the object belongs to,
	// so it's only useful when the main glyph is the object's own icon.
	const badge =
		appId === null || !hasOwnIcon ? null : (
			<span
				className="dashboard-icons__pin-badge"
				style={{ width: `${badgeSize}px`, height: `${badgeSize}px` }}
				aria-hidden="true"
			>
				<AppIcon name={appName} seed={appId} size={badgeSize} src={resolveAppIconSrc(appId)} />
			</span>
		);
	return (
		// Outer column mirrors `.app-icon`: the tile-square box, then a
		// dot-reserve spacer of the exact height the AppIcon reserves for
		// its running dot. Both variants thus present an identical
		// tile-block height, so the button's `gap` to the label below is
		// the same whether an app or a pinned object renders here.
		<span className="dashboard-icons__pin-block">
			<span
				className={
					missing ? "dashboard-icons__pin dashboard-icons__pin--missing" : "dashboard-icons__pin"
				}
				style={{ width: `${tileSize}px`, height: `${tileSize}px` }}
			>
				<EntityIcon
					icon={resolution?.icon ?? null}
					size={glyphSize}
					className="dashboard-icons__pin-object"
					// No object icon → fall back to the opener-app squircle (still
					// identifiable), or an id-seeded squircle when even the opener
					// is unknown. Never a broken-image box.
					fallback={
						<AppIcon
							name={label}
							seed={appId ?? fallbackLabel}
							size={tileSize}
							src={appId ? resolveAppIconSrc(appId) : null}
						/>
					}
				/>
				{badge}
			</span>
			<span className="dashboard-icons__pin-dot-reserve" aria-hidden="true" />
		</span>
	);
}
