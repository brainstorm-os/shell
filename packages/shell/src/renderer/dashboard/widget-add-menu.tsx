/**
 * The "add widget" picker — extracted from `widgets-layer.tsx` so the trigger
 * can live in the dashboard header (an `IconButton`) instead of a floating "+"
 * on the dashboard surface. Opens the shared fancy-menus runtime with one
 * section per app, each row carrying its app's brand glyph; picking a row
 * creates the widget unplaced and lets the widgets layer choose its cell.
 */

import type { ContextMenuItem, sdkMenuIcon } from "@brainstorm-os/sdk/menus";
import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import type { ReactNode } from "react";
import type { RegisteredWidget } from "../../preload";
import { t } from "../i18n/t";
import { AppIcon } from "./app-icon";
import { resolveAppIconSrc } from "./app-icon-cache";
import { UNPLACED_WIDGET_POSITION, WidgetSize, widgetFootprint } from "./grid";

/**
 * A new widget is created UNPLACED — the layer chooses its cell.
 *
 * This used to stack each new card below the lowest existing one, which is a
 * position no one has checked against anything: on a full board it is a row off
 * the bottom of a stage that does not scroll, i.e. a widget you cannot see and
 * cannot remove. The picker has no idea how big the stage is or where the app
 * icons are; the widgets layer does, so it decides — exactly as main defers an
 * installed app's icon cell to the renderer (`UNPLACED_ICON_POSITION`).
 */
function addWidget(w: RegisteredWidget): void {
	const fp = widgetFootprint((w.size as WidgetSize) ?? WidgetSize.Medium);
	void window.brainstorm.dashboard.upsertWidget(`widget_${crypto.randomUUID()}`, {
		appId: w.appId,
		kind: w.widgetId,
		x: UNPLACED_WIDGET_POSITION.x,
		y: UNPLACED_WIDGET_POSITION.y,
		w: fp.w,
		h: fp.h,
		paused: false,
		collapsed: false,
	});
}

/** The owning app's brand glyph as a menu-row icon, so each app's widgets carry
 *  their app's mark instead of one shared generic glyph. Memoised per app id so
 *  the wrapper component identity is stable across menu re-renders. Falls back to
 *  the app's gradient initials when it ships no icon asset. */
const APP_MENU_ICON_CACHE = new Map<string, ReturnType<typeof sdkMenuIcon>>();

function appMenuIcon(appId: string, name: string): ReturnType<typeof sdkMenuIcon> {
	const cached = APP_MENU_ICON_CACHE.get(appId);
	if (cached) return cached;
	const Glyph = ({ size }: { size?: number; className?: string }): ReactNode => (
		<AppIcon
			name={name}
			seed={appId}
			src={resolveAppIconSrc(appId)}
			size={typeof size === "number" ? size : 16}
			glyph
		/>
	);
	const param = { icon: Glyph } as ReturnType<typeof sdkMenuIcon>;
	APP_MENU_ICON_CACHE.set(appId, param);
	return param;
}

/** Build the add-widget picker items, grouped under a section header per app. */
function buildAddItems(
	registered: readonly RegisteredWidget[],
	onAdd: (w: RegisteredWidget) => void,
): ContextMenuItem[] {
	const byApp = new Map<string, { name: string; widgets: RegisteredWidget[] }>();
	for (const w of registered) {
		const group = byApp.get(w.appId) ?? { name: w.appName, widgets: [] };
		group.widgets.push(w);
		byApp.set(w.appId, group);
	}
	const items: ContextMenuItem[] = [];
	for (const [appId, group] of byApp) {
		items.push({ id: `hdr-${appId}`, label: group.name, section: true });
		for (const w of group.widgets) {
			items.push({
				id: `${w.appId}:${w.widgetId}`,
				label: w.name,
				icon: appMenuIcon(w.appId, w.appName),
				onSelect: () => onAdd(w),
			});
		}
	}
	return items;
}

/** Open the add-widget picker anchored to `anchor` (the dashboard header's "+"
 *  button). */
export async function openAddWidgetMenu(anchor: HTMLElement): Promise<void> {
	const registered = await window.brainstorm.dashboard.registeredWidgets();
	const items: ContextMenuItem[] =
		registered.length === 0
			? [{ id: "empty", label: t("shell.widgets.add.empty"), disabled: true }]
			: buildAddItems(registered, addWidget);
	openAnchoredMenu(anchor.getBoundingClientRect(), items, {
		menuLabel: t("shell.widgets.add.label"),
		anchor,
	});
}
