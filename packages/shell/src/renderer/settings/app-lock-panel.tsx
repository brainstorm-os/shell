/**
 * Settings → Security → App lock (Stage 13.8 surface, slice 2).
 *
 * Manages the app-lock PIN through the privileged `vault:*` bridge
 * (`hasPin`/`setPin`/`clearPin`) — dashboard-only, never broker. The PIN gates
 * the lock screen; the keystore secret it's stored under is the real
 * protection (the master key is never touched here). Setting a PIN only enables
 * the feature — "Lock now" engages it via `vaults.lock()`.
 *
 * The set/change form opens in the shared `<Popover>` (typed twice as a typo
 * guard, enforcing the exact 6-digit shape the policy assumes) so the section
 * itself stays a calm status + action row; removal confirms first.
 */

import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import { AnimatePresence } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { PIN_LENGTH, PinInput } from "../ui/pin-input";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import "./app-lock-panel.css";

/** Non-zero auto-lock intervals (minutes) the picker offers; "Never" (0) is
 *  rendered separately. Mirrors `AUTO_LOCK_CHOICES` in the main-side store
 *  (kept local so the renderer doesn't import from `main/`). */
const AUTO_LOCK_MINUTE_CHOICES = [1, 5, 15, 30] as const;

export function AppLockPanel() {
	const [hasPin, setHasPin] = useState<boolean | null>(null);
	const [editing, setEditing] = useState(false);
	const [pin, setPin] = useState("");
	const [confirmPin, setConfirmPin] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [autoLock, setAutoLock] = useState(0);
	// Land popover focus on the first PIN box (the focus trap defaults to the
	// header ✕). Resolved from the field wrapper since `<PinInput>` owns its boxes.
	const firstPinBoxRef = useRef<HTMLInputElement | null>(null);

	const refresh = useCallback(async () => {
		const bridge = window.brainstorm.vaults;
		if (!bridge?.hasPin) {
			setHasPin(false);
			return;
		}
		setHasPin(await bridge.hasPin());
		if (bridge.getAutoLock) setAutoLock(await bridge.getAutoLock());
	}, []);

	const changeAutoLock = useCallback((minutes: number) => {
		setAutoLock(minutes);
		void window.brainstorm.vaults.setAutoLock?.(minutes);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const resetForm = useCallback(() => {
		setEditing(false);
		setPin("");
		setConfirmPin("");
		setError(null);
	}, []);

	const save = useCallback(async () => {
		if (busy) return;
		if (pin.length !== PIN_LENGTH) {
			setError(t("shell.settings.security.appLock.invalid"));
			return;
		}
		if (pin !== confirmPin) {
			setError(t("shell.settings.security.appLock.mismatch"));
			return;
		}
		setBusy(true);
		try {
			const ok = await window.brainstorm.vaults.setPin(pin);
			if (!ok) {
				setError(t("shell.settings.security.appLock.invalid"));
				return;
			}
			resetForm();
			await refresh();
		} finally {
			setBusy(false);
		}
	}, [busy, pin, confirmPin, refresh, resetForm]);

	const remove = useCallback(async () => {
		const confirmed = await confirm({
			title: t("shell.settings.security.appLock.removeConfirm.title"),
			body: t("shell.settings.security.appLock.removeConfirm.body"),
			confirmLabel: t("shell.settings.security.appLock.removePin"),
			confirmVariant: ConfirmVariant.Destructive,
		});
		if (!confirmed) return;
		await window.brainstorm.vaults.clearPin();
		await refresh();
	}, [refresh]);

	const lockNow = useCallback(() => {
		void window.brainstorm.vaults.lock();
	}, []);

	if (hasPin === null) {
		return <p className="settings__loading">{t("shell.common.loading")}</p>;
	}

	return (
		<div className="app-lock">
			<p className="app-lock__status">
				{hasPin
					? t("shell.settings.security.appLock.statusOn")
					: t("shell.settings.security.appLock.statusOff")}
			</p>

			<div className="app-lock__actions">
				<Button variant={ButtonVariant.Glass} size={ButtonSize.Md} onClick={() => setEditing(true)}>
					{hasPin
						? t("shell.settings.security.appLock.changePin")
						: t("shell.settings.security.appLock.setPin")}
				</Button>
				{hasPin && (
					<>
						<Button variant={ButtonVariant.Neutral} size={ButtonSize.Md} onClick={lockNow}>
							{t("shell.settings.security.appLock.lockNow")}
						</Button>
						<Button
							variant={ButtonVariant.Ghost}
							danger
							size={ButtonSize.Md}
							onClick={() => {
								void remove();
							}}
						>
							{t("shell.settings.security.appLock.removePin")}
						</Button>
					</>
				)}
			</div>

			{hasPin && (
				<div className="app-lock__autolock">
					<span className="app-lock__field-label">
						{t("shell.settings.security.appLock.autoLockLabel")}
					</span>
					<SelectMenu
						className="app-lock__select"
						value={String(autoLock)}
						ariaLabel={t("shell.settings.security.appLock.autoLockLabel")}
						options={[
							{ value: "0", label: t("shell.settings.security.appLock.autoLock.never") },
							...AUTO_LOCK_MINUTE_CHOICES.map((m) => ({
								value: String(m),
								label: t("shell.settings.security.appLock.autoLock.minutes", { count: m }),
							})),
						]}
						onChange={(next) => changeAutoLock(Number(next))}
					/>
				</div>
			)}

			<AnimatePresence>
				{editing && (
					<Popover
						title={
							hasPin
								? t("shell.settings.security.appLock.changePin")
								: t("shell.settings.security.appLock.setPin")
						}
						onClose={resetForm}
						size={PopoverSize.Small}
						bodyPadding={PopoverBodyPadding.Comfortable}
						fitContent
						initialFocusRef={firstPinBoxRef}
						testId="app-lock-pin-popover"
						footer={
							<>
								<Button variant={ButtonVariant.Neutral} size={ButtonSize.Md} onClick={resetForm}>
									{t("shell.actions.cancel")}
								</Button>
								<Button
									variant={ButtonVariant.Primary}
									size={ButtonSize.Md}
									disabled={busy}
									onClick={() => void save()}
								>
									{t("shell.actions.save")}
								</Button>
							</>
						}
					>
						<form
							className="app-lock__form"
							onSubmit={(e) => {
								e.preventDefault();
								void save();
							}}
						>
							<div
								className="app-lock__field"
								ref={(el) => {
									firstPinBoxRef.current = el?.querySelector(".pin-input__box") ?? null;
								}}
							>
								<span className="app-lock__field-label">
									{t("shell.settings.security.appLock.pinPlaceholder")}
								</span>
								<PinInput
									value={pin}
									onChange={setPin}
									ariaLabel={t("shell.settings.security.appLock.pinPlaceholder")}
								/>
							</div>
							<div className="app-lock__field">
								<span className="app-lock__field-label">
									{t("shell.settings.security.appLock.confirmPlaceholder")}
								</span>
								<PinInput
									value={confirmPin}
									onChange={setConfirmPin}
									ariaLabel={t("shell.settings.security.appLock.confirmPlaceholder")}
								/>
							</div>
							{error !== null && (
								<p className="app-lock__error" role="alert">
									{error}
								</p>
							)}
							{/* Submit on Enter from any PIN box without a visible button. */}
							<button type="submit" className="app-lock__submit-hidden" tabIndex={-1} aria-hidden="true" />
						</form>
					</Popover>
				)}
			</AnimatePresence>
		</div>
	);
}
