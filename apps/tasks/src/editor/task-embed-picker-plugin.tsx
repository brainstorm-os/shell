/**
 * TaskEmbedPickerPlugin — the anchored task picker for the `/task` slash
 * command. Listens to `taskEmbedPickerStore`; the command opens the store
 * with the host paragraph's key + rect, the plugin opens the shared
 * `openSearchPicker` over a title-filtered list of Task entities, and the
 * chosen task becomes a `TaskEmbedNode` replacing that paragraph.
 *
 * The runtime owns the picker chrome, the filter input, keyboard nav, and
 * dismissal; this plugin owns only the entity source (loaded once per open),
 * the title filter (`filterTaskEntities` ranking + self-exclusion, scoped to
 * `brainstorm/Task/v1`), and committing the embed. The current task is
 * excluded so a task can't embed itself.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import {
	type SearchPickerItem,
	closeSearchPicker,
	openSearchPicker,
} from "@brainstorm-os/sdk/menus";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";
import { t } from "../i18n/t";
import { getBrainstorm } from "../storage/runtime";
import { applyTaskEmbedInsertion } from "./task-embed-insert";
import { taskEmbedPickerStore, useTaskEmbedPickerTarget } from "./task-embed-picker-store";

const TASK_TYPE = "brainstorm/Task/v1";
const EMPTY_ROW_ID = "__empty";

export type TaskEmbedPickerPluginProps = {
	/** The currently-open task's id, excluded from the picker so the user
	 *  can't embed the task into itself. `null` when no task is open. */
	currentTaskId: string | null;
};

/** Human title for a task entity — the `name` property, with a fallback. */
export function taskEntityTitle(entity: VaultEntity): string {
	const name = entity.properties.name ?? entity.properties.title;
	return typeof name === "string" && name.trim().length > 0
		? name.trim()
		: t("tasks.embed.untitled");
}

/** Filter Task entities by a case-insensitive title substring, excluding the
 *  current task. Exported for unit coverage of the matching logic. */
export function filterTaskEntities(
	entities: readonly VaultEntity[],
	query: string,
	excludeId: string | null,
): readonly VaultEntity[] {
	const needle = query.trim().toLowerCase();
	return entities.filter((entity) => {
		if (entity.type !== TASK_TYPE) return false;
		if (excludeId && entity.id === excludeId) return false;
		if (needle.length === 0) return true;
		return taskEntityTitle(entity).toLowerCase().includes(needle);
	});
}

export function TaskEmbedPickerPlugin({ currentTaskId }: TaskEmbedPickerPluginProps) {
	const [editor] = useLexicalComposerContext();
	const target = useTaskEmbedPickerTarget();

	useEffect(() => {
		if (!target) return;
		let cancelled = false;

		const focusEditor = (): void => {
			editor.focus();
			const rootElement = editor.getRootElement();
			if (rootElement && document.activeElement !== rootElement) {
				rootElement.focus({ preventScroll: true });
			}
		};

		const open = (entities: readonly VaultEntity[]): void => {
			const toItems = (query: string): SearchPickerItem[] => {
				const results = filterTaskEntities(entities, query, currentTaskId);
				if (results.length === 0) {
					return [
						{
							id: EMPTY_ROW_ID,
							label:
								query.length > 0 ? t("tasks.embed.menu.noResults", { query }) : t("tasks.embed.menu.empty"),
							disabled: true,
						},
					];
				}
				return results.map((entity) => ({
					id: entity.id,
					label: taskEntityTitle(entity),
				}));
			};

			const pick = (entity: VaultEntity): void => {
				// Ask the registry which live block renders a Task (the app's own
				// inline-task block). When one claims it we embed that block id;
				// otherwise the embed falls back to the shell card. The lookup is
				// async, so the picker has already closed by the time this lands —
				// the insertion targets the stored paragraph key.
				const blocks = getBrainstorm()?.services.blocks;
				const insert = (blockId: string | null): void => {
					applyTaskEmbedInsertion(editor, target.paragraphKey, {
						entityId: entity.id,
						entityType: entity.type,
						label: taskEntityTitle(entity),
						...(blockId ? { blockId } : {}),
					});
				};
				if (blocks) {
					blocks
						.forType(entity.type)
						.then(insert)
						.catch(() => insert(null));
				} else {
					insert(null);
				}
			};

			const anchorEl = editor.getElementByKey(target.paragraphKey);
			openSearchPicker({
				placeholder: t("tasks.embed.menu.placeholder"),
				ariaLabel: t("tasks.embed.menu.region"),
				...(anchorEl ? { anchor: anchorEl } : {}),
				filter: toItems,
				onSelect: (id) => {
					const entity = entities.find((e) => e.id === id);
					if (entity) pick(entity);
				},
				// Any close (commit / Escape / outside-click) clears the host store
				// and returns focus to the editor's prior selection.
				onClose: () => {
					taskEmbedPickerStore.close();
					focusEditor();
				},
			});
		};

		const vaultEntities = getBrainstorm()?.services.vaultEntities;
		if (!vaultEntities) {
			open([]);
		} else {
			void vaultEntities
				.list()
				.then((snapshot) => {
					if (!cancelled) open(snapshot.entities);
				})
				.catch((error) => {
					console.warn("[tasks/embed] vaultEntities.list failed:", error);
					if (!cancelled) open([]);
				});
		}

		return () => {
			cancelled = true;
			closeSearchPicker();
		};
	}, [target, editor, currentTaskId]);

	// The picker is rendered by the menu runtime, not as a child here.
	return null;
}
