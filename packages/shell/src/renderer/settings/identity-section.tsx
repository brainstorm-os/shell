/**
 * Settings → Identity section (Collab-C6). Edits the local user's self-asserted
 * display profile — the `{displayName, avatarRef?}` that collaborators see for
 * your sovereign pubkey. The name is signed in the main process (the secret
 * never crosses IPC) via the privileged `profile.*` IPC; sandboxed apps reach
 * the same data through the capability-gated `roster` service.
 *
 * The pubkey is the identity — the name is a convenience hint. The fingerprint
 * is shown read-only so a collaborator can verify it out-of-band (the same
 * `ed25519:<hex>` the device-pairing SAS uses).
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { IconKind } from "@brainstorm-os/sdk-types";
import { parseIcon } from "@brainstorm-os/sdk/entity-icon";
import { useEffect, useMemo, useRef, useState } from "react";
import { initialsFor } from "../dashboard/app-icon-palette";
import { t } from "../i18n/t";
import { Button, ButtonVariant } from "../ui/button";
import { EntityIcon } from "../ui/entity-icon";
import { IconName, Icon as UiIcon } from "../ui/icon";
import { TextField, TextFieldSize } from "../ui/text-field";
import "./identity-section.css";

type ProfileView = {
	pubkey: string;
	fingerprint: string;
	displayName: string;
	avatarRef: string | null;
};

/** The avatar is a serialized universal `Icon` carried in the string-typed
 *  `avatarRef`; parse it back for rendering and re-serialize on change. */
function avatarIcon(avatarRef: string | null): Icon | null {
	if (!avatarRef) return null;
	try {
		return parseIcon(JSON.parse(avatarRef));
	} catch {
		return null;
	}
}

export function IdentitySection() {
	const [profile, setProfile] = useState<ProfileView | null>(null);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
		},
		[],
	);

	useEffect(() => {
		let live = true;
		void window.brainstorm.profile.get().then((p) => {
			if (!live) return;
			setProfile(p);
			setDraft(p.displayName);
		});
		return () => {
			live = false;
		};
	}, []);

	const dirty = profile !== null && draft.trim() !== profile.displayName;
	const icon = useMemo(() => avatarIcon(profile?.avatarRef ?? null), [profile?.avatarRef]);

	// A single persistence path so the name field and the avatar each preserve
	// the other's value (the signed profile carries both — omitting one clears it).
	const persist = async (displayName: string, avatarRef: string | null) => {
		setSaving(true);
		setSaved(false);
		try {
			const next = await window.brainstorm.profile.set({ displayName, avatarRef });
			setProfile(next);
			setDraft(next.displayName);
			return next;
		} finally {
			setSaving(false);
		}
	};

	const save = async () => {
		const name = draft.trim();
		if (!name) return;
		await persist(name, profile?.avatarRef ?? null);
		setSaved(true);
	};

	const copyFingerprint = async () => {
		const fp = profile?.fingerprint;
		if (!fp) return;
		try {
			await navigator.clipboard.writeText(fp);
			setCopied(true);
			if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
			copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard blocked — the value is `user-select: all`, so it's still
			// selectable to copy by hand.
		}
	};

	// An avatar is a photo, not a glyph: clicking opens a native image-file
	// dialog and stores the upload as an `Icon` of kind Image. With no upload
	// the button falls back to the display-name initials (rendered below).
	const editAvatar = async () => {
		const uploaded = await window.brainstorm.icons.uploadFromDialog();
		if (!uploaded) return; // cancelled
		const name = (draft.trim() || profile?.displayName) ?? "";
		await persist(name, JSON.stringify({ kind: IconKind.Image, value: uploaded.url }));
	};

	const avatarName = draft.trim() || profile?.displayName || "";
	const initials = useMemo(() => initialsFor(avatarName), [avatarName]);

	return (
		<section className="settings__section identity-section">
			<h4 className="settings__section-title">{t("shell.settings.identity.displayName")}</h4>
			<p className="settings__hint">{t("shell.settings.identity.displayNameHint")}</p>
			<form
				className="identity-section__row"
				onSubmit={(e) => {
					e.preventDefault();
					if (dirty) void save();
				}}
			>
				<button
					type="button"
					className="identity-section__avatar"
					onClick={() => void editAvatar()}
					disabled={saving || profile === null}
					data-bs-tooltip={t("shell.settings.identity.avatarEdit")}
					aria-label={t("shell.settings.identity.avatarEdit")}
				>
					<EntityIcon
						icon={icon}
						size={32}
						className="identity-section__avatar-img"
						fallback={
							avatarName.length === 0 ? (
								// No photo AND no name yet: initials degrade to a bare "•",
								// which read as a broken empty circle. The camera glyph says
								// what the button does — pick a photo.
								<UiIcon name={IconName.Camera} size={16} />
							) : (
								<span className="identity-section__initials">{initials}</span>
							)
						}
					/>
				</button>
				<div className="identity-section__input">
					<TextField
						size={TextFieldSize.Md}
						value={draft}
						maxLength={60}
						placeholder={t("shell.settings.identity.displayNamePlaceholder")}
						aria-label={t("shell.settings.identity.displayName")}
						onChange={(next) => {
							setDraft(next);
							setSaved(false);
						}}
					/>
				</div>
				<Button type="submit" onClick={() => void save()} disabled={!dirty || saving}>
					{saving ? t("shell.common.loading") : t("shell.settings.identity.save")}
				</Button>
			</form>
			{saved ? (
				<p className="settings__hint identity-section__saved" role="status">
					{t("shell.settings.identity.saved")}
				</p>
			) : null}

			<h4 className="settings__section-title identity-section__fingerprint-title">
				{t("shell.settings.identity.fingerprint")}
			</h4>
			<p className="settings__hint">{t("shell.settings.identity.fingerprintHint")}</p>
			<div className="identity-section__fingerprint-row">
				<code className="identity-section__fingerprint">
					{profile?.fingerprint || t("shell.settings.identity.noVault")}
				</code>
				{profile?.fingerprint ? (
					<Button
						variant={ButtonVariant.Neutral}
						onClick={() => void copyFingerprint()}
						aria-label={t("shell.settings.identity.copyFingerprint")}
					>
						{copied ? t("shell.settings.identity.copied") : t("shell.settings.identity.copy")}
					</Button>
				) : null}
			</div>
		</section>
	);
}
