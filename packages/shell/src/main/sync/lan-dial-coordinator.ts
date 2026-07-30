/**
 * P2P-1 — the missing half of LAN sync: the thing that decides to DIAL.
 *
 * Before this, LAN sync could not be reached by a user at all. The Settings
 * toggle controlled only the host half (accept connections); the client half
 * reads `syncRelay.lan` out of `vault.json` and nothing except tests ever wrote
 * it. So a device could listen and no device would ever dial, which means
 * `0.11.0`'s claim that "two devices on the same Wi-Fi can now sync directly"
 * was not achievable through the product. This module is the producer.
 *
 * **Selection is EXCLUSIVE, and LAN wins.** One transport at a time. Running
 * LAN and the relay together, or racing them, would hand the relay exactly the
 * timing and volume metadata that LAN mode exists to avoid, and would make the
 * "no server" line in the sync surface false. A false privacy claim is a trust
 * failure, not a cosmetic one. So: a LAN target here overrides the vault's
 * relay entirely, and when there is no LAN target the relay carries sync.
 *
 * **Exclusivity is only acceptable because the fallback is fast.** While a LAN
 * attempt is in flight nothing is syncing, and the `P2P-0` prototype measured a
 * dial to a sleeping peer taking 75,010 ms to fail on the OS default. The
 * transport's connect deadline turns that into ~3 s; this module turns a failed
 * or degraded dial into an immediate fall back to the relay plus a cooldown, so
 * a stale address is tried once and then left alone.
 *
 * **Discovery is a source of address hints, never liveness.** The prototype
 * `SIGKILL`ed an advertising host and saw no goes-away event within 20 s. So a
 * candidate is a thing to try, records expire on our own clock rather than on
 * the network's word, and a failure is remembered.
 *
 * Own devices only. Every candidate that reaches here already carried a valid
 * rotating discovery tag derived from the identity's own sovereign key, so
 * "some device advertising on this LAN" and "one of my devices" are the same
 * set by construction. Multi-user peer-to-peer (`P2P-4`) shares no such secret
 * and cannot reuse this.
 */

import { LanDialMode } from "@brainstorm-os/protocol/sync-status-types";
import { isBindableAddress } from "./lan-address";
import type { LanPeerCandidate } from "./lan-discovery";

// The enum itself lives in `@brainstorm-os/protocol` so the Settings control
// and this policy share ONE declaration rather than two string tables that can
// drift.
export { LanDialMode } from "@brainstorm-os/protocol/sync-status-types";

export const DEFAULT_LAN_DIAL_MODE = LanDialMode.Off;

/** Where an address came from. Provenance, not inference: this is what lets us
 *  set `syncRelay.lan` honestly instead of guessing LAN-ness from the address,
 *  which is the F-466 regression. */
export enum LanDialSource {
	Discovery = "discovery",
	Manual = "manual",
	/** Learned from a pairing payload, which the user physically transferred.
	 *  Trusted for the same reason the payload's keys are. */
	Pairing = "pairing",
}

export type LanDialTarget = {
	url: string;
	source: LanDialSource;
	/** Display handle for the Settings list. Absent for a typed address. */
	instance?: string;
};

/** How long a failed address is left alone. Long enough that a sleeping
 *  machine is not re-dialled every few seconds, short enough that a peer that
 *  wakes up is picked up within a minute. */
export const DEFAULT_LAN_DIAL_COOLDOWN_MS = 60_000;

/** How long a discovery record is believed without being seen again. mDNS will
 *  not tell us the peer went away, so we expire on our own clock. */
export const DEFAULT_LAN_CANDIDATE_TTL_MS = 600_000;

/**
 * Transport tuning for the LAN path, all three numbers taken from the `P2P-0`
 * prototype's measurements rather than picked.
 *
 * - **3 s connect deadline.** A dial to a silent LAN address — which is exactly
 *   what a sleeping machine looks like, since it sends no RST — took 75,010 ms
 *   to fail on the OS default and 3,003 ms with this deadline. 3 s is ~13x the
 *   measured cross-machine discovery time (228 ms) and three orders of
 *   magnitude above the measured connect (3 to 5 ms), so a healthy link never
 *   sees it.
 * - **5 s heartbeat, 5 s answer deadline.** A frozen peer was never noticed by
 *   the transport at all; a 5 s heartbeat deadline noticed in 5,047 ms. The
 *   same run found the socket still usable after the peer woke, which is why a
 *   lapse degrades the port instead of closing it.
 *
 * They live here, with the dial policy, rather than in the transport: the
 * transport is shared with the cloud relay, where a hosted node on the other
 * end makes these a different question.
 */
export const LAN_CONNECT_TIMEOUT_MS = 3_000;
export const LAN_HEARTBEAT_INTERVAL_MS = 5_000;
export const LAN_HEARTBEAT_TIMEOUT_MS = 5_000;

export type LanDialCoordinatorOptions = {
	/** Fired whenever the effective target changes (including to `null`). The
	 *  wiring turns this into `ActiveRelayOrchestrator.reconfigure()`. */
	onTargetChanged: (target: LanDialTarget | null) => void;
	now?: () => number;
	cooldownMs?: number;
	candidateTtlMs?: number;
};

type StoredCandidate = {
	candidate: LanPeerCandidate;
	seenAtMs: number;
	source: LanDialSource;
};

/** Parse a persisted mode, falling back to the safe default on anything odd. */
export function parseLanDialMode(raw: unknown): LanDialMode {
	return raw === LanDialMode.Auto || raw === LanDialMode.Manual ? raw : DEFAULT_LAN_DIAL_MODE;
}

/**
 * Normalise a user-typed peer address to a `ws://` URL, or `null`.
 *
 * Accepts `host:port`, `ws://host:port`, and a bare host (default port
 * rejected — a LAN listener's port is ephemeral, so an address without one is
 * not actionable). The host must be a private IPv4 or loopback literal, the
 * same predicate the listener binds by: a hostname would mean a DNS lookup
 * driven by typed input, and a routable address would mean dialling the
 * internet from a control labelled "local network".
 */
export function parseLanPeerAddress(
	raw: string,
	opts: { allowLoopback?: boolean } = {},
): string | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.length > 64) return null;
	const withScheme = /^wss?:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	// `wss://` to a peer is meaningless: there is no certificate a LAN device
	// could present, and admission is channel-bound anyway.
	if (url.protocol !== "ws:") return null;
	if (url.pathname !== "/" && url.pathname !== "") return null;
	if (url.username || url.password || url.search || url.hash) return null;
	if (!url.port) return null;
	const port = Number(url.port);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
	const host = url.hostname;
	if (!isBindableAddress(host)) return null;
	// Loopback is a legitimate TYPED address (local testing, a second shell on
	// one machine) but never a legitimate PAIRED one: a peer device is not on
	// your loopback, and a pairing payload's slot holds the relay's address
	// whenever a relay is configured. Adopting that would put the durable node
	// on the LAN transport with the channel-bound handshake it never answers —
	// the F-466 failure mode, arrived at from provenance instead of the address.
	if (opts.allowLoopback === false && /^127\./.test(host)) return null;
	return `ws://${host}:${port}`;
}

export class LanDialCoordinator {
	readonly #options: LanDialCoordinatorOptions;
	readonly #now: () => number;
	readonly #cooldownMs: number;
	readonly #candidateTtlMs: number;
	/** Keyed by instance name so a peer that re-advertises replaces itself. */
	readonly #candidates = new Map<string, StoredCandidate>();
	/** url → the time it may be tried again. */
	readonly #cooldown = new Map<string, number>();
	#mode: LanDialMode = DEFAULT_LAN_DIAL_MODE;
	#manualUrl: string | null = null;
	#target: LanDialTarget | null = null;

	constructor(options: LanDialCoordinatorOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#cooldownMs = options.cooldownMs ?? DEFAULT_LAN_DIAL_COOLDOWN_MS;
		this.#candidateTtlMs = options.candidateTtlMs ?? DEFAULT_LAN_CANDIDATE_TTL_MS;
	}

	get mode(): LanDialMode {
		return this.#mode;
	}

	/** The live target, or `null` when the relay should carry sync. */
	target(): LanDialTarget | null {
		return this.#target;
	}

	/** Everything currently discoverable, freshest first — the Settings list. */
	knownPeers(): readonly { instance: string; urls: readonly string[]; source: LanDialSource }[] {
		const now = this.#now();
		return [...this.#candidates.values()]
			.filter((entry) => now - entry.seenAtMs <= this.#candidateTtlMs)
			.sort((a, b) => b.seenAtMs - a.seenAtMs)
			.map((entry) => ({
				instance: entry.candidate.instance,
				urls: entry.candidate.urls,
				source: entry.source,
			}));
	}

	setMode(mode: LanDialMode): void {
		const next = parseLanDialMode(mode);
		if (this.#mode === next) return;
		this.#mode = next;
		this.#reselect();
	}

	/** `null` clears it. A malformed address is a refusal, not a clear — the
	 *  caller validates first and reports the error to the user. */
	setManualUrl(url: string | null): void {
		if (this.#manualUrl === url) return;
		this.#manualUrl = url;
		// A freshly typed address is an explicit user act: forget any cooldown
		// so "try again" actually tries again.
		if (url) this.#cooldown.delete(url);
		this.#reselect();
	}

	/**
	 * A verified peer was seen. Every caller has already checked the rotating
	 * discovery tag (discovery) or holds the address from a pairing payload the
	 * user physically transferred (pairing) — this method does not re-derive
	 * trust and must never be handed an unverified advert.
	 */
	offerCandidate(candidate: LanPeerCandidate, source = LanDialSource.Discovery): void {
		if (candidate.urls.length === 0) return;
		this.#candidates.set(candidate.instance, {
			candidate,
			seenAtMs: this.#now(),
			source,
		});
		this.#reselect();
	}

	/**
	 * LAN-3 — a peer address learned from a pairing payload we just joined with.
	 *
	 * Trusted for the same reason the payload's keys are: the user physically
	 * transferred it and we opened the sealed identity inside it. That is a
	 * stronger warrant than a discovery advert, so it needs no tag — but it is
	 * still provenance rather than address inference, and the caller has already
	 * put it through `parseLanPeerAddress`.
	 *
	 * Stored under a stable synthetic instance so a re-pair replaces it rather
	 * than accumulating.
	 */
	offerPairedPeer(url: string): void {
		this.offerCandidate(
			{
				instance: `paired:${url}`,
				addresses: [new URL(url).hostname],
				port: Number(new URL(url).port),
				urls: [url],
			},
			LanDialSource.Pairing,
		);
	}

	/** The dial reached an admitted, live connection. */
	noteDialOpen(url: string): void {
		this.#cooldown.delete(url);
	}

	/**
	 * The dial failed, or an established link went quiet past its heartbeat
	 * grace. Both mean the same thing to selection: stop claiming this peer,
	 * fall back now, and leave the address alone for a while. Degrading rather
	 * than closing is the transport's job; picking a different path is ours.
	 */
	noteDialUnusable(url: string): void {
		this.#cooldown.set(url, this.#now() + this.#cooldownMs);
		this.#reselect();
	}

	/** Drop everything learned from the network. Called on vault close: the
	 *  next identity must not inherit the previous one's peers. */
	reset(): void {
		this.#candidates.clear();
		this.#cooldown.clear();
		this.#reselect();
	}

	#reselect(): void {
		const next = this.#select();
		const changed =
			(next?.url ?? null) !== (this.#target?.url ?? null) ||
			(next?.source ?? null) !== (this.#target?.source ?? null);
		if (!changed) return;
		// Commit BEFORE notifying: a consumer that throws must not leave the
		// coordinator believing it is on a target it never announced, which
		// would wedge selection until the next reset.
		this.#target = next;
		try {
			this.#options.onTargetChanged(next);
		} catch {
			// The consumer's problem. Selection has already moved.
		}
	}

	#select(): LanDialTarget | null {
		if (this.#mode === LanDialMode.Off) return null;
		const now = this.#now();

		if (this.#mode === LanDialMode.Manual) {
			const url = this.#manualUrl;
			if (!url || this.#isCoolingDown(url, now)) return null;
			return { url, source: LanDialSource.Manual };
		}

		// Auto. Prefer the address we are already on, so a healthy link is not
		// swapped out just because a fresher advert arrived.
		const current = this.#target;
		if (current && !this.#isCoolingDown(current.url, now) && this.#stillKnown(current.url, now)) {
			return current;
		}
		let best: StoredCandidate | null = null;
		for (const entry of this.#candidates.values()) {
			if (now - entry.seenAtMs > this.#candidateTtlMs) continue;
			if (entry.candidate.urls.every((url) => this.#isCoolingDown(url, now))) continue;
			if (!best || entry.seenAtMs > best.seenAtMs) best = entry;
		}
		if (!best) return null;
		const url = best.candidate.urls.find((u) => !this.#isCoolingDown(u, now));
		if (!url) return null;
		return { url, source: best.source, instance: best.candidate.instance };
	}

	#isCoolingDown(url: string, now: number): boolean {
		const until = this.#cooldown.get(url);
		if (until === undefined) return false;
		if (until <= now) {
			this.#cooldown.delete(url);
			return false;
		}
		return true;
	}

	#stillKnown(url: string, now: number): boolean {
		if (this.#mode !== LanDialMode.Auto) return false;
		for (const entry of this.#candidates.values()) {
			if (now - entry.seenAtMs > this.#candidateTtlMs) continue;
			if (entry.candidate.urls.includes(url)) return true;
		}
		return false;
	}
}
