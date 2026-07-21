/**
 * Settings → Privacy — Browser groups (Browser-7).
 *
 * Two read/revoke surfaces over the web-privacy runtime:
 *   - Browser site permissions: the per-origin camera / microphone /
 *     geolocation decisions the user took in the Browser chrome, with a
 *     revoke-per-origin affordance (revoke ⇒ back to deny-default + the
 *     chrome may ask again).
 *   - Browser egress by host: the per-host aggregate of every page
 *     subresource request the locked web session saw (host · requests ·
 *     blocked · last seen — hosts only, never URLs, per doc-38 hygiene).
 *
 * Rendered inside the Network panel (the Privacy section); reuses its
 * `network-egress__*` chrome so the groups read as one panel.
 */

import { SitePermissionKind } from "@brainstorm-os/sdk-types";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { SitePermissionGrant, SiteTrustGrant, WebEgressHostSummary } from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { IconName } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { TextField, TextFieldSize } from "../ui/text-field";
import { formatRelative } from "./network-egress-panel";
import "./browser-privacy-panel.css";

const EGRESS_ROW_LIMIT = 200;

function permissionLabel(kind: SitePermissionKind): string {
	switch (kind) {
		case SitePermissionKind.Camera:
			return t("shell.settings.webPrivacy.permission.camera");
		case SitePermissionKind.Microphone:
			return t("shell.settings.webPrivacy.permission.microphone");
		case SitePermissionKind.Geolocation:
			return t("shell.settings.webPrivacy.permission.geolocation");
	}
}

export function BrowserPrivacyPanel() {
	const [grants, setGrants] = useState<readonly SitePermissionGrant[]>([]);
	const [egress, setEgress] = useState<readonly WebEgressHostSummary[]>([]);
	const [trusted, setTrusted] = useState<readonly SiteTrustGrant[]>([]);

	const refresh = useCallback(async () => {
		try {
			const [grantRows, egressRows, trustRows] = await Promise.all([
				window.brainstorm.webPrivacy.sitePermissions.list(),
				window.brainstorm.webPrivacy.egress.summary(EGRESS_ROW_LIMIT),
				window.brainstorm.webPrivacy.trust.list(),
			]);
			setGrants(grantRows);
			setEgress(egressRows);
			setTrusted(trustRows);
		} catch {
			// The groups render their empty states; a transient IPC failure
			// must not take down the rest of the Privacy panel.
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const onRevoke = useCallback(
		async (origin: string) => {
			await window.brainstorm.webPrivacy.sitePermissions.revoke(origin);
			await refresh();
		},
		[refresh],
	);

	const onTrustAdd = useCallback(
		async (origin: string): Promise<boolean> => {
			const ok = await window.brainstorm.webPrivacy.trust.set(origin, true);
			if (ok) await refresh();
			return ok;
		},
		[refresh],
	);

	const onTrustRevoke = useCallback(
		async (origin: string) => {
			await window.brainstorm.webPrivacy.trust.revoke(origin);
			await refresh();
		},
		[refresh],
	);

	return (
		<>
			<SitePermissionsGroup grants={grants} onRevoke={onRevoke} />
			<TrustedSitesGroup trusted={trusted} onAdd={onTrustAdd} onRevoke={onTrustRevoke} />
			<EgressGroup rows={egress} />
		</>
	);
}

/** Normalize a user-typed site into a web origin (`x.com` → `https://x.com`).
 *  Returns null for input that can't be an http(s) origin — the main-side
 *  handler validates again, this is just for a friendlier input. */
function toOrigin(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(withScheme);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.origin;
	} catch {
		return null;
	}
}

function TrustedSitesGroup({
	trusted,
	onAdd,
	onRevoke,
}: {
	trusted: readonly SiteTrustGrant[];
	onAdd: (origin: string) => Promise<boolean>;
	onRevoke: (origin: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState("");
	const [error, setError] = useState(false);

	const submit = useCallback(
		async (event: FormEvent) => {
			event.preventDefault();
			const origin = toOrigin(draft);
			if (!origin) {
				setError(true);
				return;
			}
			const ok = await onAdd(origin);
			if (ok) {
				setDraft("");
				setError(false);
			} else {
				setError(true);
			}
		},
		[draft, onAdd],
	);

	return (
		<div className="network-egress__group" data-testid="browser-privacy-trust">
			<h4 className="network-egress__group-title">{t("shell.settings.webPrivacy.trust.title")}</h4>
			<p className="network-egress__hint">{t("shell.settings.webPrivacy.trust.summary")}</p>
			<form className="browser-privacy__trust-add" onSubmit={(e) => void submit(e)}>
				<TextField
					size={TextFieldSize.Sm}
					type="text"
					inputMode="url"
					spellCheck={false}
					value={draft}
					onChange={(next) => {
						setDraft(next);
						setError(false);
					}}
					placeholder={t("shell.settings.webPrivacy.trust.addPlaceholder")}
					aria-label={t("shell.settings.webPrivacy.trust.addLabel")}
					{...(error
						? {
								error: (
									<span data-testid="browser-privacy-trust-error">
										{t("shell.settings.webPrivacy.trust.invalid")}
									</span>
								),
							}
						: {})}
					data-testid="browser-privacy-trust-input"
				/>
				<Button
					type="submit"
					variant={ButtonVariant.Primary}
					size={ButtonSize.Md}
					disabled={draft.trim().length === 0}
				>
					{t("shell.settings.webPrivacy.trust.add")}
				</Button>
			</form>
			{trusted.length === 0 ? (
				<p className="network-egress__empty" data-testid="browser-privacy-trust-empty">
					{t("shell.settings.webPrivacy.trust.empty")}
				</p>
			) : (
				<ul className="browser-privacy__list">
					{trusted.map((grant) => (
						<li
							key={grant.origin}
							className="browser-privacy__row"
							data-testid={`browser-privacy-trust-${grant.origin}`}
						>
							<span className="browser-privacy__origin" title={grant.origin}>
								{grant.origin}
							</span>
							<span className="network-egress__pill browser-privacy__pill--allowed">
								{t("shell.settings.webPrivacy.trust.trusted")}
							</span>
							<IconButton
								icon={IconName.Close}
								label={t("shell.settings.webPrivacy.trust.revoke")}
								onClick={() => void onRevoke(grant.origin)}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function SitePermissionsGroup({
	grants,
	onRevoke,
}: {
	grants: readonly SitePermissionGrant[];
	onRevoke: (origin: string) => Promise<void>;
}) {
	return (
		<div className="network-egress__group" data-testid="browser-privacy-permissions">
			<h4 className="network-egress__group-title">
				{t("shell.settings.webPrivacy.permissions.title")}
			</h4>
			<p className="network-egress__hint">{t("shell.settings.webPrivacy.permissions.summary")}</p>
			{grants.length === 0 ? (
				<p className="network-egress__empty" data-testid="browser-privacy-permissions-empty">
					{t("shell.settings.webPrivacy.permissions.empty")}
				</p>
			) : (
				<ul className="browser-privacy__list">
					{grants.map((grant) => (
						<li
							key={`${grant.origin} ${grant.permission}`}
							className="browser-privacy__row"
							data-testid={`browser-privacy-grant-${grant.origin}-${grant.permission}`}
						>
							<span className="browser-privacy__origin" title={grant.origin}>
								{grant.origin}
							</span>
							<span className="browser-privacy__permission">{permissionLabel(grant.permission)}</span>
							<span
								className={`network-egress__pill ${
									grant.allow ? "browser-privacy__pill--allowed" : "browser-privacy__pill--blocked"
								}`}
							>
								{grant.allow
									? t("shell.settings.webPrivacy.permissions.allowed")
									: t("shell.settings.webPrivacy.permissions.blocked")}
							</span>
							<IconButton
								icon={IconName.Close}
								label={t("shell.settings.webPrivacy.permissions.revoke")}
								onClick={() => void onRevoke(grant.origin)}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function EgressGroup({ rows }: { rows: readonly WebEgressHostSummary[] }) {
	return (
		<div className="network-egress__group" data-testid="browser-privacy-egress">
			<h4 className="network-egress__group-title">{t("shell.settings.webPrivacy.egress.title")}</h4>
			<p className="network-egress__hint">{t("shell.settings.webPrivacy.egress.summary")}</p>
			{rows.length === 0 ? (
				<p className="network-egress__empty" data-testid="browser-privacy-egress-empty">
					{t("shell.settings.webPrivacy.egress.empty")}
				</p>
			) : (
				<div className="browser-privacy__egress" data-testid="browser-privacy-egress-table">
					<div className="browser-privacy__egress-header">
						<span>{t("shell.settings.webPrivacy.egress.col.host")}</span>
						<span className="browser-privacy__num">
							{t("shell.settings.webPrivacy.egress.col.requests")}
						</span>
						<span className="browser-privacy__num">
							{t("shell.settings.webPrivacy.egress.col.blocked")}
						</span>
						<span>{t("shell.settings.webPrivacy.egress.col.lastSeen")}</span>
					</div>
					{rows.map((row) => (
						<div key={row.host} className="browser-privacy__egress-row">
							<span className="browser-privacy__origin" title={row.host}>
								{row.host}
							</span>
							<span className="browser-privacy__num">{row.count}</span>
							<span className="browser-privacy__num">{row.blockedCount}</span>
							<span>{formatRelative(row.lastSeenMs)}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
