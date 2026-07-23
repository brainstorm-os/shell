/**
 * Connect-account dialog (Mailbox-5 Gmail OAuth + Mailbox-2 IMAP/SMTP).
 * Gmail: collects the user's Google OAuth installed-app client id/secret and
 * hands them to `mail.connectGmail` — the shell runs the browser consent
 * flow. IMAP: collects host coordinates + an app-password and hands them to
 * `mail.connectImap`. Every secret is sealed in Tier 2 shell-side; nothing
 * sensitive is kept in this renderer beyond the form state itself.
 */

import { SyncWindow } from "@brainstorm-os/sdk-types";
import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { Checkbox } from "@brainstorm-os/sdk/checkbox";
import { Popover, PopoverSize } from "@brainstorm-os/sdk/popover";
import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import { useId, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { t } from "../i18n";

export type ConnectAccountInput = {
	clientId: string;
	clientSecret?: string;
	label?: string;
};

export type ConnectImapInput = {
	/** Reconnect-in-place (Mailbox-13): the existing account being repaired. */
	accountRef?: string;
	address: string;
	username?: string;
	secret: string;
	incoming: { host: string; port: number; tls: boolean };
	outgoing: { host: string; port: number; tls: boolean };
	/** How far back the first sync reaches (`SyncWindow` value). */
	syncWindow: string;
};

/** Prefill for reconnect-in-place (Mailbox-13) — the failing account's
 *  stored coordinates; the user only re-enters the password. */
export type ReconnectSeed = {
	accountRef: string;
	address: string;
	incoming: { host: string; port: number; tls: boolean };
	outgoing: { host: string; port: number; tls: boolean };
	syncWindow?: string;
};

/** Which account family the form collects. Local UI state only — the wire
 *  protocol enum is `MailProtocol` on the created entity. */
const ConnectMode = {
	Gmail: "gmail",
	Imap: "imap",
} as const;
type ConnectMode = (typeof ConnectMode)[keyof typeof ConnectMode];

const IMAPS_PORT = 993;
const SMTPS_PORT = 465;

export function ConnectAccountDialog(props: {
	onClose: () => void;
	onConnect: (input: ConnectAccountInput) => Promise<void>;
	onConnectImap?: (input: ConnectImapInput) => Promise<void>;
	/** Present ⇒ the dialog repairs an existing IMAP account: coordinates
	 *  prefilled, mode locked to IMAP, submit targets the same entity. */
	reconnect?: ReconnectSeed;
}): ReactElement {
	const seed = props.reconnect;
	// Stable form id so the sticky Popover footer can host type=submit buttons
	// that still submit this form (HTML `form="…"` association — F-447).
	const formId = useId();
	const [mode, setMode] = useState<ConnectMode>(seed ? ConnectMode.Imap : ConnectMode.Gmail);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [label, setLabel] = useState("");
	const [address, setAddress] = useState(seed?.address ?? "");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [imapHost, setImapHost] = useState(seed?.incoming.host ?? "");
	const [imapPort, setImapPort] = useState(String(seed?.incoming.port ?? IMAPS_PORT));
	const [imapTls, setImapTls] = useState(seed?.incoming.tls ?? true);
	const [smtpHost, setSmtpHost] = useState(seed?.outgoing.host ?? "");
	const [smtpPort, setSmtpPort] = useState(String(seed?.outgoing.port ?? SMTPS_PORT));
	const [smtpTls, setSmtpTls] = useState(seed?.outgoing.tls ?? true);
	// Days90 default — the service's own 30d default surprised the owner with a
	// "handful of messages" first sync (F-440); the picker makes the window a
	// visible choice.
	const [syncWindow, setSyncWindow] = useState<SyncWindow>(
		seed !== undefined && (Object.values(SyncWindow) as string[]).includes(seed.syncWindow ?? "")
			? (seed.syncWindow as SyncWindow)
			: SyncWindow.Days90,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Horizontal radiogroup keyboard model (←/→/Home/End move + select, roving
	// tabindex, aria-checked) — roles flow through the hook, not literals.
	const connectModes = [ConnectMode.Gmail, ConnectMode.Imap] as const;
	const selectMode = (index: number) => setMode(connectModes[index] ?? ConnectMode.Gmail);
	const modeKeyboard = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: connectModes.length,
		activeIndex: Math.max(0, connectModes.indexOf(mode)),
		onActiveIndexChange: selectMode,
		onActivate: selectMode,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.AriaChecked,
		...(busy ? { disabled: new Set([0, 1]) } : {}),
	});

	const imapReady =
		address.trim().length > 0 &&
		password.length > 0 &&
		imapHost.trim().length > 0 &&
		smtpHost.trim().length > 0 &&
		Number.isInteger(Number(imapPort)) &&
		Number.isInteger(Number(smtpPort));

	const gmailReady = clientId.trim().length > 0;
	const ready = mode === ConnectMode.Gmail ? gmailReady : imapReady && Boolean(props.onConnectImap);

	const run = (work: Promise<void>): void => {
		setBusy(true);
		setError(null);
		work
			.then(() => props.onClose())
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
				setBusy(false);
			});
	};

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (busy || !ready) return;
		if (mode === ConnectMode.Gmail) {
			const secret = clientSecret.trim();
			const name = label.trim();
			run(
				props.onConnect({
					clientId: clientId.trim(),
					...(secret.length > 0 ? { clientSecret: secret } : {}),
					...(name.length > 0 ? { label: name } : {}),
				}),
			);
			return;
		}
		if (!props.onConnectImap) return;
		const user = username.trim();
		run(
			props.onConnectImap({
				...(seed !== undefined ? { accountRef: seed.accountRef } : {}),
				address: address.trim(),
				...(user.length > 0 ? { username: user } : {}),
				// Trim paste artifacts (trailing newline/space from a password
				// manager or the provider's app-password page) — servers reject
				// them as plain wrong credentials, surfacing as an
				// unexplainable "authentication failed".
				secret: password.trim(),
				incoming: { host: imapHost.trim(), port: Number(imapPort), tls: imapTls },
				outgoing: { host: smtpHost.trim(), port: Number(smtpPort), tls: smtpTls },
				syncWindow,
			}),
		);
	};

	const field = (
		labelKey: Parameters<typeof t>[0],
		value: string,
		onChange: (next: string) => void,
		opts?: { type?: string; placeholder?: string; required?: boolean },
	): ReactElement => (
		<label className="mb-connect__field">
			<span className="mb-connect__label">{t(labelKey)}</span>
			<input
				className="bs-input"
				type={opts?.type ?? "text"}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				{...(opts?.placeholder !== undefined ? { placeholder: opts.placeholder } : {})}
				disabled={busy}
				required={opts?.required ?? false}
			/>
		</label>
	);

	return (
		<Popover
			title={t(seed !== undefined ? "connect.title.reconnect" : "connect.title")}
			onClose={props.onClose}
			size={PopoverSize.Medium}
			testId="mb-connect"
			footer={
				<>
					{/* Stays enabled while busy: the consent tab continues in the
					    browser either way, so closing the dialog is harmless —
					    and matches backdrop/Escape, which also close. */}
					<button type="button" className="bs-btn bs-btn--secondary" onClick={props.onClose}>
						{t("connect.cancel")}
					</button>
					<button
						type="submit"
						form={formId}
						className="bs-btn"
						data-bs-primary
						disabled={busy || !ready}
					>
						{busy ? t("connect.connecting") : t("connect.submit")}
					</button>
				</>
			}
		>
			<form id={formId} className="mb-connect" onSubmit={submit}>
				{props.onConnectImap && seed === undefined ? (
					<div
						className="bs-segmented mb-connect__modes"
						{...modeKeyboard.containerProps}
						aria-label={t("connect.mode")}
					>
						<button
							type="button"
							{...modeKeyboard.getItemProps(0)}
							className={`bs-segmented__tab${mode === ConnectMode.Gmail ? " is-active" : ""}`}
							onClick={() => setMode(ConnectMode.Gmail)}
							disabled={busy}
						>
							{t("connect.mode.gmail")}
						</button>
						<button
							type="button"
							{...modeKeyboard.getItemProps(1)}
							className={`bs-segmented__tab${mode === ConnectMode.Imap ? " is-active" : ""}`}
							onClick={() => setMode(ConnectMode.Imap)}
							disabled={busy}
						>
							{t("connect.mode.imap")}
						</button>
					</div>
				) : null}

				{mode === ConnectMode.Gmail ? (
					<>
						<p className="mb-connect__help">{t("connect.help")}</p>
						{field("connect.clientId", clientId, setClientId, {
							placeholder: t("connect.clientId.placeholder"),
							required: true,
						})}
						{field("connect.clientSecret", clientSecret, setClientSecret, { type: "password" })}
						{field("connect.label", label, setLabel, {
							placeholder: t("connect.label.placeholder"),
						})}
						{busy ? (
							<p className="mb-connect__waiting" role="status">
								{t("connect.waiting")}
							</p>
						) : null}
					</>
				) : (
					<>
						{/* Reconnect drops the how-to lecture (F-447) — user is
						    fixing one field, not learning IMAP. Create mode keeps
						    the help for first-time setup. */}
						{seed === undefined ? (
							<p className="mb-connect__help">{t("connect.imap.help")}</p>
						) : null}
						{field("connect.imap.address", address, setAddress, {
							placeholder: t("connect.imap.address.placeholder"),
							required: true,
						})}
						{field("connect.imap.username", username, setUsername, {
							placeholder: t("connect.imap.username.placeholder"),
						})}
						{field("connect.imap.password", password, setPassword, {
							type: "password",
							required: true,
						})}
						<div className="mb-connect__hostrow">
							{field("connect.imap.host", imapHost, setImapHost, { required: true })}
							{field("connect.imap.port", imapPort, setImapPort, {})}
							<Checkbox
								className="mb-connect__tls"
								label={t("connect.imap.tls")}
								checked={imapTls}
								onChange={setImapTls}
								disabled={busy}
							/>
						</div>
						<div className="mb-connect__field">
							<span className="mb-connect__label">{t("connect.imap.window")}</span>
							<SelectMenu
								value={syncWindow}
								onChange={(next) => setSyncWindow(next)}
								ariaLabel={t("connect.imap.window")}
								disabled={busy}
								options={[
									{ value: SyncWindow.Days30, label: t("connect.imap.window.30d") },
									{ value: SyncWindow.Days90, label: t("connect.imap.window.90d") },
									{ value: SyncWindow.Year1, label: t("connect.imap.window.1y") },
									{ value: SyncWindow.All, label: t("connect.imap.window.all") },
								]}
							/>
						</div>
						<div className="mb-connect__hostrow">
							{field("connect.smtp.host", smtpHost, setSmtpHost, { required: true })}
							{field("connect.smtp.port", smtpPort, setSmtpPort, {})}
							<Checkbox
								className="mb-connect__tls"
								label={t("connect.smtp.tls")}
								checked={smtpTls}
								onChange={setSmtpTls}
								disabled={busy}
							/>
						</div>
					</>
				)}

				{error ? (
					<p className="mb-connect__error" role="alert">
						{t("connect.error", { message: error })}
					</p>
				) : null}
			</form>
		</Popover>
	);
}
