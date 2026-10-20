/**
 * `@brainstorm-os/sdk/confirm-memory` — an app's "Don't ask again" for its own
 * confirmation prompts (6.15). Backed by the app's per-device `settings`
 * namespace under the reserved `confirmSkipKey(kind)` key, which the shell's
 * Settings → Interface → "Reset confirmations" clears for every app.
 *
 * Only a REVERSIBLE `ConfirmKind` can be remembered (`canRememberConfirm` —
 * the policy lives on the kind, not the call site); `isSkipped` is always
 * false for any other kind, `remember` refuses it, and the shell's settings
 * service rejects the write too. Offer the checkbox only when `canRemember`.
 */

import {
	type ConfirmKind,
	type SettingsService,
	canRememberConfirm,
	confirmSkipKey,
} from "@brainstorm-os/sdk-types";

export type ConfirmMemory = {
	/** Whether this prompt kind may offer "Don't ask again" at all. */
	canRemember(kind: ConfirmKind): boolean;
	/** The user chose not to be asked again for this kind. */
	isSkipped(kind: ConfirmKind): Promise<boolean>;
	/** Record "Don't ask again". `false` when refused or unavailable. */
	remember(kind: ConfirmKind): Promise<boolean>;
};

export function createConfirmMemory(
	settings: Pick<SettingsService, "get" | "put"> | null | undefined,
): ConfirmMemory {
	return {
		canRemember: (kind) => canRememberConfirm(kind) && Boolean(settings),
		async isSkipped(kind) {
			if (!settings || !canRememberConfirm(kind)) return false;
			try {
				return (await settings.get<boolean>(confirmSkipKey(kind))) === true;
			} catch {
				return false;
			}
		},
		async remember(kind) {
			if (!settings || !canRememberConfirm(kind)) return false;
			try {
				await settings.put(confirmSkipKey(kind), true);
				return true;
			} catch {
				return false;
			}
		},
	};
}
