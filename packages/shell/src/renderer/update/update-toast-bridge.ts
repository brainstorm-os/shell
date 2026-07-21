/**
 * Update toast bridge — surfaces the 13.12 auto-update lifecycle as toasts
 * so an update found by the background check (`startPeriodicChecks` in
 * shell-main) reaches the user without them ever opening Settings →
 * Updates. Available → a sticky "Update available" toast whose action
 * starts the download; Downloaded → a sticky "ready to install" toast
 * whose action relaunches into the new version. A download failure
 * surfaces as a regular error toast.
 *
 * Call `installUpdateToastBridge()` once at app boot (`main.tsx`), like
 * `installErrorBridge()`. The decision of which toast (if any) a state
 * transition produces lives in the pure `planUpdateToast` so it stays
 * unit-testable without React or the preload bridge.
 */

import { type AutoUpdateState, UpdateLifecycle } from "@brainstorm-os/protocol/update-wire-types";
import { t } from "../i18n/t";
import { ToastKind, pushToast } from "../ui/toasts";

export enum UpdateToastKind {
	/** A newer version exists — offer to download it. */
	Available = "available",
	/** The update is staged on disk — offer to restart into it. */
	Ready = "ready",
	/** A download the user started failed. */
	Failed = "failed",
}

export type UpdateToastPlan = {
	readonly kind: UpdateToastKind;
	/** Suppression key: each key toasts at most once per session, so the
	 *  4-hourly re-check doesn't re-nag about a version already announced
	 *  (and dismissed). Absent for failures, which should always surface. */
	readonly dedupeKey?: string;
	readonly version?: string;
	readonly error?: string;
};

/** Map a lifecycle transition to the toast it warrants, or null. Pure. */
export function planUpdateToast(
	previous: UpdateLifecycle | null,
	state: AutoUpdateState,
): UpdateToastPlan | null {
	if (state.lifecycle === UpdateLifecycle.Available && state.version !== undefined) {
		// Re-checks report Available again via a Checking hop; the dedupe key
		// (not the transition shape) is what keeps the toast from repeating.
		return {
			kind: UpdateToastKind.Available,
			dedupeKey: `available:${state.version}`,
			version: state.version,
		};
	}
	if (state.lifecycle === UpdateLifecycle.Downloaded && state.version !== undefined) {
		return {
			kind: UpdateToastKind.Ready,
			dedupeKey: `ready:${state.version}`,
			version: state.version,
		};
	}
	// Only a failure of an in-flight download is toast-worthy: a failed
	// *background check* (offline laptop, flaky network) must stay silent.
	if (state.lifecycle === UpdateLifecycle.Error && previous === UpdateLifecycle.Downloading) {
		return {
			kind: UpdateToastKind.Failed,
			...(state.error !== undefined ? { error: state.error } : {}),
		};
	}
	return null;
}

let installed = false;

export function installUpdateToastBridge(): void {
	if (installed) return;
	installed = true;

	const update = window.brainstorm?.update;
	if (!update) return;

	let previous: UpdateLifecycle | null = null;
	const toasted = new Set<string>();

	update.onStateChange((state) => {
		const plan = planUpdateToast(previous, state);
		previous = state.lifecycle;
		if (plan === null) return;
		if (plan.dedupeKey !== undefined) {
			if (toasted.has(plan.dedupeKey)) return;
			toasted.add(plan.dedupeKey);
		}
		switch (plan.kind) {
			case UpdateToastKind.Available:
				pushToast({
					kind: ToastKind.Info,
					sticky: true,
					title: t("shell.updates.toast.availableTitle"),
					body: t("shell.settings.updates.available", { version: plan.version ?? "" }),
					action: {
						label: t("shell.settings.updates.download"),
						onPress: () => void update.download(),
					},
				});
				return;
			case UpdateToastKind.Ready:
				pushToast({
					kind: ToastKind.Success,
					sticky: true,
					title: t("shell.settings.updates.updateReady", { version: plan.version ?? "" }),
					body: t("shell.updates.toast.readyBody"),
					action: {
						label: t("shell.settings.updates.restartInstall"),
						onPress: () => void update.installNow(),
					},
				});
				return;
			case UpdateToastKind.Failed:
				pushToast({
					kind: ToastKind.Error,
					title: t("shell.settings.updates.error", { message: plan.error ?? "" }),
				});
				return;
		}
	});
}
