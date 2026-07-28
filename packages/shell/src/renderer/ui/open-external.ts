/**
 * Open an external URL through the intent OS-handoff chokepoint (the open
 * ladder: floor → in-vault opener → OS handoff → explained refusal) and
 * surface the refusal — doc-57's "never silent" invariant applies to the
 * dispatching surface too. A fire-and-forget dispatch reads as a dead
 * button whenever the ladder refuses (denied consent, no opener), which is
 * exactly how Help → "Report on GitHub" presented as broken.
 */

import { t } from "../i18n/t";
import { ToastKind, pushToast } from "./toasts";

export function openExternalUrl(url: string): void {
	const dispatch = window.brainstorm?.intents?.dispatch;
	if (!dispatch) return;
	void dispatch({ verb: "open", payload: { url } }).then(
		(result) => {
			if (result.handled || result.reason === "cancelled") return;
			pushToast({
				kind: ToastKind.Warning,
				title: t("shell.openExternal.refused"),
				body: result.message ?? url,
			});
		},
		() => {
			pushToast({
				kind: ToastKind.Warning,
				title: t("shell.openExternal.refused"),
				body: url,
			});
		},
	);
}
