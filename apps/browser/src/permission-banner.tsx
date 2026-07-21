/**
 * Per-site permission ask (Browser-7). The shell's locked session denies
 * camera / microphone / geolocation by default and pushes a
 * `PermissionRequested` metadata event; this banner is the explicit grant
 * surface. Allow persists the per-origin grant and reloads the tab so the
 * page re-requests (the original callback already resolved deny — the shell
 * never holds a page hostage waiting on UI); Block persists the refusal so
 * the site stops asking; Dismiss just hides the ask for now.
 */

import { SitePermissionKind } from "@brainstorm-os/sdk-types";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import { t } from "./i18n";

export type PendingPermission = {
	tabId: string;
	origin: string;
	permission: SitePermissionKind;
};

export function permissionAskLabel(request: PendingPermission): string {
	switch (request.permission) {
		case SitePermissionKind.Camera:
			return t("permission.ask.camera", { origin: request.origin });
		case SitePermissionKind.Microphone:
			return t("permission.ask.microphone", { origin: request.origin });
		case SitePermissionKind.Geolocation:
			return t("permission.ask.geolocation", { origin: request.origin });
	}
}

export function PermissionBanner({
	request,
	onAllow,
	onBlock,
	onDismiss,
}: {
	request: PendingPermission;
	onAllow: () => void;
	onBlock: () => void;
	onDismiss: () => void;
}): ReactElement {
	return (
		<div className="browser__permission" role="alert">
			<Icon name={IconName.Lock} size={14} />
			<span className="browser__permission-text">{permissionAskLabel(request)}</span>
			<button type="button" className="browser__permission-allow" onClick={onAllow}>
				{t("permission.allow")}
			</button>
			<button type="button" className="browser__permission-block" onClick={onBlock}>
				{t("permission.block")}
			</button>
			<button
				type="button"
				className="browser__navbtn"
				aria-label={t("permission.dismiss")}
				data-bs-tooltip={t("permission.dismiss")}
				onClick={onDismiss}
			>
				<Icon name={IconName.Close} size={12} />
			</button>
		</div>
	);
}
