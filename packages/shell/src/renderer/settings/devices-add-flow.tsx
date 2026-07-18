/**
 * `<DevicesAddFlow>` — source-side pairing flow (10.5b).
 *
 * Drives the SourcePairingMachine via the privileged `window.brainstorm.pairing`
 * bridge. Five render states:
 *
 *   1. preparing        — startAddDevice in flight; spinner copy.
 *   2. waiting          — QR + 6-digit code shown side by side; Cancel.
 *   3. handshake        — confirm-codes-match prompt + explicit "Codes match"
 *                         button (Enter chord) + Cancel.
 *   4. paired           — success + Done.
 *   5. cancelled / expired / error — message + Try again.
 *
 * 10.5c will land the live cross-device handshake; at 10.5b the SAS-mode
 * branch surfaces a disabled tile + a "coming soon" message because
 * `startAddDevice({mode: "sas"})` returns `Unavailable`. QR mode is the
 * fully-wired path.
 */

import { useCallback, useEffect, useState } from "react";
import type { PairingStartAddDeviceResult } from "../../preload";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { IconName } from "../ui/icon";
import { QrCode } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";

export enum DevicesAddState {
	Preparing = "preparing",
	Waiting = "waiting",
	Handshake = "handshake",
	Paired = "paired",
	Cancelled = "cancelled",
	Expired = "expired",
	Error = "error",
}

export type DevicesAddFlowProps = {
	onClose: () => void;
	onPaired?: () => void;
	/** Drop the flow's own title header when a titled container (e.g. the
	 *  Devices `<Popover>`) already shows it, so the title isn't duplicated. */
	embedded?: boolean;
};

type Session = {
	requestId: string;
	payload: string;
	sas: string;
	expiresAt: number;
};

function formatSas(sas: string): string {
	if (sas.length !== 6) return sas;
	return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

function classifyError(error: unknown): DevicesAddState {
	if (error instanceof Error) {
		if (error.name === "Expired") return DevicesAddState.Expired;
	}
	return DevicesAddState.Error;
}

export function DevicesAddFlow({ onClose, onPaired, embedded = false }: DevicesAddFlowProps) {
	const [state, setState] = useState<DevicesAddState>(DevicesAddState.Preparing);
	const [session, setSession] = useState<Session | null>(null);
	const [error, setError] = useState<string | null>(null);

	const start = useCallback(async () => {
		setState(DevicesAddState.Preparing);
		setError(null);
		setSession(null);
		try {
			const result: PairingStartAddDeviceResult = await window.brainstorm.pairing.startAddDevice();
			setSession({
				requestId: result.requestId,
				payload: result.payload,
				sas: result.sas,
				expiresAt: result.expiresAt,
			});
			setState(DevicesAddState.Waiting);
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			setError(detail);
			setState(classifyError(e));
		}
	}, []);

	useEffect(() => {
		void start();
	}, [start]);

	const cancelLive = useCallback(async () => {
		if (!session) return;
		try {
			await window.brainstorm.pairing.cancelPairing({ requestId: session.requestId });
		} catch {
			// silent — cancellation is best-effort on the source side
		}
	}, [session]);

	const onCancel = useCallback(async () => {
		await cancelLive();
		setState(DevicesAddState.Cancelled);
	}, [cancelLive]);

	const onMatch = useCallback(() => {
		// 10.5c wires the real cross-device "codes match" path. At 10.5b the
		// source side simulates the transition into "paired" once the user
		// asserts the match — the wire-side completion happens at the
		// target side. The visible affordance pins the UX shape for the
		// later iteration without forging a fake AddDeviceRecord.
		setState(DevicesAddState.Paired);
		onPaired?.();
	}, [onPaired]);

	useShortcut("shell.devices.cancelPairing", () => {
		if (state === DevicesAddState.Waiting || state === DevicesAddState.Handshake) {
			void onCancel();
		}
	});
	useShortcut("shell.devices.confirmMatch", onMatch, {
		enabled: state === DevicesAddState.Handshake,
	});

	const onAdvanceToHandshake = useCallback(() => {
		setState(DevicesAddState.Handshake);
	}, []);

	return (
		<section
			className={embedded ? "devices-flow devices-flow--embedded" : "devices-flow"}
			data-testid="devices-add-flow"
			data-state={state}
		>
			{!embedded && (
				<header className="devices-flow__header">
					<h4 className="devices-flow__title">{t("shell.settings.devices.add.title")}</h4>
				</header>
			)}
			<div className="devices-flow__body">
				{state === DevicesAddState.Preparing && (
					<div className="devices-flow__loading">
						<Spinner />
						<p>{t("shell.settings.devices.add.preparing")}</p>
					</div>
				)}

				{state === DevicesAddState.Waiting && session && (
					<div className="devices-flow__qr">
						<QrCode payload={session.payload} size={240} />
						<div className="devices-flow__sas">
							<span className="devices-flow__sas-digits" data-testid="devices-add-sas">
								{formatSas(session.sas)}
							</span>
						</div>
						<p className="devices-flow__instruction">
							{t("shell.settings.devices.add.scanQrInstruction", { code: formatSas(session.sas) })}
						</p>
					</div>
				)}

				{state === DevicesAddState.Handshake && session && (
					<div className="devices-flow__handshake">
						<p className="devices-flow__instruction">
							{t("shell.settings.devices.add.handshakeInstruction")}
						</p>
						<span className="devices-flow__sas-digits">{formatSas(session.sas)}</span>
					</div>
				)}

				{state === DevicesAddState.Paired && (
					<div className="devices-flow__paired">
						<p className="devices-flow__success">{t("shell.settings.devices.add.paired")}</p>
					</div>
				)}

				{state === DevicesAddState.Cancelled && (
					<p className="devices-flow__message">{t("shell.settings.devices.add.cancelled")}</p>
				)}
				{state === DevicesAddState.Expired && (
					<p className="devices-flow__message">{t("shell.settings.devices.add.expired")}</p>
				)}
				{state === DevicesAddState.Error && (
					<p className="devices-flow__message" role="alert">
						{t("shell.settings.devices.add.error", { detail: error ?? "" })}
					</p>
				)}
			</div>
			<footer className="devices-flow__footer">
				{(state === DevicesAddState.Waiting || state === DevicesAddState.Handshake) && (
					<>
						<Button
							variant={ButtonVariant.Ghost}
							size={ButtonSize.Md}
							onClick={() => {
								void onCancel();
							}}
							data-testid="devices-add-cancel"
						>
							{t("shell.settings.devices.add.cancel")}
						</Button>
						{state === DevicesAddState.Waiting && (
							<Button
								variant={ButtonVariant.Glass}
								size={ButtonSize.Md}
								onClick={onAdvanceToHandshake}
								data-testid="devices-add-advance"
							>
								{t("shell.settings.devices.add.match")}
							</Button>
						)}
						{state === DevicesAddState.Handshake && (
							<Button
								variant={ButtonVariant.Primary}
								iconLeft={IconName.CheckCircle}
								onClick={onMatch}
								data-testid="devices-add-match"
							>
								{t("shell.settings.devices.add.match")}
							</Button>
						)}
					</>
				)}
				{state === DevicesAddState.Paired && (
					<Button variant={ButtonVariant.Primary} onClick={onClose} data-testid="devices-add-done">
						{t("shell.settings.devices.add.done")}
					</Button>
				)}
				{(state === DevicesAddState.Cancelled ||
					state === DevicesAddState.Expired ||
					state === DevicesAddState.Error) && (
					<>
						<Button
							variant={ButtonVariant.Ghost}
							size={ButtonSize.Md}
							onClick={onClose}
							data-testid="devices-add-close"
						>
							{t("shell.settings.devices.add.cancel")}
						</Button>
						<Button
							variant={ButtonVariant.Primary}
							onClick={() => {
								void start();
							}}
							data-testid="devices-add-retry"
						>
							{t("shell.settings.devices.add.tryAgain")}
						</Button>
					</>
				)}
			</footer>
		</section>
	);
}
