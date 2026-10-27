/**
 * Notes' thin host for the shared `@brainstorm-os/sdk/icon-picker`. The one
 * picker (full emoji + Phosphor coverage, virtualised) lives in the SDK;
 * Notes only wires the host-specific bits the SDK convention keeps out of
 * shared surfaces: localized `labels` (each via notes' own `t()`) and the
 * close shortcut through the renderer shortcut registry.
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { IconPicker as SdkIconPicker, iconUploadFromIcons } from "@brainstorm-os/sdk/icon-picker";
import { useMemo } from "react";
import { t } from "../i18n/t";
import { ActionId } from "../keyboard/action-ids";
import { useShortcut } from "../keyboard/use-shortcut";
import { getBrainstorm } from "../store/runtime";

export type IconPickerProps = {
	value: Icon | null;
	onChange: (icon: Icon | null) => void;
	onClose: () => void;
};

export function IconPicker({ value, onChange, onClose }: IconPickerProps) {
	useShortcut(ActionId.CloseIconPicker, (event) => {
		event.preventDefault();
		onClose();
	});

	// Wire the custom-image Upload/Library tabs to the vault icon store when the
	// shell exposes it (B11.14). Absent on older shells — the tabs stay
	// placeholders (the SDK picker handles the undefined case).
	const iconUpload = useMemo(() => iconUploadFromIcons(getBrainstorm()?.services.icons), []);

	return (
		<SdkIconPicker
			value={value}
			onChange={onChange}
			onClose={onClose}
			{...(iconUpload ? { iconUpload } : {})}
			labels={{
				region: t("notes.iconPicker.region"),
				close: t("notes.iconPicker.close"),
				remove: t("notes.iconPicker.remove"),
				search: t("notes.iconPicker.search"),
				noMatch: t("notes.iconPicker.noMatch"),
				tabEmoji: t("notes.iconPicker.tab.emoji"),
				tabIcon: t("notes.iconPicker.tab.icon"),
				tabUpload: t("notes.iconPicker.tab.upload"),
				tabLibrary: t("notes.iconPicker.tab.library"),
				uploadPending: t("notes.iconPicker.upload.pending"),
				libraryPending: t("notes.iconPicker.library.pending"),
				uploadAction: t("notes.iconPicker.upload.action"),
				uploading: t("notes.iconPicker.upload.uploading"),
				dropHint: t("notes.iconPicker.upload.dropHint"),
				unsupportedFile: t("notes.iconPicker.upload.unsupported"),
				libraryEmpty: t("notes.iconPicker.library.empty"),
				loading: t("notes.iconPicker.library.loading"),
				libraryItem: t("notes.iconPicker.library.item"),
				skinToneRegion: t("notes.iconPicker.skinTone"),
				tintRegion: t("notes.iconPicker.tint"),
			}}
		/>
	);
}
