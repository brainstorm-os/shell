/**
 * The board's own object-menu verbs.
 *
 * The shared `buildObjectMenuItems` only ships the cross-app items — Open,
 * Pin/Unpin, Share, Remove. Everything else is an app CONTRIBUTION via
 * `extraItems` (Notes contributes Cover + Save-as-template, Books contributes
 * Import + Toggle library). Whiteboard contributed none, so its header ⋯ read
 * "Open / Pin to dashboard" and nothing else while every sibling app offered a
 * full verb set (329 screenshot audit).
 *
 * Only verbs the board GENUINELY supports appear here. Change icon is the one
 * that matters most: the header's icon button renders nothing at all when the
 * board has no icon yet, so without this row an icon-less board can never be
 * given one. Delete is deliberately absent — the app has no board-delete path
 * to call, and a row that throws is worse than a row that isn't there.
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import type { ObjectMenuExtraItem } from "@brainstorm-os/sdk/object-menu";

export type BoardMenuExtrasOptions = {
	/** A locked (read-only) board exposes no mutating verb. */
	locked: boolean;
	labels: { rename: string; changeIcon: string };
	onRename: () => void;
	onChangeIcon: () => void;
};

export function boardMenuExtras(options: BoardMenuExtrasOptions): ObjectMenuExtraItem[] {
	if (options.locked) return [];
	return [
		{
			id: "rename",
			label: options.labels.rename,
			icon: IconName.Pencil,
			run: options.onRename,
		},
		{
			id: "change-icon",
			label: options.labels.changeIcon,
			icon: IconName.Palette,
			run: options.onChangeIcon,
		},
	];
}
