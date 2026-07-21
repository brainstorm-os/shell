/**
 * Header right-group actions — the left-sidebar toggle, then the inspector
 * toggle, then the object ⋯ menu as the LAST element per the shared
 * `.app-header` contract (panel toggles live in the right group in every app).
 * The ⋯ is the catch-all overflow (the inspector has its own dedicated header
 * toggle, so it is not duplicated here); it opens through the shared fancy-menus
 * anchored menu — never a bespoke dropdown, and renders only when it has items.
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import { MenuAlign } from "@brainstorm-os/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm-os/sdk/panel-toggle";
import { type ReactElement, useCallback, useRef } from "react";
import { t } from "../i18n";

export function HeaderActions({
	sidebarOpen,
	onToggleSidebar,
	inspectorOpen,
	onToggleInspector,
	onSaveCopy,
}: {
	sidebarOpen: boolean;
	onToggleSidebar: () => void;
	inspectorOpen: boolean;
	onToggleInspector: () => void;
	onSaveCopy?: (() => void) | undefined;
}): ReactElement {
	const moreRef = useRef<HTMLButtonElement>(null);

	const openMore = useCallback((): void => {
		const anchor = moreRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		const items: AnchoredMenuItem[] = [];
		if (onSaveCopy)
			items.push({ label: t("menu.saveCopy"), icon: IconName.Download, onSelect: onSaveCopy });
		if (items.length === 0) return;
		openAnchoredMenu({ x: rect.right, y: rect.bottom }, items, {
			menuLabel: t("app.title"),
			anchor,
			align: MenuAlign.End,
		});
	}, [onSaveCopy]);

	return (
		<>
			<PanelToggleButton
				side={PanelSide.Left}
				open={sidebarOpen}
				onClick={onToggleSidebar}
				labels={{ show: t("sidebar.show"), hide: t("sidebar.hide") }}
				testId="sidebar-toggle"
			/>
			<PanelToggleButton
				side={PanelSide.Right}
				open={inspectorOpen}
				onClick={onToggleInspector}
				labels={{ show: t("menu.showInspector"), hide: t("menu.hideInspector") }}
				testId="inspector-toggle"
			/>
			{onSaveCopy ? (
				<button
					ref={moreRef}
					type="button"
					className="bs-object-menu__more"
					aria-haspopup="menu"
					aria-label={t("app.moreActions")}
					data-bs-tooltip={t("app.moreActions")}
					onClick={openMore}
				>
					<span className="bs-object-menu__more-dot" />
					<span className="bs-object-menu__more-dot" />
					<span className="bs-object-menu__more-dot" />
				</button>
			) : null}
		</>
	);
}
