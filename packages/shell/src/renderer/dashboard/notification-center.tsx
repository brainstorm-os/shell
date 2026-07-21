/**
 * Notification center (Track C, renderer half). A header bell with an unread
 * badge that opens the shared centered `<Popover>` listing the per-vault
 * notification history (newest first). This is the ONLY in-app presentation of
 * app notifications — they never toast; unread is signalled by the bell badge
 * here plus the OS dock badge (main process).
 *
 * History is read from the dashboard snapshot (capped at 200 in the store);
 * read/clear actions go through `window.brainstorm.dashboard.*`. The main-
 * process push + OS-native + DND/mute enforcement is the host half (Track C).
 */

import type { NotificationKind, NotificationRecord } from "@brainstorm-os/protocol/shell-prefs";
import { useEffect, useMemo, useState } from "react";
import type { InstalledApp } from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonVariant } from "../ui/button";
import { Icon, IconName } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { Popover } from "../ui/popover";
import { PopoverSize } from "../ui/popover-types";
import { ToastKind, pushToast } from "../ui/toasts";
import { AppIcon } from "./app-icon";

/** Each entry leads with the posting app's real icon (initials fallback for an
 *  uninstalled/unknown id); the kind only surfaces as a corner badge when it
 *  carries signal — plain `info` stays unbadged. */
const KIND_BADGE: Partial<Record<NotificationKind, IconName>> = {
	success: IconName.CheckCircle,
	warning: IconName.Warning,
	error: IconName.Warning,
};

/** Center-entry click → `intent.open` for the notification's subject entity,
 *  through the same shell-privileged dispatch the launcher palette uses. The
 *  popover closes immediately (the open lands in the owning app's window);
 *  a failed resolve surfaces as an error toast rather than dying silently. */
function openNotificationEntity(entityId: string): void {
	void window.brainstorm.intents
		.dispatch({ verb: "open", payload: { entityId } })
		.then((result) => {
			if (!result.handled) {
				pushToast({
					kind: ToastKind.Error,
					title: t("shell.notifications.center.openFailed"),
					...(result.message !== undefined ? { body: result.message } : {}),
				});
			}
		})
		.catch(() => {
			pushToast({ kind: ToastKind.Error, title: t("shell.notifications.center.openFailed") });
		});
}

function formatTimestamp(ts: number, locale: string): string {
	try {
		return new Date(ts).toLocaleString(locale || undefined, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	} catch {
		return new Date(ts).toLocaleString();
	}
}

export function NotificationBell({
	unread,
	open,
	onToggle,
	onClose,
	history,
	locale,
}: {
	unread: number;
	open: boolean;
	onToggle: () => void;
	onClose: () => void;
	history: readonly NotificationRecord[];
	locale: string;
}) {
	const dashboard = window.brainstorm.dashboard;
	// Newest first for display (the store keeps oldest→newest).
	const ordered = [...history].reverse();

	// App metadata for icon attribution — fetched once, on first open (the bell
	// itself never needs it). A failed fetch degrades to initials fallbacks.
	const [installedApps, setInstalledApps] = useState<readonly InstalledApp[] | null>(null);
	useEffect(() => {
		if (!open || installedApps !== null) return;
		window.brainstorm.apps
			.listInstalled()
			.then(setInstalledApps)
			.catch(() => setInstalledApps([]));
	}, [open, installedApps]);
	const appsById = useMemo(
		() => new Map((installedApps ?? []).map((app) => [app.id, app])),
		[installedApps],
	);

	// Anything visible in the open panel counts as read — including
	// notifications that arrive WHILE it is open (the opening click alone
	// missed those, leaving them permanently unread).
	useEffect(() => {
		if (open && unread > 0) void dashboard.markAllNotificationsRead();
	}, [open, unread, dashboard]);

	return (
		<span className="notif-bell">
			<IconButton
				icon={IconName.Bell}
				label={t("shell.notifications.openLabel")}
				pressed={open}
				onClick={onToggle}
			/>
			{unread > 0 && (
				<span className="notif-bell__badge" aria-hidden="true">
					{unread > 99 ? "99+" : unread}
				</span>
			)}
			{open && (
				<Popover
					title={t("shell.notifications.center.title")}
					onClose={onClose}
					size={PopoverSize.Medium}
					{...(ordered.length > 0
						? {
								footer: (
									<Button
										variant={ButtonVariant.Ghost}
										iconLeft={IconName.Trash}
										onClick={() => {
											void dashboard.clearNotificationHistory();
										}}
									>
										{t("shell.notifications.center.clear")}
									</Button>
								),
							}
						: {})}
				>
					{ordered.length === 0 ? (
						<div className="notif-center__empty">
							<Icon name={IconName.Bell} size={28} />
							<p className="notif-center__empty-text">{t("shell.notifications.center.empty")}</p>
						</div>
					) : (
						// Capped at 200 in the store; a bounded list rendered directly.
						<ul className="notif-center__list">
							{ordered.map((n) => {
								const app = appsById.get(n.appId);
								const badge = KIND_BADGE[n.kind];
								const entityId = n.entityId;
								const content = (
									<>
										<span className="notif-center__app">
											<AppIcon
												name={app?.name ?? n.appId}
												seed={n.appId}
												src={app?.hasIcon ? window.brainstorm.apps.iconUrl(app.id, app.version) : null}
												size={20}
											/>
											{badge && (
												<span className={`notif-center__kind notif-center__kind--${n.kind}`} aria-hidden="true">
													<Icon name={badge} size={8} />
												</span>
											)}
										</span>
										<div className="notif-center__text">
											<span className="notif-center__title">{n.title}</span>
											{n.body ? <span className="notif-center__body">{n.body}</span> : null}
											<span className="notif-center__time">{formatTimestamp(n.ts, locale)}</span>
										</div>
									</>
								);
								return (
									<li
										key={n.id}
										className={
											n.read ? "notif-center__item" : "notif-center__item notif-center__item--unread"
										}
									>
										{entityId !== undefined ? (
											<button
												type="button"
												className="notif-center__open"
												aria-label={t("shell.notifications.center.open", { title: n.title })}
												onClick={() => {
													openNotificationEntity(entityId);
													onClose();
												}}
											>
												{content}
											</button>
										) : (
											content
										)}
									</li>
								);
							})}
						</ul>
					)}
				</Popover>
			)}
		</span>
	);
}
