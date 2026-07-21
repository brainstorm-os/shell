/**
 * Dashboard running-windows strip — the always-visible OS-shell-style
 * task panel per §Running-apps surface.
 *
 * Lives inside the dashboard footer (matched in height to the header).
 * Lists every open app window with the app's icon, the app name as the
 * visible label, and a focus indicator. The window's live title is in the
 * tooltip — we never paint it as the visible label so the task panel
 * doesn't flicker between the initial Electron title (the appId) and the
 * page title once the renderer assigns one.
 *
 * Click → focus the window. Right-click → context menu (close, minimize,
 * tile, move-to-monitor).
 *
 * v1 surface is the strip; thumbnails (OQ-135 cadence) come later.
 */

import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { type ContextMenuItem, openContextMenu } from "@brainstorm-os/sdk/menus";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MonitorSummary, TilePreset, type WindowEntry } from "../../shared/window-types";
import { t } from "../i18n/t";
import { Icon, IconName } from "../ui/icon";
import { AppIcon } from "./app-icon";

export type WindowStripProps = {
	entries: readonly WindowEntry[];
	monitors: readonly MonitorSummary[];
	onFocus: (id: string) => void;
	onClose: (id: string) => void;
	onMinimize: (id: string) => void;
	onTile: (id: string, preset: TilePreset, monitorId?: string) => void;
	onMoveToMonitor: (id: string, monitorId: string) => void;
};

function WindowStripInner(props: WindowStripProps) {
	const { entries, monitors, onFocus, onClose, onMinimize, onTile, onMoveToMonitor } = props;

	// Right-click → the shared fancy-menu (same chrome / escape-stack / glass
	// as every other context menu) anchored at the cursor. Built fresh per
	// open so the monitor list + window id are current.
	const openWindowMenu = (entry: WindowEntry, point: { x: number; y: number }): void => {
		const otherMonitors = monitors.filter((m) => m.id !== entry.monitorId);
		const items: ContextMenuItem[] = [
			{ id: "minimize", label: t("shell.windowMenu.minimize"), onSelect: () => onMinimize(entry.id) },
			{
				id: "fill",
				label: t("shell.windowMenu.fillScreen"),
				onSelect: () => onTile(entry.id, TilePreset.Fill),
			},
			{
				id: "tile-left",
				label: t("shell.windowMenu.tileLeft"),
				onSelect: () => onTile(entry.id, TilePreset.LeftHalf),
			},
			{
				id: "tile-right",
				label: t("shell.windowMenu.tileRight"),
				onSelect: () => onTile(entry.id, TilePreset.RightHalf),
			},
			{
				id: "center",
				label: t("shell.windowMenu.center"),
				onSelect: () => onTile(entry.id, TilePreset.Center),
			},
			...(otherMonitors.length > 0
				? [
						{
							id: "move-to-display",
							label: t("shell.windowMenu.moveToDisplay"),
							// The displays are a pick-one set → a cascade submenu, not a
							// disabled heading splayed above loose monitor rows.
							submenu: otherMonitors.map((m) => ({
								id: `monitor-${m.id}`,
								label: m.label,
								onSelect: () => onMoveToMonitor(entry.id, m.id),
							})),
						},
					]
				: []),
			{
				id: "close",
				label: t("shell.windowMenu.closeWindow"),
				destructive: true,
				onSelect: () => onClose(entry.id),
			},
		];
		openContextMenu(point, items, { menuLabel: t("shell.windowMenu.region") });
	};

	// Stable left-to-right order: by app, then windowId. (MRU is the switcher's
	// job; the strip is a stable taskbar so muscle memory works.) Memoised so
	// the sort doesn't run on unrelated state changes (menu open/close).
	const ordered = useMemo(
		() =>
			[...entries].sort((a, b) => {
				if (a.appId !== b.appId) return a.appId < b.appId ? -1 : 1;
				return a.windowId < b.windowId ? -1 : 1;
			}),
		[entries],
	);

	// KBN: the running-windows strip is a horizontal toolbar — ←/→/Home/End move
	// a roving cursor across the open-window buttons (one Tab stop, not one per
	// window); Enter/Space focuses the cursor's window. Toolbar items are native
	// buttons, so no item role and no selection state (`SelectionAttribute.None`)
	// — the keyboard cursor is the only "current item" signal; the focused-window
	// highlight (`--focused`) is a separate OS-focus concept.
	const [cursor, setCursor] = useState(0);
	useEffect(() => {
		setCursor((prev) =>
			ordered.length === 0 ? -1 : Math.min(Math.max(prev, 0), ordered.length - 1),
		);
	}, [ordered.length]);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: ordered.length,
		activeIndex: cursor,
		onActiveIndexChange: setCursor,
		onActivate: (index) => {
			const entry = ordered[index];
			if (entry) onFocus(entry.id);
		},
		role: "toolbar",
		selectionAttribute: SelectionAttribute.None,
	});

	// Overflow affordance: when the track can't fit every tile, show scroll
	// buttons so the off-screen windows stay reachable (the bug — a hidden
	// scrollbar left them stranded). Recomputed on resize, scroll, and whenever
	// the window count changes (a new tile grows scrollWidth without a resize).
	const stripRef = useRef<HTMLDivElement | null>(null);
	const [overflow, setOverflow] = useState({ left: false, right: false });
	const recomputeOverflow = useCallback(() => {
		const el = stripRef.current;
		if (!el) return;
		const left = el.scrollLeft > 1;
		const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
		setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: ordered.length is an intentional re-run trigger — a new tile grows scrollWidth without resizing the strip, so the ResizeObserver alone misses it
	useEffect(() => {
		recomputeOverflow();
		const el = stripRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(recomputeOverflow);
		ro.observe(el);
		return () => ro.disconnect();
	}, [recomputeOverflow, ordered.length]);
	// Keep the keyboard cursor's tile visible when arrowing into the overflow.
	useEffect(() => {
		const el = stripRef.current;
		if (!el || cursor < 0) return;
		const btn = el.children[cursor] as HTMLElement | undefined;
		if (typeof btn?.scrollIntoView === "function") {
			btn.scrollIntoView({ inline: "nearest", block: "nearest" });
		}
	}, [cursor]);
	const scrollByPage = (dir: -1 | 1): void => {
		const el = stripRef.current;
		if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: "smooth" });
	};

	return (
		<div className="window-strip-wrap">
			{overflow.left && (
				<button
					type="button"
					className="window-strip__scroll window-strip__scroll--left"
					tabIndex={-1}
					aria-label={t("shell.windowStrip.scrollLeft")}
					onClick={() => scrollByPage(-1)}
				>
					<Icon name={IconName.CaretDown} size={14} />
				</button>
			)}
			<div
				{...containerProps}
				ref={stripRef}
				onScroll={recomputeOverflow}
				className="window-strip"
				aria-label={t("shell.windowStrip.label")}
			>
				{ordered.map((entry, index) => (
					<button
						key={entry.id}
						type="button"
						{...getItemProps(index)}
						className={
							entry.focused ? "window-strip__tile window-strip__tile--focused" : "window-strip__tile"
						}
						data-state={entry.state}
						onClick={() => {
							setCursor(index);
							onFocus(entry.id);
						}}
						onContextMenu={(e) => {
							e.preventDefault();
							openWindowMenu(entry, { x: e.clientX, y: e.clientY });
						}}
						title={entry.title ? `${entry.appName} — ${entry.title}` : entry.appName}
						aria-label={t("shell.windowStrip.tile.aria", {
							app: entry.appName,
							title: entry.title || entry.appName,
						})}
					>
						<AppIcon
							name={entry.appName}
							seed={entry.appId}
							src={`brainstorm://app-icon/${encodeURIComponent(entry.appId)}`}
							size={18}
							glyph
						/>
						<span className="window-strip__label">{entry.appName}</span>
					</button>
				))}
			</div>
			{overflow.right && (
				<button
					type="button"
					className="window-strip__scroll window-strip__scroll--right"
					tabIndex={-1}
					aria-label={t("shell.windowStrip.scrollRight")}
					onClick={() => scrollByPage(1)}
				>
					<Icon name={IconName.CaretDown} size={14} />
				</button>
			)}
		</div>
	);
}

/* Memoised so the strip doesn't reconcile its tile list when an
 * unrelated Dashboard re-render fires — props are referentially stable
 * (entries/monitors from state, callbacks via useCallback). */
export const WindowStrip = memo(WindowStripInner);
