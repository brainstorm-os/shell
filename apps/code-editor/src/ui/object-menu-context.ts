/**
 * `codeFileObjectMenuContext` — the single place the Code editor builds
 * the shared cross-app object menu's context for one of its objects (a
 * `CodeFile`). Both per-object surfaces (each file-list row, the open
 * file's pane header) go through this so they offer the *same* Open /
 * Pin·Unpin / … in the same order with the same labels — the menu itself
 * is rendered by the shared SDK chrome, never a hand-rolled popup.
 *
 * Resolved lazily at open time by the SDK trigger (the row/header element
 * is reused across re-renders); returning `null` makes the trigger inert
 * (e.g. the renderer booted outside a vault, so there is no runtime).
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import type { ObjectMenuContext } from "@brainstorm-os/sdk/object-menu";
import { t } from "../i18n";
import { fileName } from "../logic/code-view";
import { CODE_FILE_ENTITY_TYPE, type CodeEditorRuntime } from "../runtime";

/** App-owned file actions the host wires into the shared object menu —
 *  Rename (an `extraItem`, before Remove) and Delete (the destructive
 *  `onRemove` slot). Both are omitted when not editable (a read-only
 *  adapted StylePack row, or a runtime without the write surface) so the
 *  menu degrades to Open / Pin only. */
export type CodeFileMenuActions = {
	onRename?: () => void;
	onDelete?: () => void;
};

export function codeFileObjectMenuContext(
	file: { id: string; path: string },
	runtime: CodeEditorRuntime | null,
	actions: CodeFileMenuActions = {},
): ObjectMenuContext {
	if (!runtime) return null;
	return {
		target: { entityId: file.id, entityType: CODE_FILE_ENTITY_TYPE, label: fileName(file.path) },
		runtime,
		labels: { open: t("menuOpen"), menuRegion: t("menuRegion") },
		...(actions.onRename
			? {
					extraItems: [
						{
							id: "rename",
							label: t("menuRename"),
							icon: IconName.Pencil,
							run: actions.onRename,
						},
					],
				}
			: {}),
		...(actions.onDelete ? { onRemove: actions.onDelete } : {}),
	};
}
