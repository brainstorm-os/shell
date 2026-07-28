/**
 * AddPropertyMenuPlugin — wires the shared SDK `<AddPropertyPicker>` to
 * Notes' editor targets. The picker (search + create-new) is owned by
 * `@brainstorm-os/sdk/property-ui` so every properties panel shares one
 * flow; this plugin only supplies the three editor mutations.
 *
 * Opens whenever `addPropertyStore` carries a target (set by the
 * `/property` slash command, the gutter / right-click "Add property"
 * action, or a `PropertyListBlockNode`'s "+" affordance). `onPick`
 * dispatches into one of three editor mutations matching the target
 * kind — see `add-property-ops.ts`. (The right-panel bind flow lives in
 * the shared `<EntityPropertiesPanel>` since Props-4, not here.)
 *
 * Anchors against viewport-relative `DOMRect`s carried by the store
 * so callers don't need access to the editor's DOM (the slash
 * command computes its anchor via `editor.getElementByKey`).
 */

import { AddPropertyPicker } from "@brainstorm-os/sdk/property-ui";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCallback } from "react";
import { useNotesPickerLabels } from "../properties/picker-labels";
import {
	applyAddPropertyAppendToList,
	applyAddPropertyInsertAfter,
	applyAddPropertyReplaceParagraph,
} from "./add-property-ops";
import {
	type AddPropertyTarget,
	AddPropertyTargetKind,
	addPropertyStore,
	useAddPropertyTarget,
} from "./add-property-store";

export function AddPropertyMenuPlugin() {
	const [editor] = useLexicalComposerContext();
	const target = useAddPropertyTarget();

	if (!target) return null;
	return <AddPropertyMenu key={anchorKey(target)} target={target} editor={editor} />;
}

function anchorKey(target: AddPropertyTarget): string {
	switch (target.kind) {
		case AddPropertyTargetKind.ReplaceParagraph:
			return `paragraph:${target.paragraphKey}`;
		case AddPropertyTargetKind.InsertAfter:
			return `after:${target.blockKey}`;
		case AddPropertyTargetKind.AppendToList:
			return `list:${target.listKey}`;
	}
}

function AddPropertyMenu({
	target,
	editor,
}: {
	target: AddPropertyTarget;
	editor: ReturnType<typeof useLexicalComposerContext>[0];
}) {
	const onPick = useCallback(
		(propertyKey: string) => {
			switch (target.kind) {
				case AddPropertyTargetKind.ReplaceParagraph:
					applyAddPropertyReplaceParagraph(editor, target.paragraphKey, propertyKey);
					break;
				case AddPropertyTargetKind.InsertAfter:
					applyAddPropertyInsertAfter(editor, target.blockKey, propertyKey);
					break;
				case AddPropertyTargetKind.AppendToList:
					applyAddPropertyAppendToList(editor, target.listKey, propertyKey);
					break;
			}
		},
		[editor, target],
	);

	const labels = useNotesPickerLabels();

	return (
		<AddPropertyPicker
			anchor={target.anchor}
			onPick={onPick}
			onClose={() => addPropertyStore.close()}
			labels={labels}
		/>
	);
}
