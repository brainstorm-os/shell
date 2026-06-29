/**
 * Start-menu app grid — a browse-first, searchable grid of EVERY installed
 * app (independent of what's pinned to the dashboard), so the dashboard can
 * stay clean while every app is still one click away. Complements the
 * type-to-find launcher palette (`⌘ Space`); this is the launch/browse/pin
 * surface, opened from the footer Start button or `⌘⇧Space`. The per-app
 * right-click menu is where pinning lives now (Open · Pin/Unpin · Uninstall),
 * replacing the old header "pin an app" picker.
 *
 * Reuses the launcher's ranking (`filterApps`), the shared `AppIcon` with its
 * running indicator, and the dashboard pin path (`onPin`). Keyboard is a 2-D
 * roving grid via `useCompositeKeyboard` (Orientation.Grid); the search input
 * hands focus down into the grid on ArrowDown / ArrowRight, and Enter in the
 * search box launches the top-ranked app.
 */

import { Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { IconName } from "@brainstorm/sdk/icon";
import { openContextMenu, sdkMenuIcon } from "@brainstorm/sdk/menus";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InstalledApp } from "../../preload";
import { t } from "../i18n/t";
import { filterApps } from "../launcher/grouped-results";
import { IconName as UiIconName } from "../ui/icon";
import { Popover } from "../ui/popover";
import { PopoverSize } from "../ui/popover-types";
import { TextField } from "../ui/text-field";
import { confirmAndUninstallApp } from "./app-actions";
import { AppIcon } from "./app-icon";
import "./app-grid.css";

const GRID_COLUMNS = 5;

export type AppGridProps = {
	open: boolean;
	onClose: () => void;
	/** Launch an app by id (the dashboard owns the IPC + any teardown). */
	onLaunch: (appId: string) => void;
	/** Pin the app to the dashboard (reuses the dashboard's icon-place path). */
	onPin: (app: InstalledApp) => void;
	/** Remove the app's dashboard pin (the dashboard owns the icon state). */
	onUnpin: (appId: string) => void;
	/** App ids that currently have a dashboard pin — drives Pin vs Unpin. */
	pinnedAppIds: ReadonlySet<string>;
};

export function AppGrid({ open, onClose, onLaunch, onPin, onUnpin, pinnedAppIds }: AppGridProps) {
	const [apps, setApps] = useState<InstalledApp[]>([]);
	const [query, setQuery] = useState("");
	const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
	const [cursor, setCursor] = useState(0);
	const gridRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		let cancelled = false;
		void window.brainstorm.apps.listInstalled().then((list) => {
			if (!cancelled) setApps(list);
		});
		void window.brainstorm.apps.listRunning().then((ids) => {
			if (!cancelled) setRunning(new Set(ids));
		});
		const off = window.brainstorm.apps.onRunningChanged((ids) => setRunning(new Set(ids)));
		return () => {
			cancelled = true;
			off();
		};
	}, [open]);

	const filtered = useMemo(() => filterApps(query.trim().toLowerCase(), apps), [query, apps]);

	useEffect(() => {
		setCursor((c) => (filtered.length === 0 ? 0 : Math.min(Math.max(c, 0), filtered.length - 1)));
	}, [filtered.length]);

	const launch = useCallback(
		(app: InstalledApp) => {
			onLaunch(app.id);
			onClose();
		},
		[onLaunch, onClose],
	);

	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Grid,
		columns: GRID_COLUMNS,
		count: filtered.length,
		activeIndex: cursor,
		onActiveIndexChange: setCursor,
		onActivate: (index) => {
			const app = filtered[index];
			if (app) launch(app);
		},
	});

	const focusGrid = useCallback((index: number) => {
		setCursor(index);
		requestAnimationFrame(() => {
			gridRef.current?.querySelector<HTMLElement>('[data-app-grid-cell][tabindex="0"]')?.focus();
		});
	}, []);

	if (!open) return null;

	return (
		<Popover
			title={t("shell.appGrid.title")}
			onClose={onClose}
			size={PopoverSize.Large}
			testId="app-grid"
		>
			<div className="app-grid">
				<TextField
					type="search"
					iconLeft={UiIconName.Search}
					data-testid="app-grid-search"
					autoFocus
					value={query}
					placeholder={t("shell.appGrid.placeholder")}
					aria-label={t("shell.appGrid.placeholder")}
					onChange={setQuery}
					// keyboard-exempt: input-local combobox bridge — Arrow Down/Right move
					// focus from the search box into the grid (which itself uses
					// `useCompositeKeyboard`), Enter launches the top result. Scoped to the
					// search input, not an app shortcut.
					onKeyDown={(e) => {
						if ((e.key === "ArrowDown" || e.key === "ArrowRight") && filtered.length > 0) {
							e.preventDefault();
							focusGrid(0);
						} else if (e.key === "Enter") {
							const app = filtered[0];
							if (app) {
								e.preventDefault();
								launch(app);
							}
						}
					}}
				/>
				{filtered.length === 0 ? (
					<p className="app-grid__empty">{t("shell.appGrid.empty")}</p>
				) : (
					<div
						{...containerProps}
						ref={gridRef}
						className="app-grid__grid"
						style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}
						aria-label={t("shell.appGrid.gridLabel")}
					>
						{filtered.map((app, index) => (
							<button
								key={app.id}
								type="button"
								data-app-grid-cell
								{...getItemProps(index)}
								className="app-grid__cell"
								onClick={() => launch(app)}
								onContextMenu={(e) => {
									e.preventDefault();
									const pinned = pinnedAppIds.has(app.id);
									openContextMenu(
										{ x: e.clientX, y: e.clientY },
										[
											{
												id: "open",
												label: t("shell.appGrid.menu.open"),
												icon: sdkMenuIcon(IconName.OpenExternal),
												onSelect: () => launch(app),
											},
											pinned
												? {
														id: "unpin",
														label: t("shell.appGrid.menu.unpin"),
														icon: sdkMenuIcon(IconName.PinSlash),
														onSelect: () => onUnpin(app.id),
													}
												: {
														id: "pin",
														label: t("shell.appGrid.menu.pin"),
														icon: sdkMenuIcon(IconName.Pin),
														onSelect: () => onPin(app),
													},
											{
												id: "uninstall",
												label: t("shell.dashboard.iconMenu.uninstall"),
												icon: sdkMenuIcon(IconName.Trash),
												destructive: true,
												onSelect: () => {
													void confirmAndUninstallApp(app.id, app.name);
												},
											},
										],
										{ menuLabel: app.name },
									);
								}}
								title={app.description ?? app.name}
							>
								<AppIcon
									name={app.name}
									seed={app.id}
									src={app.hasIcon ? window.brainstorm.apps.iconUrl(app.id, app.version) : null}
									size={48}
									withRunningIndicator
									running={running.has(app.id)}
								/>
								<span className="app-grid__label">{app.name}</span>
							</button>
						))}
					</div>
				)}
			</div>
		</Popover>
	);
}
