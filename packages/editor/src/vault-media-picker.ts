/**
 * "Choose from vault" (B11.28) — opens the shared search picker over the
 * vault's existing files and hands the chosen one back with the caret it was
 * opened from, so the insert lands where the user typed the command even
 * though the picker took focus in between.
 */

import { formatBytes } from "@brainstorm-os/sdk/format-bytes";
import { type SearchPickerItem, openSearchPicker } from "@brainstorm-os/sdk/menus";
import {
	$getSelection,
	$isRangeSelection,
	type BaseSelection,
	type LexicalEditor,
	type NodeKey,
} from "lexical";
import type { EditorT } from "./i18n";
import { fetchEntities } from "./plugins/entity-index";
import { type VaultMedia, VaultMediaFilter, filterVaultMedia } from "./vault-media";

const EMPTY_ROW_ID = "vault-media:empty";

export type VaultMediaPick = {
	media: VaultMedia;
	/** The caret's top-level block when the picker opened. */
	blockKey: NodeKey | null;
	/** The selection when the picker opened, for an inline insert. */
	selection: BaseSelection | null;
};

export function vaultMediaRows(
	media: readonly VaultMedia[],
	filter: VaultMediaFilter,
	query: string,
	t: EditorT,
): readonly SearchPickerItem[] {
	if (media.length === 0) {
		const label =
			query.trim().length > 0
				? t("editor.media.vault.noResults", { query: query.trim() })
				: filter === VaultMediaFilter.Image
					? t("editor.media.vault.emptyImages")
					: t("editor.media.vault.empty");
		return [{ id: EMPTY_ROW_ID, label, disabled: true }];
	}
	return media.map((m) => ({
		id: m.id,
		label: m.name,
		caption: m.size === null ? m.mime : `${m.mime} · ${formatBytes(m.size)}`,
	}));
}

export function openVaultMediaPicker(
	editor: LexicalEditor,
	filter: VaultMediaFilter,
	t: EditorT,
	onPick: (pick: VaultMediaPick) => void,
): void {
	let blockKey: NodeKey | null = null;
	let selection: BaseSelection | null = null;
	editor.getEditorState().read(() => {
		const sel = $getSelection();
		selection = sel ? sel.clone() : null;
		if ($isRangeSelection(sel)) {
			blockKey = sel.anchor.getNode().getTopLevelElement()?.getKey() ?? null;
		}
	});
	const anchor = blockKey ? editor.getElementByKey(blockKey) : null;
	void fetchEntities().then((entities) => {
		let shown: VaultMedia[] = [];
		const rows = (query: string): readonly SearchPickerItem[] => {
			shown = filterVaultMedia(entities, filter, query);
			return vaultMediaRows(shown, filter, query, t);
		};
		openSearchPicker({
			placeholder:
				filter === VaultMediaFilter.Image
					? t("editor.media.vault.placeholderImage")
					: t("editor.media.vault.placeholder"),
			ariaLabel: t("editor.media.vault.region"),
			...(anchor ? { anchor } : {}),
			filter: rows,
			onSelect: (id) => {
				const media = shown.find((m) => m.id === id);
				if (media) onPick({ media, blockKey, selection });
			},
			onClose: () => editor.focus(),
		});
	});
}
