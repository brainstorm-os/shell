/**
 * AddPropertyMenuPlugin — wires the shared SDK `<AddPropertyPicker>` to
 * Notes' editor targets. The picker (search + create-new) is owned by
 * `@brainstorm-os/sdk/property-ui` so every properties panel shares one
 * flow; this plugin only supplies the four editor mutations.
 *
 * Opens whenever `addPropertyStore` carries a target (set by the
 * `/property` slash command, the gutter / right-click "Add property"
 * action, or a `PropertyListBlockNode`'s "+" affordance). `onPick`
 * dispatches into one of three editor mutations matching the target
 * kind — see `add-property-ops.ts` — or, for the panel's bind-to-note
 * target, calls the caller's `onPick`.
 *
 * Anchors against viewport-relative `DOMRect`s carried by the store
 * so callers don't need access to the editor's DOM (the slash
 * command computes its anchor via `editor.getElementByKey`).
 */

import { AddPropertyPicker, type AddPropertyPickerLabels } from "@brainstorm-os/sdk/property-ui";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { type ReactNode, useCallback, useMemo } from "react";
import { t } from "../i18n/t";
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
		case AddPropertyTargetKind.BindToNote:
			return `bind:${Math.round(target.anchor.top)}:${Math.round(target.anchor.left)}`;
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
				case AddPropertyTargetKind.BindToNote:
					target.onPick(propertyKey);
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

function useNotesPickerLabels(): Partial<AddPropertyPickerLabels> {
	return useMemo<Partial<AddPropertyPickerLabels>>(
		() => ({
			region: t("notes.addProperty.region"),
			search: t("notes.addProperty.search"),
			searchPlaceholder: t("notes.addProperty.searchPlaceholder"),
			results: t("notes.addProperty.results"),
			empty: t("notes.addProperty.empty"),
			emptyCatalog: t("notes.addProperty.emptyCatalog"),
			loading: t("notes.addProperty.loading"),
			createNew: t("notes.addProperty.createNew"),
			typeMulti: t("notes.addProperty.typeMulti"),
			types: {
				text: t("notes.addProperty.type.text"),
				number: t("notes.addProperty.type.number"),
				boolean: t("notes.addProperty.type.boolean"),
				date: t("notes.addProperty.type.date"),
				select: t("notes.addProperty.type.select"),
				url: t("notes.addProperty.type.url"),
				email: t("notes.addProperty.type.email"),
				phone: t("notes.addProperty.type.phone"),
				file: t("notes.addProperty.type.file"),
				reference: t("notes.addProperty.type.reference"),
				"rich-text": t("notes.addProperty.type.richText"),
			},
			form: {
				region: t("notes.inlinePropertyForm.region"),
				back: t("notes.inlinePropertyForm.back"),
				nameLabel: t("notes.inlinePropertyForm.nameLabel"),
				namePlaceholder: t("notes.inlinePropertyForm.namePlaceholder"),
				kindLabel: t("notes.inlinePropertyForm.kindLabel"),
				formatLabel: t("notes.inlinePropertyForm.formatLabel"),
				multiLabel: t("notes.inlinePropertyForm.multiLabel"),
				cancel: t("notes.inlinePropertyForm.cancel"),
				submit: t("notes.inlinePropertyForm.submit"),
				moreOptionsHint: t("notes.inlinePropertyForm.moreOptionsHint"),
				kindText: t("notes.inlinePropertyForm.kind.text"),
				kindNumber: t("notes.inlinePropertyForm.kind.number"),
				kindBoolean: t("notes.inlinePropertyForm.kind.boolean"),
				kindDate: t("notes.inlinePropertyForm.kind.date"),
				kindSelect: t("notes.inlinePropertyForm.kind.select"),
				kindRelation: t("notes.inlinePropertyForm.kind.relation"),
				kindFile: t("notes.inlinePropertyForm.kind.file"),
				kindFormula: t("notes.inlinePropertyForm.kind.formula"),
				formulaLabel: t("notes.inlinePropertyForm.formula.label"),
				formulaPlaceholder: t("notes.inlinePropertyForm.formula.placeholder"),
				formulaHint: t("notes.inlinePropertyForm.formula.hint"),
				formatPlain: t("notes.inlinePropertyForm.format.plain"),
				formatUrl: t("notes.inlinePropertyForm.format.url"),
				formatEmail: t("notes.inlinePropertyForm.format.email"),
				formatPhone: t("notes.inlinePropertyForm.format.phone"),
				formatCurrency: t("notes.inlinePropertyForm.format.currency"),
				formatPercent: t("notes.inlinePropertyForm.format.percent"),
				formatDuration: t("notes.inlinePropertyForm.format.duration"),
				currencyLabel: t("notes.inlinePropertyForm.currencyLabel"),
				optionsLabel: t("notes.inlinePropertyForm.optionsLabel"),
				optionsPlaceholder: t("notes.inlinePropertyForm.optionsPlaceholder"),
				optionsHint: t("notes.inlinePropertyForm.optionsHint"),
				relationTargetLabel: t("notes.inlinePropertyForm.relationTargetLabel"),
				relationTargetAny: t("notes.inlinePropertyForm.relationTargetAny"),
			},
		}),
		[],
	);
}
