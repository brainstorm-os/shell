/**
 * Tasks' delegated object-menu wiring. The implementation lives in
 * `@brainstorm-os/sdk/object-menu` (`bindDelegatedObjectMenu`, shared with
 * Bookmarks / Journal); this thin wrapper supplies the Tasks menu labels so
 * the list/sidebar call sites stay label-free (`bindDelegatedObjectMenu` with
 * 3 args, `createMoreButton()` with none).
 */

import {
	type CreateMoreButtonOptions,
	type DelegatedMenuResolver,
	type ObjectMenuChromeLabels,
	type ObjectMenuRuntime,
	bindDelegatedObjectMenu as bindShared,
	createMoreButton as createSharedMoreButton,
} from "@brainstorm-os/sdk/object-menu";
import { t } from "../i18n/t";

export { ENTITY_ID_ATTR, ENTITY_TYPE_ATTR, closeObjectMenu } from "@brainstorm-os/sdk/object-menu";

export type TaskMenuResolver = DelegatedMenuResolver;

const MENU_LABELS = {
	open: "tasks.menu.open",
	pin: "tasks.menu.pin",
	unpin: "tasks.menu.unpin",
	remove: "tasks.menu.remove",
	more: "tasks.menu.more",
} as const;

/** The localised label bundle the shared renderer needs — built per open
 *  (`t()` is a pure manifest lookup). */
function menuLabels(): Partial<ObjectMenuChromeLabels> {
	return {
		open: t(MENU_LABELS.open),
		pin: t(MENU_LABELS.pin),
		unpin: t(MENU_LABELS.unpin),
		remove: t(MENU_LABELS.remove),
		moreActions: t(MENU_LABELS.more),
	};
}

export function createMoreButton(options: CreateMoreButtonOptions = {}): HTMLButtonElement {
	return createSharedMoreButton(t(MENU_LABELS.more), options);
}

export function bindDelegatedObjectMenu(
	container: HTMLElement,
	getRuntime: () => ObjectMenuRuntime,
	resolve: TaskMenuResolver,
): void {
	bindShared(container, getRuntime, resolve, menuLabels);
}
