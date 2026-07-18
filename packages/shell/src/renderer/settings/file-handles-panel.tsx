/**
 * Open-files panel (9.10) — Settings → Security → "Open files".
 *
 * Lists every live `FileHandle` token the active vault's registry holds
 * (one row per (app, path, mode)) with a per-row Revoke. Apps cannot
 * enumerate / revoke other apps' handles — this surface is the dashboard
 * renderer's privileged side-channel. The list re-fetches on every
 * `app:files-handles-changed` signal (sent on every registry mint /
 * revoke), so adding / removing a handle from a sibling app is reflected
 * live, without polling.
 *
 * Path is shown because the whole point of the panel is "what file is
 * this app touching?" — the same posture the GrantsPanel takes on
 * capabilities (you have to see what you're revoking to revoke it
 * meaningfully).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InstalledApp, ShellFileHandle } from "../../preload";
import { AppIcon } from "../dashboard/app-icon";
import { formatRelative } from "../format/relative-time";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { ConfirmVariant, confirm } from "../ui/confirm";

type AppMeta = { id: string; name: string; iconUrl: string | null };

export function FileHandlesPanel() {
	const [handles, setHandles] = useState<ShellFileHandle[]>([]);
	const [installed, setInstalled] = useState<InstalledApp[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const [list, apps] = await Promise.all([
				window.brainstorm.filesHandles.list(),
				window.brainstorm.apps.listInstalled(),
			]);
			setHandles(list);
			setInstalled(apps);
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.files.loadFailed"));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const off = window.brainstorm.filesHandles.on(() => {
			void refresh();
		});
		return off;
	}, [refresh]);

	const appById = useMemo<Map<string, AppMeta>>(() => {
		const map = new Map<string, AppMeta>();
		for (const app of installed) {
			map.set(app.id, {
				id: app.id,
				name: app.name,
				iconUrl: app.hasIcon ? window.brainstorm.apps.iconUrl(app.id, app.version) : null,
			});
		}
		return map;
	}, [installed]);

	const onRevoke = useCallback(
		async (handle: ShellFileHandle) => {
			const appName = appById.get(handle.appId)?.name ?? handle.appId;
			const confirmed = await confirm({
				title: t("shell.settings.files.revokeConfirm.title"),
				body: t("shell.settings.files.revokeConfirm.body", {
					filename: handle.displayName,
					appId: appName,
				}),
				confirmLabel: t("shell.settings.files.revoke"),
				confirmVariant: ConfirmVariant.Destructive,
			});
			if (!confirmed) return;
			try {
				await window.brainstorm.filesHandles.revoke(handle.handleId);
				// The registry's onChange fires the broadcast → `refresh` runs;
				// no manual refresh call here.
			} catch (e) {
				setError(e instanceof Error ? e.message : t("shell.settings.files.revokeFailed"));
			}
		},
		[appById],
	);

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
	if (handles.length === 0) {
		return <p className="settings__empty">{t("shell.settings.files.noHandles")}</p>;
	}

	const now = Date.now();
	return (
		<ul className="files-handles-panel" data-testid="files-handles-panel">
			{handles.map((handle) => {
				const meta = appById.get(handle.appId);
				return (
					<li key={handle.handleId} className="files-handles-panel__row">
						<AppIcon
							name={meta?.name ?? handle.appId}
							seed={handle.appId}
							src={meta?.iconUrl ?? null}
							size={28}
						/>
						<span className="files-handles-panel__text">
							<span className="files-handles-panel__name" title={handle.path}>
								{handle.displayName}
							</span>
							<span className="files-handles-panel__meta">
								{meta?.name ?? handle.appId}
								{" · "}
								{handle.mode === "read-write"
									? t("shell.settings.files.mode.readWrite")
									: t("shell.settings.files.mode.readOnly")}
								{" · "}
								{formatRelative(now, handle.createdAt)}
							</span>
						</span>
						<Button
							variant={ButtonVariant.Destructive}
							size={ButtonSize.Md}
							onClick={() => {
								void onRevoke(handle);
							}}
							title={t("shell.settings.files.revokeAria", {
								filename: handle.displayName,
								appId: meta?.name ?? handle.appId,
							})}
						>
							{t("shell.settings.files.revoke")}
						</Button>
					</li>
				);
			})}
		</ul>
	);
}
