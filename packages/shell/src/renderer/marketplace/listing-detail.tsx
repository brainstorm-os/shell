/**
 * Listing detail page per §The Marketplace
 * surface — uniform across kinds, with kind-specific action rows.
 *
 * Theme detail: live-preview-style palette swatch + Activate action that
 * delegates to `marketplace.activateTheme` (same path as Settings →
 * Themes; the activation is global to the vault).
 *
 * App detail: name + version + source + (if installed) Uninstall action
 * via the existing `apps.uninstall` IPC. Future iterations add capability
 * surface details, screenshots, ratings, etc.
 *
 * Per the design system rules, the entire chrome here uses the shared
 * `<Button>` primitive — no bespoke action chrome.
 */

import { isThemeName } from "@brainstorm/tokens";
import {
	MarketplaceContentKind,
	MarketplaceInstallState,
	type MarketplaceListing,
} from "../../preload/marketplace-types";
import { AppIcon } from "../dashboard/app-icon";
import "../dashboard/app-icon.css";
import { t, tIfKey } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { Icon, IconName } from "../ui/icon";
import { ToastKind, pushToast } from "../ui/toasts";

export type ListingDetailProps = {
	listing: MarketplaceListing;
	onBack: () => void;
	/** Re-fetch listings — caller pulls via `useMarketplace.refresh`. */
	onChanged: () => void;
};

export function ListingDetail({ listing, onBack, onChanged }: ListingDetailProps) {
	return (
		<article className="marketplace__detail">
			<header className="marketplace__detail-header">
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Md}
					iconLeft={IconName.Close}
					onClick={onBack}
				>
					{t("shell.marketplace.detail.back")}
				</Button>
			</header>
			<section className="marketplace__detail-hero">
				<HeroPreview listing={listing} />
				<div className="marketplace__detail-meta">
					<h4 className="marketplace__detail-title">{tIfKey(listing.name)}</h4>
					<div className="marketplace__detail-chips">
						<span className="marketplace__detail-chip">
							{t(`shell.marketplace.kind.${listing.kind}.label`)}
						</span>
						<span className="marketplace__detail-chip">{listing.sourceName}</span>
						<span className="marketplace__detail-chip">{listing.version}</span>
					</div>
					{listing.summary && <p className="marketplace__detail-summary">{tIfKey(listing.summary)}</p>}
					<DetailActions listing={listing} onChanged={onChanged} />
				</div>
			</section>
			<section className="marketplace__detail-spec">
				<dl className="marketplace__detail-spec-list">
					<div className="marketplace__detail-spec-row">
						<dt>{t("shell.marketplace.detail.spec.id")}</dt>
						<dd className="marketplace__detail-spec-mono">{listing.id}</dd>
					</div>
					<div className="marketplace__detail-spec-row">
						<dt>{t("shell.marketplace.detail.spec.kind")}</dt>
						<dd>{t(`shell.marketplace.kind.${listing.kind}.label`)}</dd>
					</div>
					<div className="marketplace__detail-spec-row">
						<dt>{t("shell.marketplace.detail.spec.source")}</dt>
						<dd>{listing.sourceName}</dd>
					</div>
					<div className="marketplace__detail-spec-row">
						<dt>{t("shell.marketplace.detail.spec.state")}</dt>
						<dd>
							<StateBadge state={listing.installState} />
						</dd>
					</div>
				</dl>
			</section>
		</article>
	);
}

function HeroPreview({ listing }: { listing: MarketplaceListing }) {
	if (listing.kind === MarketplaceContentKind.Theme && listing.preview) {
		const p = listing.preview;
		return (
			<div
				className="marketplace__detail-hero-preview marketplace__detail-hero-preview--theme"
				role="img"
				aria-label={t("shell.marketplace.themePreview.aria", { name: tIfKey(listing.name) })}
				style={{
					background: `linear-gradient(135deg, ${p.background} 0%, ${p.background} 40%, ${p.surface} 40%, ${p.surface} 70%, ${p.accent} 70%, ${p.accent} 90%, ${p.text} 90%, ${p.text} 100%)`,
				}}
			/>
		);
	}
	if (listing.kind === MarketplaceContentKind.App) {
		return (
			<div className="marketplace__detail-hero-icon">
				<AppIcon
					name={tIfKey(listing.name)}
					seed={listing.id}
					src={window.brainstorm.apps.iconUrl(listing.id, listing.version)}
					size={128}
				/>
			</div>
		);
	}
	return (
		<div className="marketplace__detail-hero-preview marketplace__detail-hero-preview--blank" />
	);
}

function DetailActions({
	listing,
	onChanged,
}: { listing: MarketplaceListing; onChanged: () => void }) {
	switch (listing.kind) {
		case MarketplaceContentKind.Theme:
			return <ThemeActions listing={listing} onChanged={onChanged} />;
		case MarketplaceContentKind.App:
			return <AppActions listing={listing} onChanged={onChanged} />;
	}
}

function ThemeActions({
	listing,
	onChanged,
}: { listing: MarketplaceListing; onChanged: () => void }) {
	if (listing.installState === MarketplaceInstallState.Active) {
		return (
			<div className="marketplace__detail-actions">
				<Button variant={ButtonVariant.Primary} size={ButtonSize.Md} disabled>
					{t("shell.marketplace.detail.theme.active")}
				</Button>
			</div>
		);
	}
	return (
		<div className="marketplace__detail-actions">
			<Button
				variant={ButtonVariant.Primary}
				size={ButtonSize.Md}
				onClick={() => {
					if (!isThemeName(listing.id)) return;
					void window.brainstorm.marketplace.activateTheme(listing.id).then((ok) => {
						if (ok) {
							pushToast({
								kind: ToastKind.Success,
								title: t("shell.marketplace.detail.theme.activatedToast.title"),
								body: t("shell.marketplace.detail.theme.activatedToast.body", {
									name: tIfKey(listing.name),
								}),
							});
							onChanged();
						}
					});
				}}
			>
				{t("shell.marketplace.detail.theme.activate")}
			</Button>
		</div>
	);
}

function AppActions({
	listing,
	onChanged,
}: { listing: MarketplaceListing; onChanged: () => void }) {
	const installed = listing.installState !== MarketplaceInstallState.NotInstalled;
	if (!installed) {
		return (
			<div className="marketplace__detail-actions">
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Md}
					iconLeft={IconName.Plus}
					onClick={() => {
						void (async () => {
							const result = await window.brainstorm.marketplace.install(listing.id);
							if (result.ok) {
								pushToast({
									kind: ToastKind.Success,
									title: t("shell.marketplace.detail.app.installedToast.title"),
									body: t("shell.marketplace.detail.app.installedToast.body", {
										name: tIfKey(listing.name),
									}),
								});
								onChanged();
							} else {
								pushToast({
									kind: ToastKind.Error,
									title: t("shell.marketplace.detail.app.installFailToast.title"),
									body: result.reason,
								});
							}
						})();
					}}
				>
					{t("shell.marketplace.detail.app.install")}
				</Button>
			</div>
		);
	}
	return (
		<div className="marketplace__detail-actions">
			<Button
				variant={ButtonVariant.Destructive}
				size={ButtonSize.Md}
				iconLeft={IconName.Trash}
				onClick={() => {
					void (async () => {
						const accepted = await confirm({
							title: t("shell.marketplace.detail.app.uninstallConfirm.title", {
								name: tIfKey(listing.name),
							}),
							body: t("shell.marketplace.detail.app.uninstallConfirm.body", {
								name: tIfKey(listing.name),
							}),
							confirmLabel: t("shell.marketplace.detail.app.uninstall"),
							confirmVariant: ConfirmVariant.Destructive,
						});
						if (!accepted) return;
						const result = await window.brainstorm.apps.uninstall(listing.id);
						if (result.ok) {
							pushToast({
								kind: ToastKind.Success,
								title: t("shell.marketplace.detail.app.uninstalledToast.title"),
								body: t("shell.marketplace.detail.app.uninstalledToast.body", {
									name: tIfKey(listing.name),
								}),
							});
							onChanged();
						} else {
							pushToast({
								kind: ToastKind.Error,
								title: t("shell.marketplace.detail.app.uninstallFailToast.title"),
								body: result.reason ?? "",
							});
						}
					})();
				}}
			>
				{t("shell.marketplace.detail.app.uninstall")}
			</Button>
		</div>
	);
}

function StateBadge({ state }: { state: MarketplaceInstallState }) {
	switch (state) {
		case MarketplaceInstallState.Active:
			return (
				<span className="marketplace__state marketplace__state--active">
					<Icon name={IconName.CheckCircle} size={14} />
					{t("shell.marketplace.state.active")}
				</span>
			);
		case MarketplaceInstallState.Installed:
			return (
				<span className="marketplace__state marketplace__state--installed">
					{t("shell.marketplace.state.installed")}
				</span>
			);
		case MarketplaceInstallState.NotInstalled:
			return (
				<span className="marketplace__state marketplace__state--available">
					{t("shell.marketplace.state.available")}
				</span>
			);
	}
}
