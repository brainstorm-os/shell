/**
 * Settings → Devices (Stage 10.5b — pairing UX).
 *
 * Three-state section:
 *   - Idle list (default): current devices + Add / Join CTAs.
 *   - Add-device flow: source-side pairing UI (QR / SAS).
 *   - Join-vault flow: target-side pairing UI (scan / paste).
 *
 * Consumes the privileged `window.brainstorm.pairing` bridge introduced
 * by 10.5b. The broker-side wire-up lands at 10.5c.
 */

import { AnimatePresence } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import type { SignedAddDeviceRecord } from "../../preload";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { IconName } from "../ui/icon";
import { Popover } from "../ui/popover";
import { PopoverSize } from "../ui/popover-types";
import { DevicesAddFlow } from "./devices-add-flow";
import { DevicesJoinFlow } from "./devices-join-flow";
import { DevicesList } from "./devices-list";

export enum DevicesViewState {
	List = "list",
	Add = "add",
	Join = "join",
}

export type DevicesSectionProps = {
	initialView?: DevicesViewState;
};

export function DevicesSection({ initialView = DevicesViewState.List }: DevicesSectionProps = {}) {
	const [view, setView] = useState<DevicesViewState>(initialView);
	const [records, setRecords] = useState<SignedAddDeviceRecord[]>([]);
	const [thisDevice, setThisDevice] = useState<string | null>(null);
	const [hasRelay, setHasRelay] = useState<boolean>(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const [list, fingerprint, relay] = await Promise.all([
				window.brainstorm.pairing.listDevices(),
				window.brainstorm.pairing.thisDeviceFingerprint(),
				window.brainstorm.pairing.hasRelay(),
			]);
			setRecords(list.records);
			setThisDevice(fingerprint);
			setHasRelay(relay);
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.devices.loadFailed"));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const off = window.brainstorm.pairing.on(() => {
			void refresh();
		});
		return off;
	}, [refresh]);

	const onRevoke = useCallback(async (record: SignedAddDeviceRecord) => {
		const label = record.deviceLabel || t("shell.settings.devices.unlabeled");
		const confirmed = await confirm({
			title: t("shell.settings.devices.revokeConfirm.title"),
			body: t("shell.settings.devices.revokeConfirm.body", { deviceLabel: label }),
			confirmLabel: t("shell.settings.devices.revoke"),
			confirmVariant: ConfirmVariant.Destructive,
		});
		if (!confirmed) return;
		try {
			await window.brainstorm.pairing.revokeDevice({
				deviceEd25519Pub: record.deviceEd25519Pub,
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.devices.loadFailed"));
		}
	}, []);

	useShortcut(
		"shell.devices.addDevice",
		() => {
			if (view === DevicesViewState.List && hasRelay) {
				setView(DevicesViewState.Add);
			}
		},
		{ enabled: view === DevicesViewState.List },
	);

	const closeFlow = () => setView(DevicesViewState.List);

	// The pairing flows overlay the device list in the shared `<Popover>` so the
	// existing devices stay in context during pairing (and the popover owns the
	// chrome — the flows render `embedded`). Computed outside the loading/error
	// gate so an `initialView` route still resolves on the first paint.
	const pairingOverlay = (
		<AnimatePresence>
			{view === DevicesViewState.Add && (
				<Popover
					title={t("shell.settings.devices.add.title")}
					onClose={closeFlow}
					size={PopoverSize.Small}
				>
					<DevicesAddFlow embedded onClose={closeFlow} onPaired={refresh} />
				</Popover>
			)}
			{view === DevicesViewState.Join && (
				<Popover
					title={t("shell.settings.devices.join.title")}
					onClose={closeFlow}
					size={PopoverSize.Small}
				>
					<DevicesJoinFlow embedded onClose={closeFlow} onJoined={refresh} />
				</Popover>
			)}
		</AnimatePresence>
	);

	if (loading) {
		return (
			<section className="settings__section">
				<p className="settings__placeholder">{t("shell.settings.devices.loading")}</p>
				{pairingOverlay}
			</section>
		);
	}

	if (error) {
		return (
			<section className="settings__section">
				<p className="settings__error" role="alert">
					{error}
				</p>
				<Button onClick={() => void refresh()} size={ButtonSize.Md}>
					{t("shell.settings.devices.add.tryAgain")}
				</Button>
				{pairingOverlay}
			</section>
		);
	}

	const isEmpty = records.length === 0;

	return (
		<section className="settings__section devices-section" data-testid="devices-section">
			<p className="settings__section-summary">{t("shell.settings.devices.summary")}</p>
			{!hasRelay && (
				<p className="devices-section__notice" role="status">
					{t("shell.settings.devices.noRelay")}
				</p>
			)}

			{isEmpty ? (
				<div className="devices-section__empty" data-testid="devices-section-empty">
					<h4 className="devices-section__empty-title">{t("shell.settings.devices.emptyTitle")}</h4>
					<p className="devices-section__empty-subtitle">{t("shell.settings.devices.emptySubtitle")}</p>
				</div>
			) : (
				<DevicesList records={records} thisDeviceEd25519Pub={thisDevice} onRevoke={onRevoke} />
			)}

			<div className="devices-section__actions">
				<Button
					variant={ButtonVariant.Primary}
					iconLeft={IconName.Plus}
					onClick={() => setView(DevicesViewState.Add)}
					disabled={!hasRelay}
					shortcutId="shell.devices.addDevice"
					data-testid="devices-section-add"
				>
					{t("shell.settings.devices.addDevice")}
				</Button>
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Md}
					onClick={() => setView(DevicesViewState.Join)}
					data-testid="devices-section-join"
				>
					{t("shell.settings.devices.joinVault")}
				</Button>
			</div>
			{pairingOverlay}
		</section>
	);
}
