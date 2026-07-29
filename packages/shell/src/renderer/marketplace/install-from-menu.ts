/**
 * "Install from…" — the marketplace's local-install affordance (AppForge-1).
 * Opens the shared fancy-menus runtime anchored to the toolbar button with the
 * two sideload sources (folder / `.brainstorm` file); the main process owns
 * the OS dialog, validation, and install, and returns a typed result this
 * module folds into toasts.
 */

import type { ContextMenuItem } from "@brainstorm-os/sdk/menus";
import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import {
	MarketplaceSideloadFailureCode,
	type MarketplaceSideloadResult,
	MarketplaceSideloadStatus,
	MarketplaceSignatureStatus,
} from "../../preload/marketplace-types";
import { t } from "../i18n/t";
import { ToastKind, pushToast } from "../ui/toasts";

const FAILURE_MESSAGE_KEY: Record<MarketplaceSideloadFailureCode, string> = {
	[MarketplaceSideloadFailureCode.NotAllowed]: "shell.marketplace.install.fail.notAllowed",
	[MarketplaceSideloadFailureCode.NoVaultSession]: "shell.marketplace.install.fail.noVaultSession",
	[MarketplaceSideloadFailureCode.BadManifest]: "shell.marketplace.install.fail.badManifest",
	[MarketplaceSideloadFailureCode.AlreadyInstalled]:
		"shell.marketplace.install.fail.alreadyInstalled",
	[MarketplaceSideloadFailureCode.BadArchive]: "shell.marketplace.install.fail.badArchive",
	[MarketplaceSideloadFailureCode.ArchiveTooLarge]: "shell.marketplace.install.fail.archiveTooLarge",
	[MarketplaceSideloadFailureCode.InstallFailed]: "shell.marketplace.install.fail.installFailed",
	[MarketplaceSideloadFailureCode.BadRequest]: "shell.marketplace.install.fail.badRequest",
	[MarketplaceSideloadFailureCode.NotCodeFiles]: "shell.marketplace.install.fail.notCodeFiles",
	[MarketplaceSideloadFailureCode.BadPath]: "shell.marketplace.install.fail.badPath",
	[MarketplaceSideloadFailureCode.NoManifest]: "shell.marketplace.install.fail.noManifest",
	[MarketplaceSideloadFailureCode.SourceTooLarge]: "shell.marketplace.install.fail.sourceTooLarge",
};

export async function runSideloadInstall(
	invoke: () => Promise<MarketplaceSideloadResult>,
	onInstalled: () => void,
): Promise<void> {
	const result = await invoke();
	switch (result.status) {
		case MarketplaceSideloadStatus.Cancelled:
			return;
		case MarketplaceSideloadStatus.Installed: {
			// The unsigned state is surfaced right away — a local bundle carries
			// no publisher signature and the user should hear that honestly.
			const unsigned = result.app.signatureStatus === MarketplaceSignatureStatus.Unsigned;
			pushToast({
				kind: ToastKind.Success,
				title: t("shell.marketplace.install.installedToast.title"),
				body: t(
					unsigned
						? "shell.marketplace.install.installedToast.bodyUnsigned"
						: "shell.marketplace.install.installedToast.body",
					{ name: result.app.name, version: result.app.version },
				),
			});
			onInstalled();
			return;
		}
		case MarketplaceSideloadStatus.Failed:
			pushToast({
				kind: ToastKind.Error,
				title: t("shell.marketplace.install.failToast.title"),
				body: t(FAILURE_MESSAGE_KEY[result.code], { reason: result.reason }),
			});
			return;
	}
}

export type InstallFromMenuActions = {
	/** Re-pull listings after a successful install. */
	onInstalled: () => void;
	/** Open the shell-rendered vault (CodeFile) source picker (AppForge-2). */
	onInstallFromVault: () => void;
};

/** Open the install-from picker anchored to the toolbar button. */
export function openInstallFromMenu(anchor: HTMLElement, actions: InstallFromMenuActions): void {
	const { onInstalled, onInstallFromVault } = actions;
	const items: ContextMenuItem[] = [
		{
			id: "install-from-folder",
			label: t("shell.marketplace.install.fromFolder"),
			onSelect: () =>
				void runSideloadInstall(() => window.brainstorm.marketplace.installFromFolder(), onInstalled),
		},
		{
			id: "install-from-file",
			label: t("shell.marketplace.install.fromFile"),
			onSelect: () =>
				void runSideloadInstall(() => window.brainstorm.marketplace.installFromFile(), onInstalled),
		},
		{
			id: "install-from-vault",
			label: t("shell.marketplace.install.fromVault"),
			onSelect: onInstallFromVault,
		},
	];
	openAnchoredMenu(anchor.getBoundingClientRect(), items, {
		menuLabel: t("shell.marketplace.install.menuLabel"),
		anchor,
	});
}
