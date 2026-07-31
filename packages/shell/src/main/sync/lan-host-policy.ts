import { LanHostMode } from "@brainstorm-os/protocol/sync-status-types";

/**
 * When should this device listen for LAN peers?
 *
 * Pure policy, in the shape of `automation-host-designation.ts`: a predicate and
 * an enum, with persistence and the actual socket living elsewhere. It is its
 * own file for one reason — this is the only place that decides whether the
 * shell opens a **listening socket**, which is the single most consequential bit
 * in the LAN feature. Smeared across `index.ts` it would be unreviewable and
 * untestable; here it is six lines and a table of cases.
 *
 * The three modes are deliberately the three real options, not a boolean:
 *
 *  - `Off` — never listen. **The default**, and the whole feature is inert until
 *    someone opts in. Chosen for the first release because this is the shell's
 *    first inbound socket in a shipped build: a user who has not asked for LAN
 *    sync should not be listening on their network, whatever the admission layer
 *    guarantees.
 *  - `WhenVaultOpen` — listen while any vault is open. What the Settings toggle
 *    turns on: simple to explain, and the peer is reachable whenever the app is.
 *  - `WhenShared` — listen only while at least one shared entity is open. The
 *    design's original T8 lifecycle: the smallest exposure window, but invisible
 *    to the user, so it lands once there is a share-aware surface to show it on.
 *
 * Having the enum now means moving from the toggle to the tighter lifecycle is a
 * default change plus a call site, not a rewrite.
 */

// The enum itself lives in `@brainstorm-os/protocol` so the Settings control
// and this predicate share ONE declaration; the reasoning for the three modes
// stays here, with the policy that reads them.
export { LanHostMode } from "@brainstorm-os/protocol/sync-status-types";

export const DEFAULT_LAN_HOST_MODE = LanHostMode.Off;

export type LanHostState = {
	mode: LanHostMode;
	/** A vault is open. No session ⇒ no roster ⇒ nothing could be admitted. */
	hasSession: boolean;
	/** At least one entity with more than one member is open. */
	hasSharedEntities: boolean;
};

/**
 * Whether the LAN listener should currently be bound.
 *
 * `hasSession` gates every mode, including `WhenVaultOpen`: without a session
 * there is no device roster, so a bound socket could admit nobody and would be
 * pure exposure for zero function.
 */
export function shouldListenOnLan(state: LanHostState): boolean {
	if (!state.hasSession) return false;
	switch (state.mode) {
		case LanHostMode.Off:
			return false;
		case LanHostMode.WhenVaultOpen:
			return true;
		case LanHostMode.WhenShared:
			return state.hasSharedEntities;
	}
}

/** Parse a persisted mode, falling back to the safe default on anything odd. */
export function parseLanHostMode(raw: unknown): LanHostMode {
	return raw === LanHostMode.WhenVaultOpen || raw === LanHostMode.WhenShared
		? raw
		: DEFAULT_LAN_HOST_MODE;
}
