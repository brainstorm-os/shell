/**
 * The adapter between a live vault session and the LAN admission handshakes.
 *
 * `makeLanHostHandshake` / `makeLanClientHandshake` take small injected getters
 * so they stay unit-testable; this is the one place that maps real session state
 * onto them. It exists as its own module — rather than inline in `index.ts` —
 * because two properties are load-bearing and easy to get wrong at a call site:
 *
 *  1. **The roster is read FRESH on every access.** `activeDevices` is a getter,
 *     not a captured map, so a `revokeDevice` takes effect on the very next
 *     connection without a restart. That is the whole of the G4 revocation
 *     property at the LAN layer: a revoked device is absent from `listActive()`,
 *     so admission cannot find it and refuses. Caching the directory once —
 *     the obvious thing to write — would silently reintroduce the hole.
 *  2. **Everything is nullable.** There may be no session (locked vault, boot,
 *     between vaults), so every getter returns `null` rather than throwing, and
 *     the handshakes already treat `null` as refuse. Fail-closed by construction.
 *
 * Relay-blind by construction: this module maps keys and identities, and never
 * touches a routing frame. It is deliberately NOT named `*relay*` — the fence
 * scans that pattern for crypto imports, and this file legitimately has them.
 */

import {
	type LanClientHandshake,
	type LanHostHandshake,
	type LanRosterEntry,
	lanRosterDirectory,
	makeLanClientHandshake,
	makeLanHostHandshake,
} from "./lan-admission";

/** A rostered device record, as `DevicesStore.listActive()` returns it. */
export type ActiveDeviceRecord = {
	deviceEd25519Pub: string;
	deviceX25519Pub?: string;
};

/**
 * What the LAN handshakes need from the host process, all nullable so a missing
 * or locked session refuses rather than throws.
 */
export type LanSessionAccess = {
	/** This device's Ed25519 public key. `null` ⇒ no session. */
	deviceEd25519Public: () => Uint8Array | null;
	/** Sign with this device's Ed25519 secret. `null` ⇒ cannot prove identity. */
	signWithDeviceKey: (message: Uint8Array) => Uint8Array | null;
	/**
	 * ACTIVE roster records — must come from `listActive()`, never `list()`.
	 * Called per access so a revoke lands immediately (see the module note).
	 */
	activeDeviceRecords: () => readonly ActiveDeviceRecord[];
	/**
	 * Open a challenge sealed to this device (client side only). A verb rather
	 * than the X25519 secret — see `VaultSession.openLanSealedChallenge`.
	 */
	openSealed: (args: {
		sealed: Parameters<LanClientHandshake["onSealedChallenge"]>[1];
		hostAccount: string;
		clientAccount: string;
	}) => Uint8Array | null;
};

/** Canonical account id for a device: base64url of its Ed25519 public key. */
export function deviceAccountId(publicKey: Uint8Array | null): string | null {
	if (!publicKey || publicKey.length === 0) return null;
	return Buffer.from(publicKey).toString("base64url");
}

/** The roster directory, rebuilt from the CURRENT active records. */
export function activeRosterDirectory(
	access: Pick<LanSessionAccess, "activeDeviceRecords">,
): ReadonlyMap<string, LanRosterEntry> {
	return lanRosterDirectory(access.activeDeviceRecords());
}

/** Host side: seal challenges to rostered peers and prove our own identity. */
export function makeLanHostHandshakeForSession(access: LanSessionAccess): LanHostHandshake {
	return makeLanHostHandshake({
		hostAccount: () => deviceAccountId(access.deviceEd25519Public()),
		activeDevices: () => activeRosterDirectory(access),
		signWithDeviceKey: (message) => access.signWithDeviceKey(message),
	});
}

/** Client side: open the host's sealed challenge and verify its proof. */
export function makeLanClientHandshakeForSession(access: LanSessionAccess): LanClientHandshake {
	return makeLanClientHandshake({
		deviceAccount: () => deviceAccountId(access.deviceEd25519Public()),
		openSealed: (args) => access.openSealed(args),
		signWithDeviceKey: (message) => access.signWithDeviceKey(message),
		activeDevices: () => activeRosterDirectory(access),
	});
}
