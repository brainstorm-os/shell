/**
 * OpenRes-1c explainer — pure mapper from `IntentDispatchResult` (the
 * data stamped by `IntentsBus` per doc 57 + `OpenRes-1c slice 3`) to a
 * human-readable toast spec. Renderer-side consumers (dashboard pin
 * open, launcher entity open, future "Open with…" surface) pipe their
 * dispatch result through this and push the returned spec — answering
 * "why did this open *here*?" without re-running the resolver.
 *
 * Pure / side-effect-free / no React deps. The toast push happens at
 * the call site; this module is unit-tested in isolation so the rung
 * × refusal × handler shape coverage is pinned.
 *
 * Returns `null` for the legacy case where neither `rung` nor
 * `refusal` is set (e.g. a plain `handled-true` from a non-external-
 * open verb, or a pre-slice-3 path that hasn't been migrated). Caller
 * treats `null` as "skip the explainer" — the existing fail-path UI
 * (the dashboard's no-handler toast etc.) still runs.
 */

import { OpenRefusal, OpenRung } from "@brainstorm-os/sdk-types";
import type { IntentDispatchResult } from "../../preload";
import { ToastKind } from "../ui/toasts";

/** Toast spec the call site pushes via `pushToast`. `titleKey` /
 *  `bodyKey` are i18n ids resolved by `t()` at the call site (the
 *  mapper stays pure, so it never reads i18n state). `params` carries
 *  interpolation values (the resolved app label, the system-default
 *  label, the refusal-message detail). */
export type OpenExplainer = {
	readonly kind: ToastKind;
	readonly titleKey: string;
	readonly bodyKey?: string;
	readonly params?: Readonly<Record<string, string>>;
};

export type ExplainerInputs = {
	/** Looks up an installed app's display name; the mapper falls back
	 *  to the app id when the resolver returns null/undefined. Kept as
	 *  an injection so the mapper can stay pure + the resolver can be
	 *  fed by either the dashboard snapshot or a unit-test stub. */
	readonly resolveAppLabel?: (appId: string) => string | null | undefined;
	/** The original verb the caller dispatched. The mapper only narrows
	 *  on the result's rung; the verb is opaque to it. */
	readonly verb?: string;
};

/** Map a dispatch result to an explainer spec, or `null` when there's
 *  nothing useful to surface (no rung stamped — pre-OpenRes-1c paths,
 *  non-external-open verbs).
 *
 *  Success cases (`handled: true`):
 *    - `InVaultOpeners` → "Opened in <App>"
 *    - `StoredDefault`  → "Opened in <App> (your default)"
 *    - `OsHandoff`      → "Opened with the system default"
 *    - any other rung   → falls back to a generic "Opened" (defensive).
 *
 *  Refusal cases (`handled: false`):
 *    - `Refused` + `DangerousScheme` → "Blocked: dangerous link kind"
 *    - `Refused` + `NoHandler`       → "Nothing in this vault can open this"
 *    - `Refused` + `UnknownTarget`   → "Couldn't figure out what this points to"
 *    - any other handled-false       → `null` (call site keeps its
 *      existing failure UI — the `no-handler` toast is one example). */
export function formatOpenExplainer(
	result: IntentDispatchResult,
	inputs: ExplainerInputs = {},
): OpenExplainer | null {
	return result.handled ? explainHandled(result, inputs) : explainRefused(result);
}

function explainHandled(
	result: Extract<IntentDispatchResult, { handled: true }>,
	inputs: ExplainerInputs,
): OpenExplainer | null {
	switch (result.rung) {
		case OpenRung.InVaultOpeners:
			return {
				kind: ToastKind.Success,
				titleKey: "shell.openExplainer.inVaultOpeners.title",
				params: { app: appLabel(result.handler.appId, inputs) },
			};
		case OpenRung.StoredDefault:
			return {
				kind: ToastKind.Success,
				titleKey: "shell.openExplainer.storedDefault.title",
				params: { app: appLabel(result.handler.appId, inputs) },
			};
		case OpenRung.OsHandoff:
			return {
				kind: ToastKind.Info,
				titleKey: "shell.openExplainer.osHandoff.title",
			};
		case OpenRung.InternalResolver:
		case OpenRung.UniversalEditor:
			return {
				kind: ToastKind.Success,
				titleKey: "shell.openExplainer.handled.title",
				params: { app: appLabel(result.handler.appId, inputs) },
			};
		case OpenRung.Refused:
			// `Refused` ∧ `handled: true` is structurally impossible per the
			// bus contract; surface nothing rather than a contradictory
			// "Opened in Refused" toast.
			return null;
		case undefined:
			return null;
		default:
			return null;
	}
}

function explainRefused(
	result: Extract<IntentDispatchResult, { handled: false }>,
): OpenExplainer | null {
	if (result.rung !== OpenRung.Refused) {
		// Non-refusal failures (`no-handler` without the Refused rung,
		// `cancelled`, `handler-error`) keep their existing call-site UI.
		return null;
	}
	switch (result.refusal) {
		case OpenRefusal.DangerousScheme:
			return {
				kind: ToastKind.Warning,
				titleKey: "shell.openExplainer.refused.dangerousScheme.title",
				bodyKey: "shell.openExplainer.refused.dangerousScheme.body",
			};
		case OpenRefusal.NoHandler:
			return {
				kind: ToastKind.Error,
				titleKey: "shell.openExplainer.refused.noHandler.title",
				bodyKey: "shell.openExplainer.refused.noHandler.body",
			};
		case OpenRefusal.UnknownTarget:
			return {
				kind: ToastKind.Error,
				titleKey: "shell.openExplainer.refused.unknownTarget.title",
				bodyKey: "shell.openExplainer.refused.unknownTarget.body",
			};
		case undefined:
			// Refused-without-refusal-reason would be a bus bug. Stay quiet
			// rather than surface a "refused for null reason" message.
			return null;
		default:
			return null;
	}
}

function appLabel(appId: string, inputs: ExplainerInputs): string {
	const resolved = inputs.resolveAppLabel?.(appId);
	return resolved && resolved.length > 0 ? resolved : appId;
}
