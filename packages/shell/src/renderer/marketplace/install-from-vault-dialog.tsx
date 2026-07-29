/**
 * "Install from vault" — the shell-rendered picker over the vault's
 * `CodeFile/v1` app candidates (AppForge-2). The main process groups the code
 * files by `manifest.json` root and parses each manifest server-side; this
 * dialog only displays those summaries and hands the chosen candidate's
 * entity-id list back to the privileged `apps:install-from-vault` handler —
 * paths and content never travel through the renderer.
 *
 * The pre-install consent runs through the shared `confirm` primitive (the
 * same chrome the marketplace update-consent uses): app name, id, version,
 * requested capabilities, and the unsigned advisory. Toast folding reuses
 * `runSideloadInstall` from the install-from menu.
 */

import { useCallback, useEffect, useState } from "react";
import type { MarketplaceVaultAppSource } from "../../preload/marketplace-types";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { confirm } from "../ui/confirm";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { runSideloadInstall } from "./install-from-menu";

export type InstallFromVaultDialogProps = {
	onClose: () => void;
	/** Re-pull marketplace listings after a successful install. */
	onInstalled: () => void;
};

export function InstallFromVaultDialog({ onClose, onInstalled }: InstallFromVaultDialogProps) {
	const [sources, setSources] = useState<MarketplaceVaultAppSource[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	useEffect(() => {
		let stale = false;
		void window.brainstorm.marketplace.listVaultAppSources().then((result) => {
			if (stale) return;
			if (result.ok) setSources(result.sources);
			else setLoadError(result.reason);
		});
		return () => {
			stale = true;
		};
	}, []);

	const install = useCallback(
		async (source: MarketplaceVaultAppSource): Promise<void> => {
			const manifest = source.manifest;
			if (!manifest) return;
			const caps =
				manifest.capabilities.length > 0
					? manifest.capabilities.join(", ")
					: t("shell.marketplace.vaultInstall.confirm.capsNone");
			const accepted = await confirm({
				title: t("shell.marketplace.vaultInstall.confirm.title", { name: manifest.name }),
				body: t("shell.marketplace.vaultInstall.confirm.body", {
					id: manifest.id,
					version: manifest.version,
					caps,
				}),
				confirmLabel: t("shell.marketplace.vaultInstall.confirm.install"),
			});
			if (!accepted) return;
			setBusyId(source.manifestEntityId);
			try {
				await runSideloadInstall(
					() => window.brainstorm.marketplace.installFromVault(source.fileIds),
					() => {
						onInstalled();
						onClose();
					},
				);
			} finally {
				setBusyId(null);
			}
		},
		[onClose, onInstalled],
	);

	return (
		<Popover
			title={t("shell.marketplace.vaultInstall.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			bodyPadding={PopoverBodyPadding.Comfortable}
			fitContent
			testId="install-from-vault-dialog"
		>
			<p className="marketplace__vault-summary">{t("shell.marketplace.vaultInstall.summary")}</p>
			{loadError !== null ? (
				<p className="marketplace__vault-empty">{loadError}</p>
			) : sources === null ? (
				<p className="marketplace__vault-empty">{t("shell.common.loading")}</p>
			) : sources.length === 0 ? (
				<p className="marketplace__vault-empty">{t("shell.marketplace.vaultInstall.empty")}</p>
			) : (
				<ul
					className="marketplace__vault-sources"
					aria-label={t("shell.marketplace.vaultInstall.listLabel")}
				>
					{sources.map((source) => (
						<li key={source.manifestEntityId} className="marketplace__update-row">
							<div className="marketplace__update-info">
								<span className="marketplace__update-name">
									{source.manifest
										? source.manifest.name
										: source.rootDir || t("shell.marketplace.vaultInstall.rootLabel")}
								</span>
								<span className="marketplace__update-version">
									{t("shell.marketplace.vaultInstall.meta", {
										root: source.rootDir || t("shell.marketplace.vaultInstall.rootLabel"),
										count: source.fileCount,
									})}
								</span>
								{source.problem !== null && (
									<span className="marketplace__vault-problem">
										{t("shell.marketplace.vaultInstall.invalid", { reason: source.problem })}
									</span>
								)}
							</div>
							<Button
								variant={ButtonVariant.Primary}
								size={ButtonSize.Md}
								disabled={source.manifest === null}
								loading={busyId === source.manifestEntityId}
								onClick={() => void install(source)}
								{...(source.problem !== null ? { title: source.problem } : {})}
							>
								{t("shell.marketplace.vaultInstall.install")}
							</Button>
						</li>
					))}
				</ul>
			)}
		</Popover>
	);
}
