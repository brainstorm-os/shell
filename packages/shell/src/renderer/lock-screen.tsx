/**
 * App-lock screen (Stage 13.8 surface, KBN-S-lock-screen).
 *
 * `<LockScreen>` is a **full-page route**, not an overlay: when the vault is
 * locked the dashboard renders *only* this (see `dashboard.tsx`), with no
 * content tree behind it — so there is nothing to reveal by deleting a DOM node
 * in the inspector. It is a focus-trapped PIN entry whose trap has no
 * `onEscape`, so the shared Escape handler swallows Escape (preventDefault + a
 * no-op top-of-stack invoke) — a lock can't be dismissed with Escape.
 *
 * `useVaultLock()` owns the lock state, mirrored from the main process via the
 * `vault:*` bridge (`lockStatus()` on mount + the `app:lock-changed` push). The
 * renderer is not the security boundary — the broker fail-closes all vault IPC
 * while locked, and a keyring hard-lock zeroes the master key. This surface
 * never reads the master key or the PIN verifier; it only relays the typed PIN
 * to `vaults.unlock(pin)` and reflects the returned `UnlockResult`:
 *   - `wrong-pin` → error + the escalating cooldown (the main-side policy hands
 *     back `cooldownMs`, so the renderer never re-derives the ladder; the gate
 *     is also enforced main-side so a stale renderer can't spam attempts).
 *   - `capped` → the brute-force cap is hit; PIN entry is replaced by the honest
 *     passphrase escape (close the vault → reopen it with the full passphrase,
 *     which performs the real keystore unwrap).
 * On success the `app:lock-changed` broadcast (locked=false) flips the hook, and
 * the dashboard unmounts this route.
 */

import { InitialFocusMode, useFocusTrap } from "@brainstorm-os/sdk/a11y";
import { useCallback, useEffect, useState } from "react";
import type { UnlockResult } from "../shared/app-lock-wire-types";
import { t } from "./i18n/t";
import { Button, ButtonVariant } from "./ui/button";
import { Icon, IconName } from "./ui/icon";
import { PinInput } from "./ui/pin-input";
import "./lock-screen.css";

/** Subscribe to the active vault's lock state. The dashboard gates its entire
 *  content tree on this so a locked vault renders only `<LockScreen>`. Returns
 *  `undefined` until the first `lockStatus()` resolves so callers can show a
 *  loader instead of flashing dashboard (or vault-picker) chrome — a vault that
 *  boots locked (a PIN is set) must never paint its content for a frame first. */
export function useVaultLock(): boolean | undefined {
	const [locked, setLocked] = useState<boolean | undefined>(undefined);
	useEffect(() => {
		// Guard a stale preload bundle (preload doesn't HMR) so a missing bridge
		// doesn't crash the dashboard — mirrors the prompt hosts. Resolve to
		// `false` (not `undefined`) so a stale preload can't trap the dashboard
		// behind the loader forever.
		const bridge = window.brainstorm.vaults;
		if (!bridge?.onLockChanged) {
			console.warn(
				"[brainstorm] Vault lock bridge not exposed by preload — restart the shell to pick up the new preload bundle.",
			);
			setLocked(false);
			return;
		}
		void bridge
			.lockStatus()
			.then((s) => setLocked(s.locked))
			.catch(() => setLocked(false));
		return bridge.onLockChanged((payload) => setLocked(payload.locked));
	}, []);
	return locked;
}

export function LockScreen() {
	const [pin, setPin] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [lastFailure, setLastFailure] = useState<Extract<UnlockResult, { ok: false }> | null>(null);
	const [cooldownRemaining, setCooldownRemaining] = useState(0);

	useEffect(() => {
		if (cooldownRemaining <= 0) return;
		const id = setInterval(() => {
			setCooldownRemaining((r) => Math.max(0, r - 1000));
		}, 1000);
		return () => clearInterval(id);
	}, [cooldownRemaining]);

	const capped = lastFailure !== null && lastFailure.reason === "capped";
	const inCooldown = cooldownRemaining > 0;

	// The lock screen is raised by a lock-state change, not a user-triggered
	// opener, and on unlock the dashboard re-renders its content fresh — there is
	// no opener element to restore focus to.
	// kbn-trap-restore-exempt
	const { containerProps } = useFocusTrap({
		enabled: true,
		initialFocus: InitialFocusMode.FirstFocusable,
	});

	// `pinValue` lets auto-submit-on-complete pass the just-completed PIN directly
	// — the `setPin` from the final digit hasn't flushed to `pin` yet when the
	// PinInput's `onComplete` fires.
	const submit = useCallback(
		async (pinValue?: string) => {
			const candidate = pinValue ?? pin;
			const bridge = window.brainstorm.vaults;
			if (!bridge || candidate.length === 0 || submitting) return;
			setSubmitting(true);
			try {
				const result = await bridge.unlock(candidate);
				setPin("");
				if (result.ok) {
					// The `app:lock-changed` broadcast flips `useVaultLock` → unmount.
					setLastFailure(null);
				} else {
					setLastFailure(result);
					setCooldownRemaining(result.cooldownMs);
				}
			} finally {
				setSubmitting(false);
			}
		},
		[pin, submitting],
	);

	const closeVault = useCallback(() => {
		void window.brainstorm.vaults.close();
	}, []);

	return (
		<div className="lock-screen" data-bs-region="lock-screen">
			<div
				className="lock-screen__card"
				{...containerProps}
				role="dialog"
				aria-modal="true"
				aria-label={t("shell.lock.title")}
			>
				<Icon name={IconName.Lock} size={32} className="lock-screen__glyph" />
				<h1 className="lock-screen__title">{t("shell.lock.title")}</h1>

				{capped ? (
					<>
						<p className="lock-screen__message" role="alert">
							{t("shell.lock.capped")}
						</p>
						<Button variant={ButtonVariant.Primary} onClick={closeVault}>
							{t("shell.lock.closeVault")}
						</Button>
					</>
				) : (
					<form
						className="lock-screen__form"
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
					>
						<p className="lock-screen__subtitle">{t("shell.lock.subtitle")}</p>
						<PinInput
							value={pin}
							onChange={setPin}
							onComplete={(v) => void submit(v)}
							disabled={inCooldown || submitting}
							autoFocus
							ariaLabel={t("shell.lock.pinLabel")}
						/>
						{lastFailure?.reason === "wrong-pin" && !inCooldown && (
							<p className="lock-screen__error" role="alert">
								{t("shell.lock.wrongPin")}
							</p>
						)}
						{inCooldown && (
							<p className="lock-screen__cooldown" role="status">
								{t("shell.lock.cooldown", { seconds: Math.ceil(cooldownRemaining / 1000) })}
							</p>
						)}
					</form>
				)}
			</div>
		</div>
	);
}
