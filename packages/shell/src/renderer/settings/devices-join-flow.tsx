/**
 * `<DevicesJoinFlow>` — target-side pairing flow (10.5b).
 *
 * Drives the TargetPairingMachine: scan QR via the platform `BarcodeDetector`
 * + camera fallback to paste mode. Camera permission is mediated by a
 * shared-Popover prompt BEFORE `getUserMedia` so users see Brainstorm UI,
 * not raw Chromium chrome.
 *
 *   1. tabbed scan/paste — scan tab shows `<video>` polling BarcodeDetector,
 *                          paste tab shows `<textarea>` with submit.
 *   2. confirm-sas        — show the 6-digit SAS, Match / Don't-match.
 *   3. joining            — spinner.
 *   4. joined             — success + "Open vault" button.
 *   5. cancelled / expired / error — message + Try again.
 *
 * For QR mode the live handshake is wired at 10.5c; at 10.5b the IPC
 * surface returns a usable `requestId` + SAS string so the UX surface
 * pins the contract. The `Open vault` action at "joined" is a stub that
 * closes the flow (the actual vault-import path lands at 10.5c).
 */

import { Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingScanPayloadResult } from "../../preload";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Icon, IconName } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import { TextArea, TextFieldSize } from "../ui/text-field";

export enum DevicesJoinTab {
	Scan = "scan",
	Paste = "paste",
}

export enum DevicesJoinState {
	Capture = "capture",
	ConfirmSas = "confirm-sas",
	Joining = "joining",
	Joined = "joined",
	Cancelled = "cancelled",
	Expired = "expired",
	Error = "error",
}

export type DevicesJoinFlowProps = {
	onClose: () => void;
	onJoined?: () => void;
	/** Drop the flow's own title header when a titled container (e.g. the
	 *  welcome `<Popover>`) already shows it, so the title isn't duplicated. */
	embedded?: boolean;
};

type Session = {
	requestId: string;
	sas: string;
	expiresAt: number;
};

export function isBarcodeDetectorAvailable(): boolean {
	return typeof globalThis !== "undefined" && "BarcodeDetector" in globalThis;
}

export function isPlausiblePairingPayload(value: string): boolean {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (trimmed.length < 40) return false;
	if (trimmed.length > 4096) return false;
	return /^[A-Za-z0-9_-]+$/.test(trimmed);
}

function formatSas(sas: string): string {
	if (sas.length !== 6) return sas;
	return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

function classifyError(error: unknown): DevicesJoinState {
	if (error instanceof Error) {
		if (error.name === "Expired") return DevicesJoinState.Expired;
	}
	return DevicesJoinState.Error;
}

export function DevicesJoinFlow({ onClose, onJoined, embedded = false }: DevicesJoinFlowProps) {
	const [state, setState] = useState<DevicesJoinState>(DevicesJoinState.Capture);
	const [tab, setTab] = useState<DevicesJoinTab>(DevicesJoinTab.Scan);
	const [session, setSession] = useState<Session | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pasteValue, setPasteValue] = useState("");
	const [pasteError, setPasteError] = useState<string | null>(null);
	const [cameraPermissionAsked, setCameraPermissionAsked] = useState(false);
	const [cameraDenied, setCameraDenied] = useState(false);

	const barcodeAvailable = isBarcodeDetectorAvailable();

	useEffect(() => {
		if (!barcodeAvailable && tab === DevicesJoinTab.Scan) {
			setTab(DevicesJoinTab.Paste);
		}
	}, [barcodeAvailable, tab]);

	const submitPayload = useCallback(async (payload: string) => {
		setError(null);
		try {
			const result: PairingScanPayloadResult = await window.brainstorm.pairing.scanPayload({
				payload,
			});
			setSession({
				requestId: result.requestId,
				sas: result.sas,
				expiresAt: result.expiresAt,
			});
			setState(DevicesJoinState.ConfirmSas);
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			setError(detail);
			setState(classifyError(e));
		}
	}, []);

	const onSubmitPaste = useCallback(() => {
		const trimmed = pasteValue.trim();
		if (!isPlausiblePairingPayload(trimmed)) {
			setPasteError(t("shell.settings.devices.join.pasteInvalid"));
			return;
		}
		setPasteError(null);
		void submitPayload(trimmed);
	}, [pasteValue, submitPayload]);

	const cancelLive = useCallback(async () => {
		if (!session) return;
		try {
			await window.brainstorm.pairing.cancelPairing({ requestId: session.requestId });
		} catch {
			// silent — cancellation is best-effort
		}
	}, [session]);

	const onMatch = useCallback(async () => {
		if (!session) return;
		setState(DevicesJoinState.Joining);
		try {
			await window.brainstorm.pairing.confirmSas({ requestId: session.requestId });
			setState(DevicesJoinState.Joined);
			onJoined?.();
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			setError(detail);
			setState(classifyError(e));
		}
	}, [session, onJoined]);

	const onDontMatch = useCallback(async () => {
		await cancelLive();
		setState(DevicesJoinState.Cancelled);
	}, [cancelLive]);

	const onCancel = useCallback(async () => {
		await cancelLive();
		onClose();
	}, [cancelLive, onClose]);

	const retry = useCallback(() => {
		setState(DevicesJoinState.Capture);
		setSession(null);
		setError(null);
		setPasteValue("");
		setPasteError(null);
	}, []);

	useShortcut("shell.devices.cancelPairing", () => {
		void onCancel();
	});
	useShortcut(
		"shell.devices.confirmMatch",
		() => {
			void onMatch();
		},
		{ enabled: state === DevicesJoinState.ConfirmSas },
	);

	return (
		<section
			className={embedded ? "devices-flow devices-flow--embedded" : "devices-flow"}
			data-testid="devices-join-flow"
			data-state={state}
		>
			{!embedded && (
				<header className="devices-flow__header">
					<h4 className="devices-flow__title">{t("shell.settings.devices.join.title")}</h4>
				</header>
			)}
			<div className="devices-flow__body">
				{state === DevicesJoinState.Capture && (
					<CaptureBody
						tab={tab}
						setTab={setTab}
						barcodeAvailable={barcodeAvailable}
						cameraPermissionAsked={cameraPermissionAsked}
						setCameraPermissionAsked={setCameraPermissionAsked}
						cameraDenied={cameraDenied}
						setCameraDenied={setCameraDenied}
						pasteValue={pasteValue}
						setPasteValue={setPasteValue}
						pasteError={pasteError}
						setPasteError={setPasteError}
						onSubmitPaste={onSubmitPaste}
						submitPayload={submitPayload}
					/>
				)}
				{state === DevicesJoinState.ConfirmSas && session && (
					<div className="devices-flow__handshake">
						<p className="devices-flow__instruction">
							{t("shell.settings.devices.join.confirmInstruction")}
						</p>
						<span className="devices-flow__sas-digits" data-testid="devices-join-sas">
							{formatSas(session.sas)}
						</span>
					</div>
				)}
				{state === DevicesJoinState.Joining && (
					<div className="devices-flow__loading">
						<Spinner />
						<p>{t("shell.settings.devices.join.joining")}</p>
					</div>
				)}
				{state === DevicesJoinState.Joined && (
					<div className="devices-flow__paired">
						<p className="devices-flow__success">{t("shell.settings.devices.join.joined")}</p>
					</div>
				)}
				{state === DevicesJoinState.Cancelled && (
					<p className="devices-flow__message">{t("shell.settings.devices.join.cancelled")}</p>
				)}
				{state === DevicesJoinState.Expired && (
					<p className="devices-flow__message">{t("shell.settings.devices.join.expired")}</p>
				)}
				{state === DevicesJoinState.Error && (
					<p className="devices-flow__message" role="alert">
						{t("shell.settings.devices.join.error", { detail: error ?? "" })}
					</p>
				)}
			</div>
			<footer className="devices-flow__footer">
				{state === DevicesJoinState.Capture && (
					<Button
						variant={ButtonVariant.Ghost}
						size={ButtonSize.Md}
						onClick={() => {
							void onCancel();
						}}
						data-testid="devices-join-cancel"
					>
						{t("shell.settings.devices.add.cancel")}
					</Button>
				)}
				{state === DevicesJoinState.ConfirmSas && (
					<>
						<Button
							variant={ButtonVariant.Ghost}
							size={ButtonSize.Md}
							onClick={() => {
								void onDontMatch();
							}}
							data-testid="devices-join-dont-match"
						>
							{t("shell.settings.devices.join.dontMatch")}
						</Button>
						<Button
							variant={ButtonVariant.Primary}
							iconLeft={IconName.CheckCircle}
							onClick={() => {
								void onMatch();
							}}
							data-testid="devices-join-match"
						>
							{t("shell.settings.devices.join.match")}
						</Button>
					</>
				)}
				{state === DevicesJoinState.Joined && (
					<Button
						variant={ButtonVariant.Primary}
						onClick={onClose}
						data-testid="devices-join-open-vault"
					>
						{t("shell.settings.devices.join.openVault")}
					</Button>
				)}
				{(state === DevicesJoinState.Cancelled ||
					state === DevicesJoinState.Expired ||
					state === DevicesJoinState.Error) && (
					<>
						<Button
							variant={ButtonVariant.Ghost}
							size={ButtonSize.Md}
							onClick={onClose}
							data-testid="devices-join-close"
						>
							{t("shell.settings.devices.add.cancel")}
						</Button>
						<Button variant={ButtonVariant.Primary} onClick={retry} data-testid="devices-join-retry">
							{t("shell.settings.devices.add.tryAgain")}
						</Button>
					</>
				)}
			</footer>
		</section>
	);
}

type CaptureBodyProps = {
	tab: DevicesJoinTab;
	setTab: (tab: DevicesJoinTab) => void;
	barcodeAvailable: boolean;
	cameraPermissionAsked: boolean;
	setCameraPermissionAsked: (asked: boolean) => void;
	cameraDenied: boolean;
	setCameraDenied: (denied: boolean) => void;
	pasteValue: string;
	setPasteValue: (value: string) => void;
	pasteError: string | null;
	setPasteError: (error: string | null) => void;
	onSubmitPaste: () => void;
	submitPayload: (payload: string) => Promise<void>;
};

function CaptureBody(props: CaptureBodyProps) {
	const {
		tab,
		setTab,
		barcodeAvailable,
		cameraPermissionAsked,
		setCameraPermissionAsked,
		cameraDenied,
		setCameraDenied,
		pasteValue,
		setPasteValue,
		pasteError,
		setPasteError,
		onSubmitPaste,
		submitPayload,
	} = props;
	// KBN: the Scan/Paste tabs are a horizontal tablist — ←/→ move + switch. The
	// Scan tab is disabled (skipped by arrow nav) when no BarcodeDetector exists.
	const joinTabs = [DevicesJoinTab.Scan, DevicesJoinTab.Paste] as const;
	const selectTab = (index: number) => {
		const next = joinTabs[index];
		if (next) setTab(next);
	};
	const { containerProps: tabsProps, getItemProps: getTabProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: joinTabs.length,
		activeIndex: tab === DevicesJoinTab.Scan ? 0 : 1,
		onActiveIndexChange: selectTab,
		onActivate: selectTab,
		role: "tablist",
		itemRole: "tab",
		...(barcodeAvailable ? {} : { disabled: new Set([0]) }),
	});
	return (
		<div className="devices-join__capture">
			<div className="devices-join__tabs" {...tabsProps}>
				<button
					type="button"
					{...getTabProps(0)}
					className={
						tab === DevicesJoinTab.Scan
							? "devices-join__tab devices-join__tab--active"
							: "devices-join__tab"
					}
					onClick={() => setTab(DevicesJoinTab.Scan)}
					disabled={!barcodeAvailable}
					data-testid="devices-join-tab-scan"
				>
					<Icon name={IconName.QrCode} size={16} />
					<span>{t("shell.settings.devices.join.scanTab")}</span>
				</button>
				<button
					type="button"
					{...getTabProps(1)}
					className={
						tab === DevicesJoinTab.Paste
							? "devices-join__tab devices-join__tab--active"
							: "devices-join__tab"
					}
					onClick={() => setTab(DevicesJoinTab.Paste)}
					data-testid="devices-join-tab-paste"
				>
					<Icon name={IconName.Camera} size={16} />
					<span>{t("shell.settings.devices.join.pasteTab")}</span>
				</button>
			</div>

			{!barcodeAvailable && (
				<p className="devices-join__note" role="status">
					{t("shell.settings.devices.join.pasteOnlyNote")}
				</p>
			)}
			{barcodeAvailable && cameraDenied && tab === DevicesJoinTab.Paste && (
				<p className="devices-join__note" role="status">
					{t("shell.settings.devices.join.cameraDeniedNote")}
				</p>
			)}

			{tab === DevicesJoinTab.Scan && barcodeAvailable && (
				<ScanPane
					cameraPermissionAsked={cameraPermissionAsked}
					setCameraPermissionAsked={setCameraPermissionAsked}
					setCameraDenied={(denied) => {
						setCameraDenied(denied);
						if (denied) setTab(DevicesJoinTab.Paste);
					}}
					submitPayload={submitPayload}
				/>
			)}
			{tab === DevicesJoinTab.Paste && (
				<form
					className="devices-join__paste"
					onSubmit={(e) => {
						e.preventDefault();
						onSubmitPaste();
					}}
				>
					<TextArea
						label={t("shell.settings.devices.join.pasteLabel")}
						size={TextFieldSize.Sm}
						placeholder={t("shell.settings.devices.join.pastePlaceholder")}
						value={pasteValue}
						onChange={(next) => {
							setPasteValue(next);
							if (pasteError !== null) setPasteError(null);
						}}
						rows={4}
						{...(pasteError ? { error: pasteError } : {})}
						data-testid="devices-join-paste-input"
					/>
					<Button
						type="submit"
						variant={ButtonVariant.Glass}
						disabled={pasteValue.trim().length === 0}
						data-testid="devices-join-paste-submit"
					>
						{t("shell.settings.devices.join.pasteSubmit")}
					</Button>
				</form>
			)}
		</div>
	);
}

type ScanPaneProps = {
	cameraPermissionAsked: boolean;
	setCameraPermissionAsked: (asked: boolean) => void;
	setCameraDenied: (denied: boolean) => void;
	submitPayload: (payload: string) => Promise<void>;
};

function ScanPane({
	cameraPermissionAsked,
	setCameraPermissionAsked,
	setCameraDenied,
	submitPayload,
}: ScanPaneProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const [granted, setGranted] = useState(false);

	const release = useCallback(() => {
		const stream = streamRef.current;
		if (!stream) return;
		for (const track of stream.getTracks()) {
			try {
				track.stop();
			} catch {
				// noop
			}
		}
		streamRef.current = null;
	}, []);

	useEffect(() => {
		return release;
	}, [release]);

	const requestAccess = useCallback(async () => {
		setCameraPermissionAsked(true);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
			streamRef.current = stream;
			if (videoRef.current) {
				videoRef.current.srcObject = stream;
				await videoRef.current.play().catch(() => {});
			}
			setGranted(true);
		} catch {
			setCameraDenied(true);
			setGranted(false);
		}
	}, [setCameraPermissionAsked, setCameraDenied]);

	useEffect(() => {
		if (!granted || !videoRef.current) return;
		let cancelled = false;
		// biome-ignore lint/suspicious/noExplicitAny: BarcodeDetector is a platform API not in TS lib.
		const BarcodeDetectorCtor = (globalThis as any).BarcodeDetector as
			| (new (init: { formats: string[] }) => {
					detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
			  })
			| undefined;
		if (!BarcodeDetectorCtor) return;
		const detector = new BarcodeDetectorCtor({ formats: ["qr_code"] });
		const tick = async () => {
			if (cancelled) return;
			try {
				const codes = await detector.detect(videoRef.current as HTMLVideoElement);
				const first = codes[0];
				if (first && typeof first.rawValue === "string" && first.rawValue.length > 0) {
					cancelled = true;
					await submitPayload(first.rawValue);
					return;
				}
			} catch {
				// noop — keep polling until cancelled
			}
			if (!cancelled) {
				window.setTimeout(tick, 200);
			}
		};
		void tick();
		return () => {
			cancelled = true;
		};
	}, [granted, submitPayload]);

	if (!cameraPermissionAsked) {
		return (
			<div className="devices-join__permission">
				<h5>{t("shell.permissions.camera.title")}</h5>
				<p>{t("shell.permissions.camera.body")}</p>
				<div className="devices-join__permission-actions">
					<Button
						variant={ButtonVariant.Ghost}
						size={ButtonSize.Md}
						onClick={() => setCameraDenied(true)}
						data-testid="devices-join-permission-deny"
					>
						{t("shell.permissions.camera.deny")}
					</Button>
					<Button
						variant={ButtonVariant.Primary}
						onClick={() => {
							void requestAccess();
						}}
						data-testid="devices-join-permission-allow"
					>
						{t("shell.permissions.camera.allow")}
					</Button>
				</div>
			</div>
		);
	}
	return (
		<div className="devices-join__scan">
			<p className="devices-join__instruction">{t("shell.settings.devices.join.scanInstruction")}</p>
			<video
				ref={videoRef}
				className="devices-join__video"
				playsInline
				muted
				data-testid="devices-join-video"
			/>
		</div>
	);
}
