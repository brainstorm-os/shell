/**
 * The "add widget" picker — extracted from `widgets-layer.tsx` so the trigger
 * can live in the dashboard header (an `IconButton`) instead of a floating "+"
 * on the dashboard surface. Opens the shared fancy-menus runtime with one
 * section per app, each row carrying its app's brand glyph; picking a row
 * appends a new widget below the lowest existing one.
 */

import type { ContextMenuItem, sdkMenuIcon } from "@brainstorm-os/sdk/menus";
import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import type { ReactNode } from "react";
import type { DashboardWidget, RegisteredWidget } from "../../preload";
import { t } from "../i18n/t";
import { AppIcon } from "./app-icon";
import { resolveAppIconSrc } from "./app-icon-cache";
import { WidgetSize, widgetFootprint } from "./grid";

/** Next free stacking row — place a new widget below the lowest existing one. */
function nextWidgetRow(widgets: Record<string, DashboardWidget>): number {
	let bottom = 0;
	for (const w of Object.values(widgets)) bottom = Math.max(bottom, w.y + w.h);
	return bottom;
}

function addWidget(w: RegisteredWidget, widgets: Record<string, DashboardWidget>): void {
	const fp = widgetFootprint((w.size as WidgetSize) ?? WidgetSize.Medium);
	void window.brainstorm.dashboard.upsertWidget(`widget_${crypto.randomUUID()}`, {
		appId: w.appId,
		kind: w.widgetId,
		x: 0,
		y: nextWidgetRow(widgets),
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
 *  button). `widgets` is the current placement set, used to stack the new widget
 *  below the lowest existing one. */
export async function openAddWidgetMenu(
	anchor: HTMLElement,
	widgets: Record<string, DashboardWidget>,
): Promise<void> {
	const registered = await window.brainstorm.dashboard.registeredWidgets();
	const items: ContextMenuItem[] =
		registered.length === 0
			? [{ id: "empty", label: t("shell.widgets.add.empty"), disabled: true }]
			: buildAddItems(registered, (w) => addWidget(w, widgets));
	openAnchoredMenu(anchor.getBoundingClientRect(), items, {
		menuLabel: t("shell.widgets.add.label"),
		anchor,
	});
}
