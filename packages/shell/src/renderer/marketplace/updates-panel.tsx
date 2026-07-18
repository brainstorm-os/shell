/**
 * Updates panel — available catalog updates for installed apps (the app-update
 * plane, per §Two update planes). Each row shows the version bump;
 * an update requesting new capabilities is gated behind an explicit consent
 * confirm before applying (capabilities never grow silently). Uses the shared
 * `<Button>` + `confirm` + toast primitives, no bespoke chrome.
 */

import {
	type MarketplaceInstallResult,
	type MarketplaceUpdate,
	MarketplaceUpdateClassification,
} from "../../preload/marketplace-types";
import { t, tIfKey } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { confirm } from "../ui/confirm";
import { ToastKind, pushToast } from "../ui/toasts";

export type UpdatesPanelProps = {
	updates: MarketplaceUpdate[] | null;
	loading: boolean;
	onApply: (appId: string) => Promise<MarketplaceInstallResult>;
};

export function UpdatesPanel({ updates, loading, onApply }: UpdatesPanelProps) {
	if (loading || updates === null) {
		return <p className="marketplace__loading">{t("shell.common.loading")}</p>;
	}
	if (updates.length === 0) {
		return <p className="marketplace__empty">{t("shell.marketplace.updates.upToDate")}</p>;
	}
	return (
		<ul className="marketplace__updates" aria-label={t("shell.marketplace.updates.label")}>
			{updates.map((update) => (
				<UpdateRow key={update.id} update={update} onApply={onApply} />
			))}
		</ul>
	);
}

function UpdateRow({
	update,
	onApply,
}: { update: MarketplaceUpdate; onApply: UpdatesPanelProps["onApply"] }) {
	const needsConsent = update.classification === MarketplaceUpdateClassification.NeedsConsent;
	const apply = () => {
		void (async () => {
			if (needsConsent) {
				const accepted = await confirm({
					title: t("shell.marketplace.updates.consent.title", { name: tIfKey(update.name) }),
					body: t("shell.marketplace.updates.consent.body", {
						caps: update.newCapabilities.join(", "),
					}),
					confirmLabel: t("shell.marketplace.updates.apply"),
				});
				if (!accepted) return;
			}
			const result = await onApply(update.id);
			pushToast(
				result.ok
					? {
							kind: ToastKind.Success,
							title: t("shell.marketplace.updates.appliedToast.title"),
							body: t("shell.marketplace.updates.appliedToast.body", {
								name: tIfKey(update.name),
								version: update.toVersion,
							}),
						}
					: {
							kind: ToastKind.Error,
							title: t("shell.marketplace.updates.failToast.title"),
							body: result.reason,
						},
			);
		})();
	};
	return (
		<li className="marketplace__update-row">
			<div className="marketplace__update-info">
				<span className="marketplace__update-name">{tIfKey(update.name)}</span>
				<span className="marketplace__update-version">
					{update.fromVersion} → {update.toVersion}
				</span>
				{needsConsent && update.newCapabilities.length > 0 ? (
					<span className="marketplace__update-caps">
						{t("shell.marketplace.updates.newCaps", { caps: update.newCapabilities.join(", ") })}
					</span>
				) : null}
			</div>
			<Button variant={ButtonVariant.Primary} size={ButtonSize.Md} onClick={apply}>
				{t("shell.marketplace.updates.apply")}
			</Button>
		</li>
	);
}
