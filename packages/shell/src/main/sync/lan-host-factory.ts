/**
 * Builds the real LAN listener — the last piece between the tested subsystem and
 * a running socket.
 *
 * **The one rule this file exists to enforce: never construct an open host.**
 * `LanRelayHost` treats an absent `handshake` as "no challenge" — cloud-relay
 * parity, intended for tests — so a wiring that forgets it, or that builds the
 * host before the session is ready, binds a socket that admits *anyone on the
 * network*. That is a silent, catastrophic default, and it is exactly the kind of
 * mistake a wiring layer makes. So this returns `null` rather than a host
 * whenever the handshake cannot be formed, and `LanHostController` treats `null`
 * as "stay off".
 *
 * Separate from `lan-sync-wiring.ts` so that module stays socket-free: this one
 * pulls in the listener (and transitively `ws`), and the pure adapter should not.
 */

import type { LanHostHandshake } from "./lan-admission";
import { LanRelayHost } from "./lan-relay-host";
import { LanRelayListener } from "./lan-relay-listener";
import {
	type LanSessionAccess,
	deviceAccountId,
	makeLanHostHandshakeForSession,
} from "./lan-sync-wiring";

/** A bound LAN listener, narrowed to what `LanHostController` drives. */
export type BuiltLanListener = {
	start(): Promise<{ url: string }>;
	stop(): Promise<void>;
};

export type LanListenerFactoryDeps = {
	access: LanSessionAccess;
	/** Candidate bind addresses in PREFERENCE order — the first reachable one
	 *  wins. Injected for tests; production passes
	 *  `rankLanInterfaces(lanInterfaces()).map((i) => i.address)`, which puts
	 *  physical adapters ahead of Docker bridges, VPN `utun`s and VM host
	 *  adapters. Taking `[0]` off an unranked OS enumeration is how a listener
	 *  silently binds an address no peer can reach (see `rankLanInterfaces`). */
	addresses: () => readonly string[];
	/** Post-listen socket errors — routed to the shell's error log. */
	onError?: (error: Error) => void;
	/** Seam for tests; production uses the real classes. */
	build?: (opts: {
		handshake: LanHostHandshake;
		hostAccount: string;
		address: string;
	}) => BuiltLanListener;
};

function defaultBuild(opts: {
	handshake: LanHostHandshake;
	hostAccount: string;
	address: string;
	onError?: (error: Error) => void;
}): BuiltLanListener {
	const host = new LanRelayHost({
		// Both are required for a CLOSED host. `handshake` absent ⇒ open host.
		handshake: opts.handshake,
		hostAccount: opts.hostAccount,
	});
	return new LanRelayListener({
		host,
		address: opts.address,
		...(opts.onError ? { onError: opts.onError } : {}),
	});
}

/**
 * Build a listener, or `null` when we must not listen.
 *
 * `null` on: no session (no device account ⇒ no handshake identity), and no
 * bindable private address. Both are "stay off", never "listen openly".
 */
export function createLanListener(deps: LanListenerFactoryDeps): BuiltLanListener | null {
	const hostAccount = deviceAccountId(deps.access.deviceEd25519Public());
	if (!hostAccount) return null;
	const address = deps.addresses()[0];
	if (!address) return null;
	const handshake = makeLanHostHandshakeForSession(deps.access);
	const build = deps.build;
	return build
		? build({ handshake, hostAccount, address })
		: defaultBuild({
				handshake,
				hostAccount,
				address,
				...(deps.onError ? { onError: deps.onError } : {}),
			});
}
