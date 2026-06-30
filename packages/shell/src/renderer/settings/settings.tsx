/**
 * Settings overlay — the canonical surface for every shell-level preference
 * per. Sidebar nav on the left, section content on
 * the right. The wallpaper picker lives here as part of Appearance instead
 * of a free-standing popover (per user 2026-05-12).
 *
 * Conventions:
 *   - `Escape` routes through `useEscapeStackEntry({ onEscape: onClose })` —
 *     the renderer-wide LIFO escape stack (KBN-2); no raw `e.key`.
 *  - Every label flows through `t` (§Localization).
 *  - Section ids are an enum (§Enums); no raw string switches.
 *
 * Until the Claude-Design build kicks off, this is a polished-enough
 * scaffold to be the daily-driver Settings surface.
 */

import {
	Orientation,
	RegionId,
	useCompositeKeyboard,
	useFocusTrap,
	useRegionNavigation,
} from "@brainstorm/sdk/a11y";
import { AnimatePresence, motion } from "framer-motion";
import {
	type ReactNode,
	Suspense,
	lazy,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { VaultSessionMeta } from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { Icon, IconName } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { useVault } from "../vault-context";
import { AiPanel } from "./ai-panel";
import { AppearanceSection } from "./appearance-section";
import { ContributionsSection } from "./contributions-section";
import { CoversSection } from "./covers-section";
import { DataSection } from "./data-section";
import { DefaultsSection } from "./defaults-section";
import { InterfaceSection } from "./interface-section";
import { LanguageRegionSection } from "./language-region-section";
import { NotificationsSection } from "./notifications-section";
// Devices + Sync sections pull large pairing/HPKE/wrap UI surfaces (~24 KB raw)
// only reachable from Settings; lazy-load them so the dashboard entry chunk
// stays under budget.
const DevicesSection = lazy(() =>
	import("./devices-section").then((m) => ({ default: m.DevicesSection })),
);
const IdentitySection = lazy(() =>
	import("./identity-section").then((m) => ({ default: m.IdentitySection })),
);
import { AppLockPanel } from "./app-lock-panel";
import { FileHandlesPanel } from "./file-handles-panel";
import { GrantsPanel } from "./grants-panel";
import { SettingsHeaderActionsContext } from "./header-actions";
import { KeyboardSection } from "./keyboard-section";
const MembershipSection = lazy(() =>
	import("./membership-section").then((m) => ({ default: m.MembershipSection })),
);
// Net-1f — Settings → Privacy → Network panel. Lazy-loaded; the panel
// pulls the virtualizer (~6 KB raw) + the proxy editor popover + every
// audit-table row component (~12 KB raw together) only when the user
// navigates to it.
const NetworkEgressPanel = lazy(() =>
	import("./network-egress-panel").then((m) => ({ default: m.NetworkEgressPanel })),
);
const BackupMigrationPanel = lazy(() =>
	import("./backup-migration-panel").then((m) => ({ default: m.BackupMigrationPanel })),
);
import { readLastSettingsSection, rememberLastSettingsSection } from "./last-section";
import { RecentlyDeletedSection } from "./recently-deleted-section";
import { SearchSection } from "./search-section";
import { SettingsSection } from "./sections";
import { UpdatesSection } from "./updates-section";
const SyncSection = lazy(() => import("./sync-section").then((m) => ({ default: m.SyncSection })));
import "./settings.css";

export const SECTIONS: ReadonlyArray<{ id: SettingsSection; labelKey: string; icon: IconName }> = [
	{
		id: SettingsSection.General,
		labelKey: "shell.settings.section.general",
		icon: IconName.Settings,
	},
	{
		id: SettingsSection.Appearance,
		labelKey: "shell.settings.section.appearance",
		icon: IconName.Palette,
	},
	{
		id: SettingsSection.Interface,
		labelKey: "shell.settings.section.interface",
		icon: IconName.Interface,
	},
	{
		id: SettingsSection.LanguageRegion,
		labelKey: "shell.settings.section.languageRegion",
		icon: IconName.Globe,
	},
	{
		id: SettingsSection.Notifications,
		labelKey: "shell.settings.section.notifications",
		icon: IconName.Bell,
	},
	{
		id: SettingsSection.Covers,
		labelKey: "shell.settings.section.covers",
		icon: IconName.Sparkle,
	},
	{ id: SettingsSection.Data, labelKey: "shell.settings.section.data", icon: IconName.Entity },
	{
		id: SettingsSection.BackupMigration,
		labelKey: "shell.settings.section.backupMigration",
		icon: IconName.Download,
	},
	{
		id: SettingsSection.RecentlyDeleted,
		labelKey: "shell.settings.section.recentlyDeleted",
		icon: IconName.Trash,
	},
	{
		id: SettingsSection.Search,
		labelKey: "shell.settings.section.search",
		icon: IconName.Search,
	},
	{
		id: SettingsSection.Defaults,
		labelKey: "shell.settings.section.defaults",
		icon: IconName.App,
	},
	{
		id: SettingsSection.Contributions,
		labelKey: "shell.settings.section.contributions",
		icon: IconName.Sparkle,
	},
	{
		id: SettingsSection.Keyboard,
		labelKey: "shell.settings.section.keyboard",
		icon: IconName.Keyboard,
	},
	{ id: SettingsSection.Ai, labelKey: "shell.settings.section.ai", icon: IconName.Sparkle },
	{
		id: SettingsSection.Identity,
		labelKey: "shell.settings.section.identity",
		icon: IconName.ShieldCheck,
	},
	{
		id: SettingsSection.Devices,
		labelKey: "shell.settings.section.devices",
		icon: IconName.DeviceMobile,
	},
	{
		id: SettingsSection.Sync,
		labelKey: "shell.settings.section.sync",
		icon: IconName.Cloud,
	},
	{
		id: SettingsSection.Membership,
		labelKey: "shell.settings.section.membership",
		icon: IconName.Crown,
	},
	{
		id: SettingsSection.Network,
		labelKey: "shell.settings.section.network",
		icon: IconName.Network,
	},
	{ id: SettingsSection.Security, labelKey: "shell.settings.section.security", icon: IconName.Lock },
];

/** Map section enum → i18n label key. SECTIONS is the canonical source;
 *  this lookup keeps the main header in sync with the sidebar rather
 *  than re-deriving the key from the enum value (which is kebab-case
 *  and would miss the camelCase keys for any future multi-word section).
 *  Adding a section without wiring SECTIONS is now the only failure
 *  mode, and that's caught at first navigation. */
const SECTION_LABEL_KEYS: Record<SettingsSection, string> = SECTIONS.reduce(
	(acc, entry) => {
		acc[entry.id] = entry.labelKey;
		return acc;
	},
	{} as Record<SettingsSection, string>,
);

function titleKeyFor(section: SettingsSection): string {
	return SECTION_LABEL_KEYS[section] ?? `shell.settings.section.${section}`;
}

const BACKEND_DISPLAY: Record<VaultSessionMeta["backend"], string> = {
	"keychain-macos": "macOS Keychain",
	"credential-manager-windows": "Windows Credential Manager",
	"secret-service-linux": "Linux Secret Service",
	passphrase: "Passphrase",
	"insecure-dev": "Insecure (dev mode)",
};

export type SettingsProps = {
	onClose: () => void;
	initialSection?: SettingsSection;
	/** 9.8.8 — the Recently Deleted section's jump into the Bin overlay
	 *  (the dashboard owns that state). Optional so embeddings/tests that
	 *  don't surface the Bin stay valid. */
	onOpenBin?: () => void;
};

export function Settings({ onClose, initialSection, onOpenBin }: SettingsProps) {
	// An explicit deep-link wins; otherwise reopen where the user last left off
	// (device-local, persisted below). General is the first-run fallback.
	const [section, setSection] = useState<SettingsSection>(
		() => initialSection ?? readLastSettingsSection(),
	);
	const [session, setSession] = useState<VaultSessionMeta | null>(null);
	const [headerActions, setHeaderActions] = useState<ReactNode | null>(null);

	// Reset the header-actions slot whenever the active section changes — the
	// previous section's `useEffect` cleanup also fires, but resetting here
	// covers the gap before the new section mounts. `section` is the intended
	// trigger even though the body doesn't read it.
	useEffect(() => {
		setHeaderActions(null);
		rememberLastSettingsSection(section);
	}, [section]);

	const headerActionsSetter = useMemo(() => setHeaderActions, []);

	// KBN-S-settings: the sidebar nav is a composite listbox — Tab moves into
	// it, ↑/↓ move between sections (selection follows focus), Home/End jump to
	// the ends, and type-to-jump matches a section by its label. The hook owns
	// roving `tabindex`, the `listbox`/`option` roles, `aria-selected`, and
	// focusing the active item; section state stays the single source of truth
	// (active index is derived from it, every move writes back through it).
	const sectionLabels = useMemo(() => SECTIONS.map((entry) => t(entry.labelKey)), []);
	const activeSectionIndex = SECTIONS.findIndex((entry) => entry.id === section);
	const selectIndex = useCallback((index: number) => {
		const entry = SECTIONS[index];
		if (entry) setSection(entry.id);
	}, []);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: SECTIONS.length,
		activeIndex: activeSectionIndex,
		onActiveIndexChange: selectIndex,
		onActivate: selectIndex,
		typeahead: (i) => sectionLabels[i] ?? "",
	});

	// KBN-S-settings: trap focus inside the overlay so Tab can't reach the
	// dashboard behind it, and restore focus to the opener on close. The
	// opener is captured at first render (lazy initializer runs before the
	// trap's effect moves focus into the panel) — explicit-not-default keeps
	// `KBN-G-focus-trap-without-restore` happy. The trap shares KBN-2's escape
	// stack, so Escape still unwinds LIFO (replaces the old useEscapeStackEntry).
	const [opener] = useState<HTMLElement | null>(() => {
		if (typeof document === "undefined") return null;
		return (document.activeElement as HTMLElement | null) ?? null;
	});
	const { containerProps: trapProps } = useFocusTrap({
		enabled: true,
		onEscape: onClose,
		restoreFocusTo: opener,
		openerLabel: "settings",
	});

	// KBN-S-settings: F6 / Shift+F6 jump between the two settings regions. The
	// sidebar region lands on its active section option (so arrows keep working
	// from there); the main region lands on its panel container (tabindex -1),
	// from which Tab walks the section content.
	const sidebarRegionRef = useRef<HTMLButtonElement | null>(null);
	const mainRegionRef = useRef<HTMLDivElement | null>(null);
	const [activeRegion, setActiveRegion] = useState<string>(RegionId.SettingsSidebar);
	const regions = useMemo(
		() => [
			{ id: RegionId.SettingsSidebar, label: t("shell.settings.nav"), ref: sidebarRegionRef },
			{ id: RegionId.SettingsMain, label: t("shell.settings.region.main"), ref: mainRegionRef },
		],
		[],
	);
	useRegionNavigation({
		regions,
		activeRegionId: activeRegion,
		onActiveRegionIdChange: setActiveRegion,
	});

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.vaults.session().then((meta) => {
			if (!cancelled) setSession(meta);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div
			className="settings"
			data-bs-region="settings"
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-title"
			data-testid="settings"
		>
			<button
				type="button"
				className="settings__backdrop"
				onClick={onClose}
				aria-label={t("shell.actions.close")}
				tabIndex={-1}
			/>
			<motion.div
				{...trapProps}
				className="settings__panel glass--strong"
				initial={{ x: "100%" }}
				animate={{ x: 0 }}
				exit={{ x: "100%" }}
				transition={{ type: "spring", stiffness: 360, damping: 36 }}
			>
				<aside
					className="settings__sidebar"
					data-bs-region="settings-sidebar"
					aria-label={t("shell.settings.nav")}
				>
					<header className="settings__sidebar-header">
						<h2 id="settings-title" className="settings__title">
							{t("shell.settings.title")}
						</h2>
					</header>
					<div className="settings__sidebar-body">
						<nav className="settings__nav" aria-label={t("shell.settings.nav")} {...containerProps}>
							{SECTIONS.map((entry, index) => (
								<button
									key={entry.id}
									type="button"
									ref={section === entry.id ? sidebarRegionRef : undefined}
									className={
										section === entry.id
											? "settings__nav-item settings__nav-item--active"
											: "settings__nav-item"
									}
									onClick={() => setSection(entry.id)}
									{...getItemProps(index)}
								>
									<span className="settings__nav-icon" aria-hidden="true">
										<Icon name={entry.icon} size={18} />
									</span>
									<span>{t(entry.labelKey)}</span>
								</button>
							))}
						</nav>
					</div>
					<footer className="settings__sidebar-footer">
						<SignOutButton />
					</footer>
				</aside>
				<div
					className="settings__main"
					data-bs-region="settings-main"
					ref={mainRegionRef}
					tabIndex={-1}
					aria-label={t("shell.settings.region.main")}
				>
					<header className="settings__main-header">
						<h3 className="settings__main-title">{t(titleKeyFor(section))}</h3>
						<div className="settings__main-header-actions">
							{headerActions}
							<IconButton icon={IconName.Close} label={t("shell.actions.close")} onClick={onClose} />
						</div>
					</header>
					<div className="settings__body">
						<AnimatePresence mode="wait">
							<motion.div
								key={section}
								className="settings__body-inner"
								initial={{ opacity: 0, y: 6 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -6 }}
								transition={{ duration: 0.16, ease: "easeOut" }}
							>
								<SettingsHeaderActionsContext.Provider value={headerActionsSetter}>
									{renderBody(section, session, onOpenBin)}
								</SettingsHeaderActionsContext.Provider>
							</motion.div>
						</AnimatePresence>
					</div>
				</div>
			</motion.div>
		</div>
	);
}

function renderBody(
	section: SettingsSection,
	session: VaultSessionMeta | null,
	onOpenBin?: () => void,
) {
	switch (section) {
		case SettingsSection.Appearance:
			return <AppearanceSection />;
		case SettingsSection.Interface:
			return <InterfaceSection />;
		case SettingsSection.LanguageRegion:
			return <LanguageRegionSection />;
		case SettingsSection.Notifications:
			return <NotificationsSection />;
		case SettingsSection.Covers:
			return <CoversSection />;
		case SettingsSection.Data:
			return <DataSection />;
		case SettingsSection.BackupMigration:
			return (
				<Suspense fallback={null}>
					<BackupMigrationPanel />
				</Suspense>
			);
		case SettingsSection.RecentlyDeleted:
			return <RecentlyDeletedSection {...(onOpenBin ? { onOpenBin } : {})} />;
		case SettingsSection.Search:
			return <SearchSection />;
		case SettingsSection.Defaults:
			return <DefaultsSection />;
		case SettingsSection.Contributions:
			return <ContributionsSection />;
		case SettingsSection.Keyboard:
			return <KeyboardSection />;
		case SettingsSection.Ai:
			return <AiPanel />;
		case SettingsSection.Identity:
			return (
				<Suspense fallback={null}>
					<IdentitySection />
				</Suspense>
			);
		case SettingsSection.Devices:
			return (
				<Suspense fallback={null}>
					<DevicesSection />
				</Suspense>
			);
		case SettingsSection.Sync:
			return (
				<Suspense fallback={null}>
					<SyncSection />
				</Suspense>
			);
		case SettingsSection.Membership:
			return (
				<Suspense fallback={null}>
					<MembershipSection />
				</Suspense>
			);
		case SettingsSection.Network:
			return (
				<Suspense fallback={null}>
					<NetworkEgressPanel />
				</Suspense>
			);
		case SettingsSection.General:
			return <GeneralBody />;
		case SettingsSection.Security:
			return <SecurityBody session={session} />;
	}
}

function GeneralBody() {
	return <UpdatesSection />;
}

function SecurityBody({ session }: { session: VaultSessionMeta | null }) {
	if (!session) {
		return <p className="settings__loading">{t("shell.common.loading")}</p>;
	}
	return (
		<>
			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.security.backend")}</h4>
				<p
					className={
						session.backendIsInsecure ? "settings__value settings__value--insecure" : "settings__value"
					}
				>
					{BACKEND_DISPLAY[session.backend]}
					{session.backendIsInsecure && (
						<span className="settings__warning"> {t("shell.settings.security.insecureSuffix")}</span>
					)}
				</p>
			</section>
			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.security.identity")}</h4>
				<p className="settings__fingerprint">{session.identity.fingerprint}</p>
			</section>
			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.security.appLock.title")}</h4>
				<p className="settings__section-summary">{t("shell.settings.security.appLock.description")}</p>
				<AppLockPanel />
			</section>
			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.security.grants")}</h4>
				<GrantsPanel />
			</section>
			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.files.section")}</h4>
				<FileHandlesPanel />
			</section>
		</>
	);
}

function SignOutButton() {
	const { current, close } = useVault();
	const onSignOut = async () => {
		const confirmed = await confirm({
			title: t("shell.settings.security.signOutConfirm.title"),
			body: t("shell.settings.security.signOutConfirm.body", {
				vaultName: current?.name ?? t("shell.settings.security.thisVault"),
			}),
			confirmLabel: t("shell.settings.security.signOut"),
			confirmVariant: ConfirmVariant.Destructive,
		});
		if (!confirmed) return;
		await close();
	};
	return (
		<Button
			variant={ButtonVariant.Ghost}
			size={ButtonSize.Sm}
			iconLeft={IconName.SignOut}
			onClick={() => {
				void onSignOut();
			}}
			className="settings__signout"
		>
			{t("shell.settings.security.signOut")}
		</Button>
	);
}
