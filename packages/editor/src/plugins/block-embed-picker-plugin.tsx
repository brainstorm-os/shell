/**
 * BlockEmbedPickerPlugin — anchored entity picker for the `/embed` slash
 * command. Listens to `embedPickerStore`; the command opens the store with
 * the host paragraph's key + bounding rect, the plugin opens the shared
 * `openSearchPicker` over a title-filtered entity list, and the chosen
 * entity becomes a `BlockEmbedNode` replacing that paragraph.
 *
 * Hoisted from `apps/notes` (F-070 embed parity): the entity source is the
 * package's injected `entity-index` (`fetchEntities`) and the live-block
 * resolution rides `getEditorHost().blocks` — no app runtime import, so
 * `<FullEditorPlugins>` mounts it for Journal / Tasks / every host.
 *
 * The runtime owns the picker chrome, the filter input, keyboard nav, and
 * dismissal; this plugin owns only the entity source (loaded once per
 * open), the title filter (`filterEntities` ranking + self-exclusion + a
 * type scope), and committing the embed. The current entity is excluded so
 * a document can't embed itself.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import {
	type SearchPickerItem,
	closeSearchPicker,
	openSearchPicker,
} from "@brainstorm-os/sdk/menus";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";
import { type EditorT, useEditorT } from "../i18n";
import { getEditorHost } from "./editor-host";
import { applyEmbedInsertion } from "./embed-insert";
import { embedPickerStore, useEmbedPickerTarget } from "./embed-picker-store";
import { fetchEntities } from "./entity-index";
import { entityDisplayName, filterEntities } from "./mention-ops";

const EMPTY_ROW_ID = "__empty";

export type BlockEmbedPickerPluginProps = {
	/** The currently-open entity's id, excluded from the picker so the
	 *  user can't embed the document into itself. `null` for a surface
	 *  with no entity identity. */
	currentNoteId: string | null;
};

export function BlockEmbedPickerPlugin({ currentNoteId }: BlockEmbedPickerPluginProps) {
	const [editor] = useLexicalComposerContext();
	const target = useEmbedPickerTarget();
	const t = useEditorT();

	useEffect(() => {
		if (!target) return;
		let cancelled = false;

		const excludeIds = currentNoteId ? new Set([currentNoteId]) : new Set<string>();
		const focusEditor = (): void => {
			editor.focus();
			const rootElement = editor.getRootElement();
			if (rootElement && document.activeElement !== rootElement) {
				rootElement.focus({ preventScroll: true });
			}
		};

		const open = (entities: readonly VaultEntity[]): void => {
			// A type-scoped open (Notes' `/database`, `/graph`) narrows the
			// candidate list before the title filter.
			const scoped = target.typeFilter
				? entities.filter((e) => e.type === target.typeFilter)
				: entities;

			const toItems = (query: string): SearchPickerItem[] => {
				const results = filterEntities(scoped, query, excludeIds);
				if (results.length === 0) {
					return [
						{
							id: EMPTY_ROW_ID,
							label:
								query.length > 0
									? t("editor.embed.menu.noResults", { query })
									: target.typeFilter
										? t("editor.embed.menu.emptyFiltered")
										: t("editor.embed.menu.empty"),
							disabled: true,
						},
					];
				}
				return results.map((result) => ({
					id: result.entity.id,
					label: entityDisplayName(result.entity),
					caption: shortTypeLabel(result.entity.type, t),
				}));
			};

			const pick = (entity: VaultEntity): void => {
				// Ask the host's block registry which live block renders this
				// entity's type; embed that block id when one claims it, else fall
				// back to the shell card. The lookup is async, so the picker has
				// already closed by the time this lands — the insertion targets the
				// stored paragraph key.
				const blocks = getEditorHost().blocks;
				const insert = (blockId: string | null): void => {
					applyEmbedInsertion(editor, target.paragraphKey, {
						entityId: entity.id,
						entityType: entity.type,
						label: entityDisplayName(entity),
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
				placeholder: t("editor.embed.menu.placeholder"),
				ariaLabel: t("editor.embed.menu.region"),
				...(anchorEl ? { anchor: anchorEl } : {}),
				filter: toItems,
				onSelect: (id) => {
					const entity = scoped.find((e) => e.id === id);
					if (entity) pick(entity);
				},
				// Any close (commit / Escape / outside-click) clears the host store
				// and returns focus to the editor's prior selection.
				onClose: () => {
					embedPickerStore.close();
					focusEditor();
				},
			});
		};

		void fetchEntities().then((entities) => {
			if (!cancelled) open(entities);
		});

		return () => {
			cancelled = true;
			closeSearchPicker();
		};
	}, [target, editor, currentNoteId, t]);

	// The picker is rendered by the menu runtime, not as a child here.
	return null;
}

/** Reverse-DNS id → human-readable tail (`io.brainstorm.notes/Note/v1`
 *  → `Note`). Same shape as the card's footer label, kept local so the
 *  picker doesn't import the node module just for one helper. */
function shortTypeLabel(entityType: string, t: EditorT): string {
	if (!entityType) return t("editor.embed.typeUnknown");
	const lastSlash = entityType.lastIndexOf("/");
	const tail = lastSlash >= 0 ? entityType.slice(lastSlash + 1) : entityType;
	const trimmed = tail.replace(/^v\d+$/, "");
	if (trimmed.length > 0) return trimmed;
	const penultimate = entityType.slice(0, lastSlash);
	const prevSlash = penultimate.lastIndexOf("/");
	return prevSlash >= 0 ? penultimate.slice(prevSlash + 1) : penultimate;
}
