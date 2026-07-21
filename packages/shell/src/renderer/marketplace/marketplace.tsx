/**
 * Marketplace overlay — privileged shell view per
 * §The Marketplace surface. Lists every installable kind side-by-side
 * (apps + themes today; plugin / layout-pack / wallpaper-pack / locale-pack /
 * workflow-pack / shortcut-pack later).
 *
 * Layout:
 *   - Sidebar nav (Browse / Library / Sources) — mirrors Settings chrome
 *     so cross-overlay muscle memory carries over.
 *   - Top: panel title + kind chips (All / Apps / Themes) + search input.
 *   - Body: card grid OR detail page (drill-in).
 *
 * Selection / install:
 *   - Theme listings activate via `marketplace.activateTheme`, the same
 *     `DashboardStore.setTheme` invariant that Settings → Themes uses.
 *   - App listings show a manage row (Uninstall) when installed; install
 *     flow for un-installed catalog apps is gated on remote catalog data
 *     (future iteration).
 */

import {
	Orientation,
	RegionId,
	useCompositeKeyboard,
	useFocusTrap,
	useRegionNavigation,
} from "@brainstorm-os/sdk/a11y";
import { Searchbar } from "@brainstorm-os/sdk/searchbar";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useMemo, useRef, useState } from "react";
import type { MarketplaceListing } from "../../preload/marketplace-types";
import { t } from "../i18n/t";
import { Icon, IconName } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { ListingCard } from "./listing-card";
import { ListingDetail } from "./listing-detail";
import { countByKind, filterListings } from "./listing-filters";
import { KindFilter, MarketplacePanel } from "./panels";
import { SourcesPanel } from "./sources-panel";
import { UpdatesPanel } from "./updates-panel";
import { useMarketplace } from "./use-marketplace";
import "./marketplace.css";

export type MarketplaceProps = {
	onClose: () => void;
	initialPanel?: MarketplacePanel;
};

const PANELS: ReadonlyArray<{ id: MarketplacePanel; labelKey: string; icon: IconName }> = [
	{
		id: MarketplacePanel.Discover,
		labelKey: "shell.marketplace.panel.discover",
		icon: IconName.Sparkle,
	},
	{ id: MarketplacePanel.Browse, labelKey: "shell.marketplace.panel.browse", icon: IconName.Search },
	{ id: MarketplacePanel.Library, labelKey: "shell.marketplace.panel.library", icon: IconName.App },
	{
		id: MarketplacePanel.Updates,
		labelKey: "shell.marketplace.panel.updates",
		icon: IconName.Update,
	},
	{
		id: MarketplacePanel.Sources,
		labelKey: "shell.marketplace.panel.sources",
		icon: IconName.Folder,
	},
];

const KIND_FILTERS: ReadonlyArray<{ id: KindFilter; labelKey: string }> = [
	{ id: KindFilter.All, labelKey: "shell.marketplace.kindFilter.all" },
	{ id: KindFilter.Apps, labelKey: "shell.marketplace.kindFilter.apps" },
	{ id: KindFilter.Themes, labelKey: "shell.marketplace.kindFilter.themes" },
];

export function Marketplace({ onClose, initialPanel = MarketplacePanel.Browse }: MarketplaceProps) {
	const [panel, setPanel] = useState<MarketplacePanel>(initialPanel);
	const [kindFilter, setKindFilter] = useState<KindFilter>(KindFilter.All);
	const [query, setQuery] = useState("");
	const [selectedListingKey, setSelectedListingKey] = useState<string | null>(null);

	const { listings, sources, updates, loading, refresh, applyUpdate } = useMarketplace();

	// Escape closes the drill-in detail first, then the overlay. Routed through
	// the focus trap below (which shares KBN-2's escape stack), replacing the
	// old useEscapeStackEntry.
	const onEscape = useCallback(() => {
		if (selectedListingKey) {
			setSelectedListingKey(null);
			return;
		}
		onClose();
	}, [selectedListingKey, onClose]);

	// KBN-S-marketplace: trap focus inside the overlay (hand-rolled aria-modal
	// dialog, like Settings) and restore to the opener on close. Opener captured
	// at first render before the trap moves focus; explicit restoreFocusTo keeps
	// KBN-G-focus-trap-without-restore happy.
	const [opener] = useState<HTMLElement | null>(() => {
		if (typeof document === "undefined") return null;
		return (document.activeElement as HTMLElement | null) ?? null;
	});
	const { containerProps: trapProps } = useFocusTrap({
		enabled: true,
		onEscape,
		restoreFocusTo: opener,
		openerLabel: "marketplace",
	});

	// KBN-S-marketplace: the sidebar panel nav is a vertical composite listbox —
	// mirrors the Settings sidebar (the chrome already mirrors Settings), so the
	// two near-identical sidebars share one keyboard model rather than diverging
	// onto a tablist. ↑/↓/Home/End/type-ahead, roving tabindex, aria-selected.
	const panelLabels = useMemo(() => PANELS.map((entry) => t(entry.labelKey)), []);
	const activePanelIndex = PANELS.findIndex((entry) => entry.id === panel);
	const selectPanel = useCallback((index: number) => {
		const entry = PANELS[index];
		if (entry) {
			setPanel(entry.id);
			setSelectedListingKey(null);
		}
	}, []);
	const { containerProps: navProps, getItemProps: getNavItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: PANELS.length,
		activeIndex: activePanelIndex,
		onActiveIndexChange: selectPanel,
		onActivate: selectPanel,
		typeahead: (i) => panelLabels[i] ?? "",
	});

	// KBN-S-marketplace: the kind-filter chips are a horizontal tablist — ←/→
	// move + activate (automatic-activation tablist), so the role flows through
	// the hook and the hand-written role="tablist" literal is gone.
	const kindLabels = useMemo(() => KIND_FILTERS.map((entry) => t(entry.labelKey)), []);
	const activeKindIndex = KIND_FILTERS.findIndex((entry) => entry.id === kindFilter);
	const selectKind = useCallback((index: number) => {
		const entry = KIND_FILTERS[index];
		if (entry) setKindFilter(entry.id);
	}, []);
	const { containerProps: chipsProps, getItemProps: getChipProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: KIND_FILTERS.length,
		activeIndex: activeKindIndex,
		onActiveIndexChange: selectKind,
		onActivate: selectKind,
		role: "tablist",
		itemRole: "tab",
		typeahead: (i) => kindLabels[i] ?? "",
	});

	// KBN-S-marketplace: F6 / Shift+F6 between the sidebar (lands on its active
	// panel option) and the main region (its container, tabindex -1).
	const sidebarRegionRef = useRef<HTMLButtonElement | null>(null);
	const mainRegionRef = useRef<HTMLDivElement | null>(null);
	const [activeRegion, setActiveRegion] = useState<string>(RegionId.MarketplaceSidebar);
	const regions = useMemo(
		() => [
			{ id: RegionId.MarketplaceSidebar, label: t("shell.marketplace.nav"), ref: sidebarRegionRef },
			{ id: RegionId.MarketplaceMain, label: t("shell.marketplace.region.main"), ref: mainRegionRef },
		],
		[],
	);
	useRegionNavigation({
		regions,
		activeRegionId: activeRegion,
		onActiveRegionIdChange: setActiveRegion,
	});

	const filtered = useMemo(
		() => filterListings(listings ?? [], panel, kindFilter, query),
		[listings, panel, kindFilter, query],
	);

	const counts = useMemo(() => countByKind(listings ?? [], panel), [listings, panel]);

	const selectedListing: MarketplaceListing | null = useMemo(() => {
		if (!selectedListingKey || !listings) return null;
		return listings.find((l) => listingKey(l) === selectedListingKey) ?? null;
	}, [selectedListingKey, listings]);

	return (
		<div
			className="marketplace"
			role="dialog"
			aria-modal="true"
			aria-labelledby="marketplace-title"
			data-testid="marketplace"
		>
			<motion.button
				type="button"
				className="marketplace__backdrop"
				onClick={onClose}
				aria-label={t("shell.actions.close")}
				tabIndex={-1}
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.18, ease: "easeOut" }}
			/>
			<motion.div
				{...trapProps}
				className="marketplace__panel glass--strong"
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				exit={{ opacity: 0, y: 12 }}
				transition={{ type: "spring", stiffness: 340, damping: 32 }}
			>
				<aside className="marketplace__sidebar" aria-label={t("shell.marketplace.nav")}>
					<header className="marketplace__sidebar-header">
						<h2 id="marketplace-title" className="marketplace__title">
							{t("shell.marketplace.title")}
						</h2>
					</header>
					<div className="marketplace__sidebar-body">
						<nav className="marketplace__nav" aria-label={t("shell.marketplace.nav")} {...navProps}>
							{PANELS.map((entry, index) => (
								<button
									key={entry.id}
									type="button"
									ref={panel === entry.id ? sidebarRegionRef : undefined}
									className={
										panel === entry.id
											? "marketplace__nav-item marketplace__nav-item--active"
											: "marketplace__nav-item"
									}
									onClick={() => {
										setPanel(entry.id);
										setSelectedListingKey(null);
									}}
									{...getNavItemProps(index)}
								>
									<span className="marketplace__nav-icon" aria-hidden="true">
										<Icon name={entry.icon} size={18} />
									</span>
									<span>{t(entry.labelKey)}</span>
								</button>
							))}
						</nav>
					</div>
				</aside>
				<div
					className="marketplace__main"
					ref={mainRegionRef}
					tabIndex={-1}
					aria-label={t("shell.marketplace.region.main")}
				>
					<header className="marketplace__main-header">
						<h3 className="marketplace__main-title">{t(`shell.marketplace.panel.${panel}`)}</h3>
						<IconButton icon={IconName.Close} label={t("shell.actions.close")} onClick={onClose} />
					</header>
					<div className="marketplace__body">
						<AnimatePresence mode="wait">
							{selectedListing ? (
								<motion.div
									key={`detail-${selectedListingKey}`}
									initial={{ opacity: 0, x: 8 }}
									animate={{ opacity: 1, x: 0 }}
									exit={{ opacity: 0, x: -8 }}
									transition={{ duration: 0.16, ease: "easeOut" }}
								>
									<ListingDetail
										listing={selectedListing}
										onBack={() => setSelectedListingKey(null)}
										onChanged={refresh}
									/>
								</motion.div>
							) : panel === MarketplacePanel.Sources ? (
								<motion.div
									key="sources"
									initial={{ opacity: 0, y: 6 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -6 }}
									transition={{ duration: 0.16, ease: "easeOut" }}
								>
									<SourcesPanel sources={sources ?? []} loading={loading} />
								</motion.div>
							) : panel === MarketplacePanel.Updates ? (
								<motion.div
									key="updates"
									initial={{ opacity: 0, y: 6 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -6 }}
									transition={{ duration: 0.16, ease: "easeOut" }}
								>
									<UpdatesPanel updates={updates} loading={updates === null} onApply={applyUpdate} />
								</motion.div>
							) : (
								<motion.div
									key={`grid-${panel}`}
									className="marketplace__body-inner"
									initial={{ opacity: 0, y: 6 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -6 }}
									transition={{ duration: 0.16, ease: "easeOut" }}
								>
									<div className="marketplace__toolbar">
										<div
											className="marketplace__chips"
											aria-label={t("shell.marketplace.kindFilter.label")}
											{...chipsProps}
										>
											{KIND_FILTERS.map((filter, index) => (
												<button
													key={filter.id}
													type="button"
													{...getChipProps(index)}
													className={
														kindFilter === filter.id
															? "marketplace__chip marketplace__chip--active"
															: "marketplace__chip"
													}
													onClick={() => setKindFilter(filter.id)}
												>
													<span>{t(filter.labelKey)}</span>
													<span className="marketplace__chip-count">{counts[filter.id]}</span>
												</button>
											))}
										</div>
										<Searchbar
											className="marketplace__search"
											value={query}
											onChange={setQuery}
											placeholder={t("shell.marketplace.searchPlaceholder")}
											ariaLabel={t("shell.marketplace.searchLabel")}
											clearLabel={t("shell.marketplace.searchClear")}
										/>
									</div>
									{loading ? (
										<p className="marketplace__loading">{t("shell.common.loading")}</p>
									) : filtered.length === 0 ? (
										<p className="marketplace__empty">
											{t("shell.marketplace.empty", {
												panel: t(`shell.marketplace.panel.${panel}`),
											})}
										</p>
									) : (
										<div className="marketplace__grid">
											{filtered.map((listing) => (
												<ListingCard
													key={listingKey(listing)}
													listing={listing}
													onSelect={() => setSelectedListingKey(listingKey(listing))}
												/>
											))}
										</div>
									)}
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				</div>
			</motion.div>
		</div>
	);
}

function listingKey(listing: MarketplaceListing): string {
	return `${listing.kind}:${listing.id}`;
}
