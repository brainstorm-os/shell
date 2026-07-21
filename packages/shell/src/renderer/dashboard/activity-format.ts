/**
 * Shared presentation for background-activity operations — the icon + the
 * localized-title key per {@link ActivityKind}. Kept in one place so the chip
 * summary and the popover rows can't drift (DRY). Pure; the actual `t()` call
 * happens at the consumer so these stay string-key mappers.
 */

import { ActivityKind } from "@brainstorm-os/protocol/activity-types";
import { IconName } from "../ui/icon";

export function iconForActivityKind(kind: ActivityKind): IconName {
	switch (kind) {
		case ActivityKind.ModelDownload:
			return IconName.Download;
		case ActivityKind.Indexing:
			return IconName.Update;
		case ActivityKind.Sync:
			return IconName.Cloud;
		case ActivityKind.Import:
			return IconName.Download;
		case ActivityKind.Export:
			return IconName.Update;
	}
}

/** i18n key for an operation's human title. The kind value IS the key suffix
 *  (the sanctioned string wire form of the enum). */
export function titleKeyForActivityKind(kind: ActivityKind): string {
	return `shell.dashboard.activity.kind.${kind}`;
}
