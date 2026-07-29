/**
 * Uniform listing card per §The Marketplace
 * surface — the same chrome across every content kind, with the kind
 * descriptor's metadata steering badges and previews.
 *
 * Cards are buttons (entire surface is clickable to drill into the detail
 * view). Hovered + focused states use the standard interactive tokens.
 *
 * App tiles reuse the shared `<AppIcon>` so the squircle, shadow stack and
 * gradient-initials fallback match the dashboard exactly; theme cards
 * paint a 4-stop swatch from the listing's `preview` palette so dark /
 * light variants and accents are immediately readable.
 */

import {
	MarketplaceContentKind,
	MarketplaceInstallState,
	type MarketplaceListing,
} from "../../preload/marketplace-types";
import { AppIcon } from "../dashboard/app-icon";
import { resolveAppIconSrc } from "../dashboard/app-icon-cache";
import "../dashboard/app-icon.css";
import { t, tIfKey } from "../i18n/t";

export type ListingCardProps = {
	listing: MarketplaceListing;
	onSelect: () => void;
};

export function ListingCard({ listing, onSelect }: ListingCardProps) {
	const isActive = listing.installState === MarketplaceInstallState.Active;
	return (
		<button type="button" className="marketplace__card" onClick={onSelect}>
			<ListingPreview listing={listing} />
			<div className="marketplace__card-meta">
				<span className="marketplace__card-name">{tIfKey(listing.name)}</span>
				<span className="marketplace__card-kind">
					{t(`shell.marketplace.kind.${listing.kind}.label`)}
				</span>
				{listing.summary && (
					<span className="marketplace__card-summary">{tIfKey(listing.summary)}</span>
				)}
				<span className="marketplace__card-state">
					{isActive
						? t("shell.marketplace.state.active")
						: listing.installState === MarketplaceInstallState.Installed
							? t("shell.marketplace.state.installed")
							: t("shell.marketplace.state.available")}
				</span>
			</div>
		</button>
	);
}

function ListingPreview({ listing }: { listing: MarketplaceListing }) {
	switch (listing.kind) {
		case MarketplaceContentKind.Theme:
			return (
				<div className="marketplace__card-preview">
					<ThemePreview listing={listing} />
				</div>
			);
		case MarketplaceContentKind.App:
			return (
				<div className="marketplace__card-icon">
					<AppIcon
						name={tIfKey(listing.name)}
						seed={listing.id}
						src={resolveAppIconSrc(listing.id)}
						size={64}
					/>
				</div>
			);
	}
}

function ThemePreview({ listing }: { listing: MarketplaceListing }) {
	const p = listing.preview;
	if (!p) {
		return <div className="marketplace__theme-preview marketplace__theme-preview--blank" />;
	}
	return (
		<div
			className="marketplace__theme-preview"
			role="img"
			aria-label={t("shell.marketplace.themePreview.aria", { name: tIfKey(listing.name) })}
			style={{
				background: `linear-gradient(135deg, ${p.background} 0%, ${p.background} 40%, ${p.surface} 40%, ${p.surface} 70%, ${p.accent} 70%, ${p.accent} 90%, ${p.text} 90%, ${p.text} 100%)`,
			}}
		/>
	);
}
