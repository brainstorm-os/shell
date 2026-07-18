import { useCallback, useEffect, useMemo, useState } from "react";
import type { InstalledApp, ShellCapabilityGrant } from "../../preload";
import { AppIcon } from "../dashboard/app-icon";
import "../dashboard/app-icon.css";
import { SQUIRCLE_RADIUS_PERCENT } from "../dashboard/squircle";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";

type GrantsByApp = Record<string, ShellCapabilityGrant[]>;

/** Synthetic app id the ledger uses for the shell's own grants. */
const SHELL_APP_ID = "shell";

type AppEntry = {
	id: string;
	name: string;
	iconSrc: string | null;
	isShell: boolean;
	grants: ShellCapabilityGrant[];
};

/**
 * The app's own icon. The shell paints its full-bleed brand mark inside the
 * exact same squircle tile (shadow + gloss) as a real app icon, so it reads
 * as a sibling rather than the Apple-HIG-inset window/tray raster. Installed
 * apps use their manifest icon with `<AppIcon>`'s initials fallback.
 */
function EntryIcon({ entry, size }: { entry: AppEntry; size: number }) {
	if (entry.isShell) {
		return (
			<span className="app-icon" aria-hidden="true">
				<span
					className="app-icon__tile app-icon__tile--brand"
					style={{ width: size, height: size, borderRadius: SQUIRCLE_RADIUS_PERCENT }}
				/>
			</span>
		);
	}
	return <AppIcon name={entry.name} seed={entry.id} src={entry.iconSrc} size={size} />;
}

/**
 * Capability grants panel per §Capability ledger surface.
 *
 * One row per app that holds live grants — its real icon + display name, not
 * a raw app id — with the permission count as the at-a-glance summary. Opening
 * a row reveals that app's permissions in a popover where each can be revoked
 * individually. Reads + writes go through the privileged
 * `window.brainstorm.ledger.*` channel, which is only exposed in the dashboard
 * preload (apps go through the broker).
 */
export function GrantsPanel() {
	const [byApp, setByApp] = useState<GrantsByApp>({});
	const [installed, setInstalled] = useState<InstalledApp[]>([]);
	const [openAppId, setOpenAppId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const [grants, apps] = await Promise.all([
				window.brainstorm.ledger.listGrantsByApp(),
				window.brainstorm.apps.listInstalled(),
			]);
			setByApp(grants);
			setInstalled(apps);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load grants");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const onRevoke = useCallback(
		async (appId: string, appName: string, capability: string, scope: string | null) => {
			const label = formatGrant(capability, scope);
			const confirmed = await confirm({
				title: t("shell.settings.security.revokeConfirm.title"),
				body: t("shell.settings.security.revokeConfirm.body", { appId: appName, capability: label }),
				confirmLabel: t("shell.settings.security.revoke"),
				confirmVariant: ConfirmVariant.Destructive,
			});
			if (!confirmed) return;
			try {
				await window.brainstorm.ledger.revoke(appId, capability, scope);
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to revoke");
			}
		},
		[refresh],
	);

	const entries = useMemo<AppEntry[]>(() => {
		const byId = new Map(installed.map((a) => [a.id, a]));
		return Object.keys(byApp)
			.map((id): AppEntry => {
				const meta = byId.get(id);
				const isShell = id === SHELL_APP_ID;
				return {
					id,
					name: isShell ? t("shell.settings.security.shellApp") : (meta?.name ?? id),
					iconSrc: !isShell && meta?.hasIcon ? window.brainstorm.apps.iconUrl(id, meta.version) : null,
					isShell,
					grants: byApp[id] ?? [],
				};
			})
			.filter((e) => e.grants.length > 0)
			.sort((a, b) => {
				// Brainstorm itself is the platform owner — pin it to the top;
				// the rest read alphabetically.
				if (a.isShell !== b.isShell) return a.isShell ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
	}, [byApp, installed]);

	if (loading) {
		return <p className="settings__loading">{t("shell.common.loading")}</p>;
	}
	if (error) {
		return (
			<p className="settings__error" role="alert">
				{error}
			</p>
		);
	}
	if (entries.length === 0) {
		return <p className="settings__empty">{t("shell.settings.security.noGrants")}</p>;
	}

	const openEntry = openAppId ? entries.find((e) => e.id === openAppId) : undefined;
	if (openAppId && !openEntry) {
		// Last permission for this app was revoked — nothing left to manage.
		setOpenAppId(null);
	}

	return (
		<>
			<ul className="grants-panel" data-testid="grants-panel">
				{entries.map((entry) => (
					<li key={entry.id}>
						<button
							type="button"
							className="grants-panel__app"
							onClick={() => setOpenAppId(entry.id)}
							aria-label={t("shell.settings.security.managePermissions", {
								appId: entry.name,
							})}
						>
							<EntryIcon entry={entry} size={36} />
							<span className="grants-panel__app-text">
								<span className="grants-panel__app-name">{entry.name}</span>
								<span className="grants-panel__app-count">
									{t("shell.settings.security.permissionCount", {
										count: entry.grants.length,
									})}
								</span>
							</span>
							<span className="grants-panel__manage">{t("shell.settings.security.manage")}</span>
						</button>
					</li>
				))}
			</ul>

			{openEntry && (
				<Popover
					title={
						<span className="grants-panel__dialog-title">
							<EntryIcon entry={openEntry} size={24} />
							{openEntry.name}
						</span>
					}
					onClose={() => setOpenAppId(null)}
					size={PopoverSize.Medium}
					bodyPadding={PopoverBodyPadding.Comfortable}
					testId="grants-popover"
				>
					<ul className="grants-panel__list">
						{openEntry.grants.map((grant) => (
							<li key={grant.id} className="grants-panel__row">
								<span className="grants-panel__capability">
									{formatGrant(grant.capability, grant.scope)}
								</span>
								<span className="grants-panel__source">
									{t(`shell.settings.security.grantedVia.${grant.grantedVia}`)}
								</span>
								<Button
									variant={ButtonVariant.Destructive}
									size={ButtonSize.Md}
									onClick={() => {
										void onRevoke(openEntry.id, openEntry.name, grant.capability, grant.scope);
									}}
									title={t("shell.settings.security.revokeAria", {
										capability: formatGrant(grant.capability, grant.scope),
										appId: openEntry.name,
									})}
								>
									{t("shell.settings.security.revoke")}
								</Button>
							</li>
						))}
					</ul>
				</Popover>
			)}
		</>
	);
}

function formatGrant(capability: string, scope: string | null): string {
	return scope === null ? capability : `${capability}:${scope}`;
}
