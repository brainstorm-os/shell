/**
 * LAN-2 — roster-verified admission for the LAN transport (crypto-aware half).
 *
 * ⚠️ NOT SHIPPABLE FROM THIS PASS. The real LAN listener + this admission gate
 * MUST pass a dedicated `/security-review` + `/pentester` before any binding to
 * a real external network interface (see `docs/data/lan-p2p-sync.md` §4). This
 * module + `lan-relay-host.ts` are the in-process / localhost proof only; the
 * external-interface bind is deliberately withheld until that review.
 *
 * Why this file is CRYPTO-AWARE and NOT named `*relay*`: the relay-blind CI
 * fence (`tools/mcp-server/src/tools/relay-noble-import-check.ts`) matches
 * `**\/sync/**\/*relay*.ts`. The blind host (`lan-relay-host.ts`) does the
 * socket/connection plumbing and calls an INJECTED `admit(...)` callback; the
 * signature-verify + roster-membership check live HERE, outside the fence,
 * exactly as `challenge-responder.ts` sits outside it for the client side.
 *
 * The design INVERTS SYNC-4b: the cloud rule is "an open node never
 * challenges"; the LAN rule is "the host ALWAYS challenges". Proof of admission
 * = an Ed25519 signature over the host's (domain-tagged) nonce, checked against
 * the vault's signed device roster (`meta.devices`) both paired peers already
 * hold. No new key material, no new primitive — only a roster verifier.
 *
 * **The principal is the PER-DEVICE key** (`session.deviceEd25519` /
 * `signWithDeviceKey`), not the sovereign user key — security gate 2026-07-26
 * finding G3, decision note `docs/data/lan-admission-principal.md` Option A.
 * The user key is the same on every paired device, so it cannot name one device
 * and per-device revocation cannot be built on it; it is also the key that
 * signs roster records, which is what made the challenge a signing oracle (G1).
 *
 * **Channel binding (G2, LAN-2b(a)).** The bottom of this file adds the
 * HPKE-sealed challenge that makes admission relay-proof: a signature proves
 * possession of a key, not that the key is on the other end of THIS connection,
 * so the design's "mutual challenge" could not stop a relay. Sealing the nonce
 * to the peer's roster X25519 key can. Wiring it through the port + host is
 * LAN-2b(b) — until that lands the transport still uses the plaintext-nonce
 * path above.
 */

import { ed25519Verify } from "@brainstorm-os/native";
import { openBase, sealBase } from "../credentials/hpke";
import { base64UrlToBytes } from "../pairing/pairing-channel";
import type { AuthResponse } from "./websocket-relay-port";

/** OQ-LAN-2 (LOCKED) — deterministic host election by device id: the lower
 *  device id hosts the embedded blind relay; the peer connects as guest. String
 *  enum per CLAUDE.md (no raw string discriminators). */
export enum LanRole {
	Host = "host",
	Guest = "guest",
}

/**
 * OQ-LAN-2 lock — decide this device's LAN role from the two device ids.
 * Deterministic + symmetric: both peers compute the same split, so exactly one
 * hosts with no negotiation round-trip. Lower id (lexicographic on the wire
 * account string = base64url device pubkey) hosts.
 */
export function electLanRole(selfDeviceId: string, peerDeviceId: string): LanRole {
	if (!selfDeviceId || !peerDeviceId) {
		throw new Error("electLanRole: both device ids must be non-empty");
	}
	if (selfDeviceId === peerDeviceId) {
		throw new Error("electLanRole: self and peer device ids must differ");
	}
	return selfDeviceId < peerDeviceId ? LanRole.Host : LanRole.Guest;
}

/**
 * Domain-separation tag prefixed to the challenge nonce before signing.
 *
 * **Why this exists (security).** `signNonce` is `VaultSession.signPayload` —
 * the SOVEREIGN USER Ed25519 key — and that same key signs `add-device` roster
 * records over `canonicalAddDeviceBytes` (plain, unprefixed JSON). Without a
 * tag the two signature domains OVERLAP, and since the *host* chooses the
 * nonce, a rogue host (rogue advert, stale pairing address, MITM on plaintext
 * `ws://`) could send `nonce = canonicalAddDeviceBytes(<its own device>)` and
 * get back a signature that is a **valid roster record adding the attacker's
 * device to the victim's vault**. Prefixing makes a challenge signature
 * unusable as any other message: no roster record ever starts with these bytes.
 *
 * Pinned by `lan-challenge-oracle.test.ts` (which still demonstrates the raw
 * attack against the primitives, so the reason for the tag stays visible).
 */
export const CHALLENGE_DOMAIN_TAG = new TextEncoder().encode("brainstorm/lan-challenge/v1\0");

/** Exact nonce length both challengers mint (LAN host + the hosted sync node's
 *  `NONCE_BYTES`). The responders REJECT any other length: a structural guard
 *  that independently defeats the oracle above (a canonical roster record is
 *  never 32 bytes), and the only protection available on the cloud path, whose
 *  verifier is deployed separately and still checks the untagged nonce. */
export const CHALLENGE_NONCE_BYTES = 32;

/** Prefix `nonce` with the domain tag — the exact bytes the LAN responder signs
 *  and the LAN verifier checks. */
export function lanChallengeSigningBytes(nonce: Uint8Array): Uint8Array {
	const out = new Uint8Array(CHALLENGE_DOMAIN_TAG.length + nonce.length);
	out.set(CHALLENGE_DOMAIN_TAG, 0);
	out.set(nonce, CHALLENGE_DOMAIN_TAG.length);
	return out;
}

/** Placeholder token the LAN client sends in the `auth` control. LAN admission
 *  proves ROSTER MEMBERSHIP (the signed device roster), not a metered
 *  entitlement, so there is no `brainstorm-cloud` token here — the host ignores
 *  the value and verifies `account` + `sig` against the roster. Non-empty so it
 *  satisfies the existing `auth` control shape the `WebSocketRelayPort` sends. */
export const LAN_ADMISSION_TOKEN = "lan/v1";

/**
 * The set of device pubkeys currently allowed to connect, derived from the
 * signed roster — **the only supported way to build the admission verifier.**
 *
 * Three traps this exists to make unreachable (security gate 2026-07-26,
 * findings G3/G4/G8 — each was a `(account: string) => boolean` a future
 * wiring could plausibly have written wrong):
 *
 *  1. **Wrong key space (G3).** The wire `account` on the LAN path is the
 *     **per-device** `deviceEd25519Pub`, NOT the sovereign user key. The user
 *     key is identical on every paired device, so admitting on it cannot name
 *     ONE device — which makes per-device revocation unimplementable. Taking
 *     roster records directly means the caller never chooses a key space.
 *  2. **Revoked devices (G4).** Built from `listActive()`, so a revoked device
 *     is excluded by construction. A hand-written predicate over `list()`
 *     would have admitted revoked devices (`list()` includes them).
 *  3. **Encoding (G8).** Roster records store base64; the wire is base64url,
 *     and base64url decoding is lenient — ~16 distinct strings decode to the
 *     same 32-byte key. Membership therefore compares **canonical bytes**, and
 *     a non-canonical wire encoding is rejected outright rather than silently
 *     normalized (so it can never diverge from a string-keyed revocation check).
 */
export function lanRosterDirectory(
	activeRecords: readonly { deviceEd25519Pub: string; deviceX25519Pub?: string }[],
): ReadonlyMap<string, LanRosterEntry> {
	const out = new Map<string, LanRosterEntry>();
	for (const record of activeRecords) {
		try {
			const bytes = new Uint8Array(Buffer.from(record.deviceEd25519Pub, "base64"));
			if (bytes.length !== DEVICE_PUBKEY_BYTES) continue;
			const entry: LanRosterEntry = { ed25519Pub: bytes };
			if (record.deviceX25519Pub) {
				const x = new Uint8Array(Buffer.from(record.deviceX25519Pub, "base64"));
				// A row without a usable X25519 key can still be a MEMBER (the
				// Ed25519 half admits it), but it cannot be channel-bound — the
				// handshake refuses rather than falling back to a plaintext nonce.
				if (x.length === DEVICE_PUBKEY_BYTES) entry.x25519Pub = x;
			}
			out.set(canonicalBase64Url(bytes), entry);
		} catch {
			// A malformed roster row is not a member.
		}
	}
	return out;
}

/** What the LAN layer needs about one rostered device: the Ed25519 key it
 *  authenticates with, and the X25519 key the challenge is sealed to. */
export type LanRosterEntry = { ed25519Pub: Uint8Array; x25519Pub?: Uint8Array };

const DEVICE_PUBKEY_BYTES = 32;

function canonicalBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export type LanAdmissionVerifierDeps = {
	/** Devices allowed to connect, keyed by canonical base64url Ed25519 pubkey.
	 *  Build it with `lanRosterDirectory(devicesStore.listActive())` — see that
	 *  function for why this is roster-derived rather than a predicate. Read it
	 *  fresh per connection so a revoke takes effect without a restart. */
	activeDeviceKeys: () => ReadonlyMap<string, LanRosterEntry>;
	/** Ed25519 verify. Default = native `ed25519Verify(pub, msg, sig)`. Injectable
	 *  for deterministic tests. */
	verify?: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
};

/**
 * Build the host-side `admit(account, sig, nonce)` callback the blind
 * `LanRelayHost` invokes on a connecting peer's `auth` control. Returns true
 * ONLY when the account is a roster member AND the signature verifies over the
 * exact nonce bytes the host issued — otherwise false (the host closes the
 * socket). Fail-closed: any decode/verify throw ⇒ false.
 *
 * `account`, `sig`, `nonce` are all base64url strings on the wire; this decodes
 * them and checks `Ed25519.verify(pubkey=account, msg=nonceBytes, sig)`.
 */
export function makeLanAdmissionVerifier(
	deps: LanAdmissionVerifierDeps,
): (account: string, sig: string, nonce: string) => boolean {
	const verify = deps.verify ?? ((pub, msg, sig) => ed25519Verify(pub, msg, sig));
	return (account: string, sig: string, nonce: string): boolean => {
		try {
			if (!account || !sig || !nonce) return false;
			const pubkey = base64UrlToBytes(account);
			// Reject a non-canonical encoding of a member key rather than
			// normalizing it (G8): the roster's own revoke/isRevoked checks are
			// string-keyed, so silently accepting a variant spelling would admit a
			// device that every revocation check then misses.
			if (pubkey.length !== DEVICE_PUBKEY_BYTES) return false;
			if (canonicalBase64Url(pubkey) !== account) return false;
			if (!deps.activeDeviceKeys().has(account)) return false;
			const sigBytes = base64UrlToBytes(sig);
			const nonceBytes = base64UrlToBytes(nonce);
			if (sigBytes.length !== 64 || nonceBytes.length !== CHALLENGE_NONCE_BYTES) return false;
			return verify(pubkey, lanChallengeSigningBytes(nonceBytes), sigBytes);
		} catch {
			return false;
		}
	};
}

export type LanChallengeResponderDeps = {
	/** This device's **per-device** Ed25519 pubkey (`session.deviceEd25519`) as
	 *  canonical base64url, or null when there's no open session.
	 *
	 *  NOT the sovereign user key (`session.identity`): that key is identical on
	 *  every paired device, so admitting on it cannot name one device and makes
	 *  per-device revocation unimplementable (gate finding G3). It is also the
	 *  key that signs roster records, which is what made the challenge a signing
	 *  oracle (G1) — keeping it out of this path removes that class entirely. */
	deviceAccount: () => string | null;
	/** Sign with the **per-device** secret (`session.signWithDeviceKey`), or null
	 *  (no session). The secret never leaves the closure. */
	signWithDeviceKey: (message: Uint8Array) => Uint8Array | null;
};

/**
 * Build the CLIENT-side `onChallenge` the `WebSocketRelayPort` invokes when a
 * LAN host challenges. Signs the nonce bytes with the device key and returns
 * `{token: LAN_ADMISSION_TOKEN, account, sig}` (all base64url). Returns null
 * (stay unauthenticated) when there's no session — the host's auth deadline
 * then closes the socket and the reconnect path retries. Mirrors
 * `makeChallengeResponder` but roots proof in roster membership, not a token.
 */
export function makeLanChallengeResponder(
	deps: LanChallengeResponderDeps,
): (nonce: string) => Promise<AuthResponse | null> {
	return async (nonce: string): Promise<AuthResponse | null> => {
		const account = deps.deviceAccount();
		if (!account) return null;
		let nonceBytes: Uint8Array;
		try {
			nonceBytes = base64UrlToBytes(nonce);
		} catch {
			return null;
		}
		// Never sign a nonce that isn't the exact minted shape — the host picks
		// these bytes, and the signing key is the sovereign user key (see
		// CHALLENGE_DOMAIN_TAG). Length guard + domain tag are independent
		// defenses; either alone defeats the roster-forgery oracle.
		if (nonceBytes.length !== CHALLENGE_NONCE_BYTES) return null;
		const sig = deps.signWithDeviceKey(lanChallengeSigningBytes(nonceBytes));
		if (!sig) return null;
		return {
			token: LAN_ADMISSION_TOKEN,
			account,
			sig: bytesToBase64Url(sig),
		};
	};
}

/** Local base64url encode — inlined to keep this module's dependency surface
 *  small (the decode we reuse from `pairing-channel`). */
function bytesToBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

// ────────────── channel-bound admission (LAN-2b(a) — gate finding G2) ──────────────

/**
 * **The G2 fix.** A signature proves possession of a key, NOT that the key is
 * on the other end of *this* connection — so the design's prescribed "mutual
 * challenge" cannot stop a relay: the attacker forwards each side's nonce to
 * the other and both finish "authenticated" with it in the middle.
 *
 * Admission is therefore bound to an **X25519 key agreement**: the host seals
 * the challenge nonce with HPKE to the connecting device's `deviceX25519Pub`
 * (already in the roster from pairing), so only the holder of that secret can
 * answer at all. A relay holds neither device's secret — it cannot open the
 * ciphertext, and cannot re-seal the host's nonce to the victim.
 *
 * Design + full test plan: `docs/data/lan-channel-binding.md`.
 */
const LAN_HPKE_INFO = new TextEncoder().encode("brainstorm/lan-admission/v1");

/** Which side a proof is for. A proof for one direction must never verify as
 *  the other's — otherwise a rogue host reflects the client's own proof back
 *  and "proves" itself with it. */
export enum LanProofDirection {
	Client = "client",
	Host = "host",
}

const CLIENT_PROOF_TAG = new TextEncoder().encode("brainstorm/lan-admission/v1/client\0");
const HOST_PROOF_TAG = new TextEncoder().encode("brainstorm/lan-admission/v1/host\0");

export type SealedChallenge = { enc: string; ct: string };

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** AAD for the sealed challenge: both device accounts in a fixed order, so a
 *  ciphertext is bound to exactly this (host, client) pair and cannot be
 *  replayed onto a different connection. */
function challengeAad(hostAccount: string, clientAccount: string): Uint8Array {
	return new TextEncoder().encode(`${hostAccount} ${clientAccount}`);
}

/** The bytes a party signs to prove it holds the device Ed25519 key AND opened
 *  this connection's nonce. Both accounts are bound in, so the proof is useless
 *  on any other connection. */
export function lanProofBytes(
	direction: LanProofDirection,
	hostAccount: string,
	clientAccount: string,
	nonce: Uint8Array,
): Uint8Array {
	const tag = direction === LanProofDirection.Client ? CLIENT_PROOF_TAG : HOST_PROOF_TAG;
	return concatBytes(tag, challengeAad(hostAccount, clientAccount), nonce);
}

/**
 * HOST — seal `nonce` to the connecting device's X25519 public key. Only that
 * device can open it: this is what makes holding the roster's X25519 secret a
 * precondition for answering, and what a relay cannot fake.
 */
export function sealLanChallenge(args: {
	clientX25519Pub: Uint8Array;
	hostAccount: string;
	clientAccount: string;
	nonce: Uint8Array;
	seal?: (
		pkR: Uint8Array,
		info: Uint8Array,
		aad: Uint8Array,
		pt: Uint8Array,
	) => { enc: Uint8Array; ct: Uint8Array };
}): SealedChallenge {
	const seal = args.seal ?? ((pkR, info, aad, pt) => sealBase(pkR, info, aad, pt));
	const { enc, ct } = seal(
		args.clientX25519Pub,
		LAN_HPKE_INFO,
		challengeAad(args.hostAccount, args.clientAccount),
		args.nonce,
	);
	return { enc: bytesToBase64Url(enc), ct: bytesToBase64Url(ct) };
}

/**
 * CLIENT — open a sealed challenge with this device's X25519 secret. Returns
 * null on ANY failure (wrong recipient, tampered ciphertext, mismatched
 * account pair — the AAD covers all three). Fail-closed.
 */
export function openLanChallenge(args: {
	sealed: SealedChallenge;
	deviceX25519Secret: Uint8Array;
	hostAccount: string;
	clientAccount: string;
	open?: (
		enc: Uint8Array,
		skR: Uint8Array,
		info: Uint8Array,
		aad: Uint8Array,
		ct: Uint8Array,
	) => Uint8Array;
}): Uint8Array | null {
	const open = args.open ?? ((enc, skR, info, aad, ct) => openBase(enc, skR, info, aad, ct));
	try {
		const nonce = open(
			base64UrlToBytes(args.sealed.enc),
			args.deviceX25519Secret,
			LAN_HPKE_INFO,
			challengeAad(args.hostAccount, args.clientAccount),
			base64UrlToBytes(args.sealed.ct),
		);
		return nonce.length === CHALLENGE_NONCE_BYTES ? nonce : null;
	} catch {
		return null;
	}
}

// ────────── handshake builders — the seam the blind host + port wire to ──────────

/**
 * HOST side of the channel-bound handshake (LAN-2b(b)). The blind
 * `LanRelayHost` mints the nonce and holds it per connection; every crypto
 * step is one of these three calls, so the host itself stays inside the
 * relay-blind fence.
 */
export type LanHostHandshake = {
	/** Seal `nonce` for the connecting device. Null ⇒ unknown, revoked, or no
	 *  usable X25519 key ⇒ the host must close rather than fall back. */
	sealFor: (clientAccount: string, nonce: Uint8Array) => SealedChallenge | null;
	/** Verify the client's proof over the nonce this connection issued. */
	verifyClient: (clientAccount: string, sig: string, nonce: Uint8Array) => boolean;
	/** This host's own proof back to the client (anti-reflection direction tag). */
	proveToClient: (clientAccount: string, nonce: Uint8Array) => string | null;
};

export function makeLanHostHandshake(deps: {
	/** This host's device account (canonical base64url Ed25519 pubkey). */
	hostAccount: () => string | null;
	/** Roster directory — `lanRosterDirectory(devicesStore.listActive())`. */
	activeDevices: () => ReadonlyMap<string, LanRosterEntry>;
	/** Sign with this device's Ed25519 secret. */
	signWithDeviceKey: (message: Uint8Array) => Uint8Array | null;
	verify?: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
}): LanHostHandshake {
	const verify = deps.verify ?? ((pub, msg, sig) => ed25519Verify(pub, msg, sig));
	return {
		sealFor: (clientAccount, nonce) => {
			try {
				const host = deps.hostAccount();
				const entry = deps.activeDevices().get(clientAccount);
				if (!host || !entry?.x25519Pub) return null;
				return sealLanChallenge({
					clientX25519Pub: entry.x25519Pub,
					hostAccount: host,
					clientAccount,
					nonce,
				});
			} catch {
				return null;
			}
		},
		verifyClient: (clientAccount, sig, nonce) => {
			try {
				const host = deps.hostAccount();
				const entry = deps.activeDevices().get(clientAccount);
				if (!host || !entry) return false;
				const sigBytes = base64UrlToBytes(sig);
				if (sigBytes.length !== 64) return false;
				const msg = lanProofBytes(LanProofDirection.Client, host, clientAccount, nonce);
				return verify(entry.ed25519Pub, msg, sigBytes);
			} catch {
				return false;
			}
		},
		proveToClient: (clientAccount, nonce) => {
			try {
				const host = deps.hostAccount();
				if (!host) return null;
				const msg = lanProofBytes(LanProofDirection.Host, host, clientAccount, nonce);
				const sig = deps.signWithDeviceKey(msg);
				return sig ? bytesToBase64Url(sig) : null;
			} catch {
				return null;
			}
		},
	};
}

/**
 * CLIENT side. Stateful by design: the nonce recovered from the sealed
 * challenge is kept in the closure so `verifyHostProof` can check the host's
 * reply against it — which keeps the nonce out of the relay-blind port
 * entirely (the port only shuttles opaque strings).
 */
export type LanClientHandshake = {
	/** The `hello` account the port announces on connect. */
	helloAccount: () => string | null;
	/** Open a sealed challenge and return the `auth` payload, or null (refuse). */
	onSealedChallenge: (hostAccount: string, sealed: SealedChallenge) => AuthResponse | null;
	/** Verify the host's `auth-ok` proof. False ⇒ the port must close and stay
	 *  unadmitted; the peer never proved it holds the host's device key. */
	verifyHostProof: (proof: string) => boolean;
};

export function makeLanClientHandshake(deps: {
	deviceAccount: () => string | null;
	deviceX25519Secret: () => Uint8Array | null;
	signWithDeviceKey: (message: Uint8Array) => Uint8Array | null;
	activeDevices: () => ReadonlyMap<string, LanRosterEntry>;
	verify?: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
}): LanClientHandshake {
	const verify = deps.verify ?? ((pub, msg, sig) => ed25519Verify(pub, msg, sig));
	// Per-connection state from the last challenge we opened.
	let openedNonce: Uint8Array | null = null;
	let peerHost: string | null = null;

	return {
		helloAccount: () => deps.deviceAccount(),
		onSealedChallenge: (hostAccount, sealed) => {
			openedNonce = null;
			peerHost = null;
			try {
				const self = deps.deviceAccount();
				const secret = deps.deviceX25519Secret();
				if (!self || !secret) return null;
				// The host must itself be a rostered device — a peer we have never
				// paired with cannot be a host, whatever it claims.
				if (!deps.activeDevices().has(hostAccount)) return null;
				const nonce = openLanChallenge({
					sealed,
					deviceX25519Secret: secret,
					hostAccount,
					clientAccount: self,
				});
				if (!nonce) return null;
				const sig = deps.signWithDeviceKey(
					lanProofBytes(LanProofDirection.Client, hostAccount, self, nonce),
				);
				if (!sig) return null;
				openedNonce = nonce;
				peerHost = hostAccount;
				return { token: LAN_ADMISSION_TOKEN, account: self, sig: bytesToBase64Url(sig) };
			} catch {
				return null;
			}
		},
		verifyHostProof: (proof) => {
			try {
				const self = deps.deviceAccount();
				const entry = peerHost ? deps.activeDevices().get(peerHost) : null;
				if (!self || !peerHost || !entry || !openedNonce) return false;
				const sigBytes = base64UrlToBytes(proof);
				if (sigBytes.length !== 64) return false;
				const msg = lanProofBytes(LanProofDirection.Host, peerHost, self, openedNonce);
				return verify(entry.ed25519Pub, msg, sigBytes);
			} catch {
				return false;
			}
		},
	};
}
