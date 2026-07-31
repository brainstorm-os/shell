/**
 * Settings → Sync → Local network (`P2P-1`).
 *
 * The reason this file exists: before it, LAN sync could not be turned on by a
 * user. The shipped control set only the HOST half — whether this device
 * accepts connections — and the dial half read a flag in `vault.json` that
 * nothing outside tests ever wrote. So one machine could listen and no machine
 * would ever call. This panel is the other half, and it is deliberately one
 * group rather than two: "accept" and "find" are the two ends of the same
 * sentence, and a user who sets only one gets nothing.
 *
 * Two smaller things it also fixes. The host toggle was rendered only in
 * `SyncSection`'s "status unavailable" branch, so on the normal path it was
 * unreachable; it now lives here and here is rendered unconditionally. And the
 * panel names the live transport, because a surface that says "no server"
 * while a relay is carrying the traffic would be a false privacy claim rather
 * than a cosmetic slip.
 */

import {
	LanDialMode,
	LanHostMode,
	SyncTransportKind,
} from "@brainstorm-os/protocol/sync-status-types";
import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { TextField, TextFieldSize } from "../ui/text-field";

type LanPeering = {
	dialMode: string;
	manualUrl: string | null;
	activeUrl: string | null;
	listenerUrl: string | null;
	peers: readonly { instance: string; urls: readonly string[] }[];
};

/** What the address field is currently saying about itself. */
enum AddressStatus {
	Idle = "idle",
	Saved = "saved",
	Invalid = "invalid",
}

export function LanSyncControl({ transportKind }: { transportKind?: SyncTransportKind }) {
	const [hostMode, setHostMode] = useState<string | null>(null);
	const [peering, setPeering] = useState<LanPeering | null>(null);
	const [draft, setDraft] = useState("");
	const [addressStatus, setAddressStatus] = useState<AddressStatus>(AddressStatus.Idle);

	const refresh = useCallback(async (): Promise<void> => {
		const bridge = window.brainstorm?.syncStatus;
		if (!bridge?.getLanPeering) return;
		const next = await bridge.getLanPeering();
		if (next) {
			setPeering(next);
			setDraft(next.manualUrl ?? "");
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		const bridge = window.brainstorm?.syncStatus;
		if (!bridge?.getLanHostMode) return;
		void bridge.getLanHostMode().then((mode) => {
			if (!cancelled) setHostMode(mode);
		});
		void refresh();
		// Discovery is asynchronous and mDNS records arrive whenever they arrive,
		// so the peer list is polled rather than pushed. Slow on purpose: this is
		// a settings panel, and a record is an address hint with no urgency.
		const timer = window.setInterval(() => void refresh(), 4_000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [refresh]);

	const applyHostMode = (next: string): void => {
		setHostMode(next);
		void window.brainstorm?.syncStatus
			?.setLanHostMode?.(next)
			// Main normalises an unrecognised mode to "off"; trust its answer over
			// the optimistic local one.
			.then((saved) => {
				if (saved) setHostMode(saved);
				void refresh();
			});
	};

	const applyDialMode = (next: string): void => {
		setPeering((prev) => (prev ? { ...prev, dialMode: next } : prev));
		void window.brainstorm?.syncStatus?.setLanDialMode?.(next).then((saved) => {
			if (saved) setPeering(saved);
		});
	};

	const applyAddress = (raw: string | null): void => {
		setAddressStatus(AddressStatus.Idle);
		void window.brainstorm?.syncStatus?.setLanPeerAddress?.(raw).then((saved) => {
			// `null` is a refusal to store, not a failed write: an address that
			// does not validate would make the dialer silently never dial, which
			// looks exactly like the bug this panel exists to fix.
			if (!saved) {
				setAddressStatus(AddressStatus.Invalid);
				return;
			}
			setPeering(saved);
			setDraft(saved.manualUrl ?? "");
			setAddressStatus(AddressStatus.Saved);
		});
	};

	if (hostMode === null && peering === null) return null;

	const dialMode = peering?.dialMode ?? LanDialMode.Off;
	const onLan = transportKind === SyncTransportKind.Lan && peering?.activeUrl;

	return (
		<div className="sync-section__group" data-testid="lan-sync">
			<h4 className="sync-section__group-title">{t("shell.settings.sync.lanHost.title")}</h4>
			<p className="sync-section__tooltip">{t("shell.settings.sync.lanHost.summary")}</p>

			{onLan && (
				<p className="sync-section__lan-live" data-testid="lan-sync-live">
					{t("shell.settings.sync.lan.live", { peer: peering.activeUrl ?? "" })}
				</p>
			)}

			{hostMode !== null && (
				<div className="sync-section__row">
					<span className="sync-section__label">{t("shell.settings.sync.lanHost.label")}</span>
					<SelectMenu
						value={hostMode}
						ariaLabel={t("shell.settings.sync.lanHost.label")}
						options={[
							{ value: LanHostMode.Off, label: t("shell.settings.sync.lanHost.mode.off") },
							{
								value: LanHostMode.WhenVaultOpen,
								label: t("shell.settings.sync.lanHost.mode.on"),
							},
						]}
						onChange={applyHostMode}
						data-testid="lan-host-mode"
					/>
				</div>
			)}

			{peering?.listenerUrl && (
				<div className="sync-section__row">
					<span className="sync-section__label">{t("shell.settings.sync.lan.thisDevice")}</span>
					<span
						className="sync-section__value sync-section__value--clip"
						title={peering.listenerUrl}
						data-testid="lan-listener-url"
					>
						{peering.listenerUrl}
					</span>
				</div>
			)}

			{peering && (
				<>
					<div className="sync-section__row">
						<span className="sync-section__label">{t("shell.settings.sync.lan.dial.label")}</span>
						<SelectMenu
							value={dialMode}
							ariaLabel={t("shell.settings.sync.lan.dial.label")}
							options={[
								{ value: LanDialMode.Off, label: t("shell.settings.sync.lan.dial.off") },
								{ value: LanDialMode.Auto, label: t("shell.settings.sync.lan.dial.auto") },
								{ value: LanDialMode.Manual, label: t("shell.settings.sync.lan.dial.manual") },
							]}
							onChange={applyDialMode}
							data-testid="lan-dial-mode"
						/>
					</div>

					{dialMode === LanDialMode.Auto && (
						<div className="sync-section__lan-peers" data-testid="lan-peer-list">
							{peering.peers.length === 0 ? (
								<p className="sync-section__tooltip">{t("shell.settings.sync.lan.peers.none")}</p>
							) : (
								peering.peers.map((peer) => (
									<div className="sync-section__row" key={peer.instance}>
										<span className="sync-section__label">{peer.instance}</span>
										<span className="sync-section__value sync-section__value--clip">
											{peer.urls[0] ?? ""}
										</span>
									</div>
								))
							)}
						</div>
					)}

					{dialMode === LanDialMode.Manual && (
						<div className="sync-section__lan-address">
							<div className="sync-section__row">
								<span className="sync-section__label">{t("shell.settings.sync.lan.address.label")}</span>
								<TextField
									value={draft}
									size={TextFieldSize.Sm}
									spellCheck={false}
									maxLength={64}
									placeholder={t("shell.settings.sync.lan.address.placeholder")}
									aria-label={t("shell.settings.sync.lan.address.label")}
									data-testid="lan-peer-address"
									onChange={(next) => {
										setDraft(next);
										setAddressStatus(AddressStatus.Idle);
									}}
								/>
							</div>
							<div className="sync-section__lan-actions">
								<Button
									variant={ButtonVariant.Neutral}
									size={ButtonSize.Md}
									onClick={() => applyAddress(draft)}
									data-testid="lan-peer-address-save"
								>
									{t("shell.settings.sync.lan.address.save")}
								</Button>
								{peering.manualUrl && (
									<Button
										variant={ButtonVariant.Ghost}
										size={ButtonSize.Md}
										onClick={() => applyAddress(null)}
										data-testid="lan-peer-address-clear"
									>
										{t("shell.settings.sync.lan.address.clear")}
									</Button>
								)}
							</div>
							{addressStatus === AddressStatus.Invalid && (
								<p
									className="sync-section__tooltip sync-section__tooltip--error"
									role="alert"
									data-testid="lan-peer-address-error"
								>
									{t("shell.settings.sync.lan.address.invalid")}
								</p>
							)}
							{addressStatus === AddressStatus.Saved && (
								<p className="sync-section__tooltip" data-testid="lan-peer-address-saved">
									{t("shell.settings.sync.lan.address.saved")}
								</p>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}
