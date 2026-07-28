/**
 * LAN-2b(a) — channel-bound admission (gate finding G2).
 *
 * The property under test is the one a signature CANNOT give you: that the key
 * proving membership is on the other end of *this* connection. The design's
 * prescribed "mutual challenge" fails against a relay — the attacker forwards
 * each side's nonce to the other and both sides finish "authenticated" with it
 * in the middle. Binding the challenge to an X25519 key agreement fixes that,
 * and test 1 is the relay the old design had no answer for.
 *
 * Test plan: docs/data/lan-channel-binding.md §Test plan.
 */

import { describe, expect, it } from "vitest";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { ed25519 } from "../test-support/crypto-test-helpers";
import {
	CHALLENGE_NONCE_BYTES,
	LanProofDirection,
	type LanRosterEntry,
	type SealedChallenge,
	lanProofBytes,
	makeLanClientHandshake,
	makeLanHostHandshake,
	openLanChallenge,
	sealLanChallenge,
} from "./lan-admission";
import { LanRelayHost } from "./lan-relay-host";
import { WebSocketRelayPort } from "./websocket-relay-port";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A paired device: an Ed25519 identity (the LAN principal) + the X25519
 *  keypair its roster record carries. */
function makeDevice() {
	const ed = ed25519.keygen();
	const x = generateDeviceX25519();
	return {
		account: b64url(new Uint8Array(ed.publicKey)),
		edSecret: new Uint8Array(ed.secretKey),
		edPublic: new Uint8Array(ed.publicKey),
		x25519Pub: new Uint8Array(x.publicKey),
		x25519Secret: new Uint8Array(x.secretKey),
	};
}

const NONCE = new Uint8Array(CHALLENGE_NONCE_BYTES).map((_, i) => (i * 7) % 251);

describe("channel-bound LAN admission (G2)", () => {
	it("happy path — the addressed device opens the challenge and proves itself", () => {
		const host = makeDevice();
		const client = makeDevice();

		const sealed = sealLanChallenge({
			clientX25519Pub: client.x25519Pub,
			hostAccount: host.account,
			clientAccount: client.account,
			nonce: NONCE,
		});
		const opened = openLanChallenge({
			sealed,
			deviceX25519Secret: client.x25519Secret,
			hostAccount: host.account,
			clientAccount: client.account,
		});
		expect(opened).not.toBeNull();
		expect([...(opened as Uint8Array)]).toEqual([...NONCE]);

		// …and the proof over the opened nonce verifies for the host.
		const msg = lanProofBytes(
			LanProofDirection.Client,
			host.account,
			client.account,
			opened as Uint8Array,
		);
		const sig = ed25519.sign(msg, client.edSecret);
		expect(ed25519.verify(sig, msg, client.edPublic)).toBe(true);
	});

	it("RELAY ATTACK — a man in the middle cannot complete the handshake", () => {
		// Three parties. The attacker is on the LAN, is NOT paired, and holds no
		// device secret; it can only forward bytes between the honest client and
		// the honest host (rogue advert / ARP-spoofed ws://).
		const realHost = makeDevice();
		const victim = makeDevice();
		const attacker = makeDevice(); // its own keys — not in the vault roster

		// The attacker opens a connection to the real host, claiming to be
		// itself (it must: it can only prove keys it holds).
		const forHostSideOfAttacker = sealLanChallenge({
			clientX25519Pub: attacker.x25519Pub,
			hostAccount: realHost.account,
			clientAccount: attacker.account,
			nonce: NONCE,
		});

		// It now tries to make the VICTIM answer that challenge for it — the
		// forwarding move that defeats a signature-only mutual challenge.
		// (a) Forward the ciphertext verbatim: sealed to the ATTACKER's X25519
		//     key, so the victim cannot open it.
		expect(
			openLanChallenge({
				sealed: forHostSideOfAttacker,
				deviceX25519Secret: victim.x25519Secret,
				hostAccount: realHost.account,
				clientAccount: attacker.account,
			}),
		).toBeNull();

		// (b) Re-seal to the victim instead — the attacker CAN do this (public
		//     keys are public), but it must then name the victim as the client,
		//     and it does not know the nonce it is supposed to be relaying,
		//     because it could never open the real host's ciphertext. Sealing a
		//     nonce IT chose yields a proof bound to a nonce the real host never
		//     issued, so the host rejects it.
		const attackerChosenNonce = new Uint8Array(CHALLENGE_NONCE_BYTES).fill(9);
		const reSealed = sealLanChallenge({
			clientX25519Pub: victim.x25519Pub,
			hostAccount: realHost.account,
			clientAccount: victim.account,
			nonce: attackerChosenNonce,
		});
		const victimOpened = openLanChallenge({
			sealed: reSealed,
			deviceX25519Secret: victim.x25519Secret,
			hostAccount: realHost.account,
			clientAccount: victim.account,
		});
		expect(victimOpened).not.toBeNull(); // the victim answers, unaware

		// The proof the attacker harvests is over the attacker's nonce and the
		// victim's account. On its OWN connection the host expects a proof over
		// the host's real nonce and the ATTACKER's account. Neither matches.
		const harvested = lanProofBytes(
			LanProofDirection.Client,
			realHost.account,
			victim.account,
			victimOpened as Uint8Array,
		);
		const harvestedSig = ed25519.sign(harvested, victim.edSecret);

		const whatHostWillCheck = lanProofBytes(
			LanProofDirection.Client,
			realHost.account,
			attacker.account, // the account the attacker authenticated as
			NONCE, // the nonce the real host actually issued
		);
		expect(ed25519.verify(harvestedSig, whatHostWillCheck, victim.edPublic)).toBe(false);
		// …and it is not the attacker's key either, so claiming the victim's
		// account gets it nowhere: it cannot sign for a key it doesn't hold.
		expect(ed25519.verify(harvestedSig, whatHostWillCheck, attacker.edPublic)).toBe(false);
	});

	it("wrong X25519 secret cannot open the challenge", () => {
		const host = makeDevice();
		const client = makeDevice();
		const other = makeDevice();
		const sealed = sealLanChallenge({
			clientX25519Pub: client.x25519Pub,
			hostAccount: host.account,
			clientAccount: client.account,
			nonce: NONCE,
		});
		expect(
			openLanChallenge({
				sealed,
				deviceX25519Secret: other.x25519Secret,
				hostAccount: host.account,
				clientAccount: client.account,
			}),
		).toBeNull();
	});

	it("a challenge sealed for one connection does not open on another (AAD binds both accounts)", () => {
		const host = makeDevice();
		const client = makeDevice();
		const sealed = sealLanChallenge({
			clientX25519Pub: client.x25519Pub,
			hostAccount: host.account,
			clientAccount: client.account,
			nonce: NONCE,
		});
		// Right recipient key, wrong account pair ⇒ AEAD tag mismatch.
		expect(
			openLanChallenge({
				sealed,
				deviceX25519Secret: client.x25519Secret,
				hostAccount: makeDevice().account,
				clientAccount: client.account,
			}),
		).toBeNull();
		expect(
			openLanChallenge({
				sealed,
				deviceX25519Secret: client.x25519Secret,
				hostAccount: host.account,
				clientAccount: makeDevice().account,
			}),
		).toBeNull();
	});

	it("a tampered ciphertext does not open", () => {
		const host = makeDevice();
		const client = makeDevice();
		const sealed = sealLanChallenge({
			clientX25519Pub: client.x25519Pub,
			hostAccount: host.account,
			clientAccount: client.account,
			nonce: NONCE,
		});
		const ct = Buffer.from(sealed.ct, "base64url");
		ct[0] = (ct[0] ?? 0) ^ 0xff;
		expect(
			openLanChallenge({
				sealed: { enc: sealed.enc, ct: ct.toString("base64url") },
				deviceX25519Secret: client.x25519Secret,
				hostAccount: host.account,
				clientAccount: client.account,
			}),
		).toBeNull();
	});

	it("REFLECTION — a client proof does not verify as a host proof", () => {
		// Without direction tags a rogue host could bounce the client's own
		// proof back and "prove" itself with it.
		const host = makeDevice();
		const client = makeDevice();
		const clientMsg = lanProofBytes(LanProofDirection.Client, host.account, client.account, NONCE);
		const hostMsg = lanProofBytes(LanProofDirection.Host, host.account, client.account, NONCE);
		expect([...clientMsg]).not.toEqual([...hostMsg]);

		const clientSig = ed25519.sign(clientMsg, client.edSecret);
		// The reflected proof fails as a host proof, under either key.
		expect(ed25519.verify(clientSig, hostMsg, client.edPublic)).toBe(false);
		expect(ed25519.verify(clientSig, hostMsg, host.edPublic)).toBe(false);
	});
});

describe("handshake builders (LAN-2b(b)) — host ⇄ client", () => {
	const directoryOf = (...devices: ReturnType<typeof makeDevice>[]) =>
		new Map(devices.map((d) => [d.account, { ed25519Pub: d.edPublic, x25519Pub: d.x25519Pub }]));

	function handshakePair(
		host: ReturnType<typeof makeDevice>,
		client: ReturnType<typeof makeDevice>,
		directory: ReadonlyMap<string, LanRosterEntry> = directoryOf(host, client),
	) {
		const hostSide = makeLanHostHandshake({
			hostAccount: () => host.account,
			activeDevices: () => directory,
			signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, host.edSecret)),
			verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
		});
		const clientSide = makeLanClientHandshake({
			deviceAccount: () => client.account,
			openSealed: (a) => openLanChallenge({ ...a, deviceX25519Secret: client.x25519Secret }),
			signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, client.edSecret)),
			activeDevices: () => directory,
			verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
		});
		return { hostSide, clientSide };
	}

	it("completes: seal → open → prove → verify, in both directions", () => {
		const host = makeDevice();
		const client = makeDevice();
		const { hostSide, clientSide } = handshakePair(host, client);

		const sealed = hostSide.sealFor(client.account, NONCE);
		expect(sealed).not.toBeNull();

		const auth = clientSide.onSealedChallenge(host.account, sealed as SealedChallenge);
		expect(auth).not.toBeNull();
		expect(hostSide.verifyClient(client.account, (auth as { sig: string }).sig, NONCE)).toBe(true);

		const proof = hostSide.proveToClient(client.account, NONCE);
		expect(proof).not.toBeNull();
		expect(clientSide.verifyHostProof(proof as string)).toBe(true);
	});

	it("refuses to seal for a device that is not in the roster", () => {
		const host = makeDevice();
		const client = makeDevice();
		const stranger = makeDevice();
		const { hostSide } = handshakePair(host, client);
		expect(hostSide.sealFor(stranger.account, NONCE)).toBeNull();
	});

	it("refuses to seal for a roster row with no usable X25519 key (no plaintext fallback)", () => {
		const host = makeDevice();
		const client = makeDevice();
		const directory: Map<string, LanRosterEntry> = new Map([
			[host.account, { ed25519Pub: host.edPublic, x25519Pub: host.x25519Pub }],
			[client.account, { ed25519Pub: client.edPublic }], // X25519 missing
		]);
		const { hostSide } = handshakePair(host, client, directory);
		expect(hostSide.sealFor(client.account, NONCE)).toBeNull();
	});

	it("the CLIENT refuses a challenge from a host that is not itself rostered", () => {
		// A rogue advertiser is not a paired device, whatever it claims to be.
		const host = makeDevice();
		const client = makeDevice();
		const rogue = makeDevice();
		const directory = directoryOf(host, client); // rogue absent
		const { clientSide } = handshakePair(host, client, directory);
		const rogueSide = makeLanHostHandshake({
			hostAccount: () => rogue.account,
			activeDevices: () =>
				new Map([[client.account, { ed25519Pub: client.edPublic, x25519Pub: client.x25519Pub }]]),
			signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, rogue.edSecret)),
			verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
		});
		const sealed = rogueSide.sealFor(client.account, NONCE);
		expect(sealed).not.toBeNull(); // the rogue CAN seal — public keys are public
		// …but the client refuses it: the sender is not a paired device.
		expect(clientSide.onSealedChallenge(rogue.account, sealed as SealedChallenge)).toBeNull();
	});

	it("RELAY — a forwarded challenge yields no usable proof", () => {
		const realHost = makeDevice();
		const victim = makeDevice();
		const attacker = makeDevice();
		// The attacker IS a paired device here — the strongest version of the
		// attack (a malicious-but-rostered peer trying to impersonate another).
		const directory = directoryOf(realHost, victim, attacker);
		const { hostSide } = handshakePair(realHost, attacker, directory);
		const victimSide = makeLanClientHandshake({
			deviceAccount: () => victim.account,
			openSealed: (a) => openLanChallenge({ ...a, deviceX25519Secret: victim.x25519Secret }),
			signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, victim.edSecret)),
			activeDevices: () => directory,
			verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
		});

		// The real host challenges the ATTACKER's connection.
		const forAttacker = hostSide.sealFor(attacker.account, NONCE) as SealedChallenge;
		// The attacker forwards it to the victim, hoping for a usable signature.
		expect(victimSide.onSealedChallenge(realHost.account, forAttacker)).toBeNull();

		// Even if the victim answers a re-sealed challenge, the resulting proof
		// names the VICTIM, so it does not admit the attacker's connection.
		const forVictim = hostSide.sealFor(victim.account, NONCE) as SealedChallenge;
		const victimAuth = victimSide.onSealedChallenge(realHost.account, forVictim);
		expect(victimAuth).not.toBeNull();
		expect(hostSide.verifyClient(attacker.account, (victimAuth as { sig: string }).sig, NONCE)).toBe(
			false,
		);
	});
});

describe("wired end-to-end: LanRelayHost ⇄ WebSocketRelayPort (LAN-2b(b))", () => {
	const testVerify = (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean =>
		ed25519.verify(sig, msg, pub);

	function directory(...devices: ReturnType<typeof makeDevice>[]) {
		return new Map(
			devices.map((d) => [d.account, { ed25519Pub: d.edPublic, x25519Pub: d.x25519Pub }]),
		);
	}

	function hostFor(host: ReturnType<typeof makeDevice>, dir: ReadonlyMap<string, LanRosterEntry>) {
		return new LanRelayHost({
			hostAccount: host.account,
			handshake: makeLanHostHandshake({
				hostAccount: () => host.account,
				activeDevices: () => dir,
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, host.edSecret)),
				verify: testVerify,
			}),
		});
	}

	function portFor(
		relayHost: LanRelayHost,
		client: ReturnType<typeof makeDevice>,
		dir: ReadonlyMap<string, LanRosterEntry>,
	) {
		return new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: relayHost.webSocketCtor(),
			requireAdmission: true,
			lanHandshake: makeLanClientHandshake({
				deviceAccount: () => client.account,
				openSealed: (a) => openLanChallenge({ ...a, deviceX25519Secret: client.x25519Secret }),
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, client.edSecret)),
				activeDevices: () => dir,
				verify: testVerify,
			}),
		});
	}

	async function settle(tries = 60): Promise<void> {
		for (let i = 0; i < tries; i++) await new Promise((r) => setTimeout(r, 0));
	}

	it("a rostered device completes the full hello → sealed challenge → proof → auth-ok", async () => {
		const host = makeDevice();
		const client = makeDevice();
		const dir = directory(host, client);
		const relayHost = hostFor(host, dir);
		const port = portFor(relayHost, client, dir);
		try {
			port.connect();
			await settle();
			expect(port.gatedAdmission()).toBe(true);
		} finally {
			port.close();
			relayHost.close();
		}
	});

	it("a device NOT in the roster never gets a challenge and is never admitted", async () => {
		const host = makeDevice();
		const client = makeDevice();
		const stranger = makeDevice();
		const dir = directory(host, client); // stranger absent
		const relayHost = hostFor(host, dir);
		// The stranger's own client hooks — it will say hello and get closed.
		const port = portFor(relayHost, stranger, directory(host, stranger));
		try {
			port.connect();
			await settle();
			expect(port.gatedAdmission()).toBe(false);
		} finally {
			port.close();
			relayHost.close();
		}
	});

	it("the client REFUSES a host whose auth-ok proof doesn't verify", async () => {
		// A host that is rostered but answers with someone else's signature —
		// i.e. it does not actually hold the device key it claims.
		const host = makeDevice();
		const impostor = makeDevice();
		const client = makeDevice();
		const dir = directory(host, client);
		const relayHost = new LanRelayHost({
			hostAccount: host.account,
			handshake: {
				...makeLanHostHandshake({
					hostAccount: () => host.account,
					activeDevices: () => dir,
					signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, host.edSecret)),
					verify: testVerify,
				}),
				// …but signs its own proof with the WRONG key.
				proveToClient: (clientAccount, nonce) =>
					Buffer.from(
						ed25519.sign(
							lanProofBytes(LanProofDirection.Host, host.account, clientAccount, nonce),
							impostor.edSecret,
						),
					).toString("base64url"),
			},
		});
		const port = portFor(relayHost, client, dir);
		try {
			port.connect();
			await settle();
			// The client opened the challenge and proved itself, but the host's
			// proof is not its roster key ⇒ we must NOT be admitted.
			expect(port.gatedAdmission()).toBe(false);
		} finally {
			port.close();
			relayHost.close();
		}
	});
});

describe("LAN-7 — the host triggers backfill when a peer joins a channel", () => {
	const testVerify2 = (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean =>
		ed25519.verify(sig, msg, pub);

	async function settle2(tries = 60): Promise<void> {
		for (let i = 0; i < tries; i++) await new Promise((r) => setTimeout(r, 0));
	}

	it("LAN-8 — carries the joiner's state vector to the peer asked to re-emit", async () => {
		// Without this the emitter can only send a FULL snapshot. The vector is
		// what turns backfill from "re-ship the document" into "send the gap"
		// (measured at the worker seam: 38B vs 4744B for 3 missed edits of 203).
		// The host must forward it WITHOUT decoding — it is opaque base64 here,
		// exactly like the routing key, so the relay-blind fence still holds.
		const host = makeDevice();
		const first = makeDevice();
		const second = makeDevice();
		const dir = new Map(
			[host, first, second].map((d) => [
				d.account,
				{ ed25519Pub: d.edPublic, x25519Pub: d.x25519Pub },
			]),
		);
		const relayHost = new LanRelayHost({
			hostAccount: host.account,
			handshake: makeLanHostHandshake({
				hostAccount: () => host.account,
				activeDevices: () => dir,
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, host.edSecret)),
				verify: testVerify2,
			}),
		});
		const hooks = (d: ReturnType<typeof makeDevice>) =>
			makeLanClientHandshake({
				deviceAccount: () => d.account,
				openSealed: (a) => openLanChallenge({ ...a, deviceX25519Secret: d.x25519Secret }),
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, d.edSecret)),
				activeDevices: () => dir,
				verify: testVerify2,
			});

		const seen: { key: string; sv?: string }[] = [];
		const portA = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: relayHost.webSocketCtor(),
			requireAdmission: true,
			lanHandshake: hooks(first),
			onResync: (key, sv) => seen.push(sv === undefined ? { key } : { key, sv }),
		});
		const portB = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: relayHost.webSocketCtor(),
			requireAdmission: true,
			lanHandshake: hooks(second),
		});
		try {
			portA.connect();
			await settle2();
			portA.subscribe("shared-key");
			await settle2();

			portB.connect();
			await settle2();
			// B advertises where it is: a real subscribe carrying a state vector.
			portB as unknown as { sendControlForTest?: unknown };
			portB.subscribe("shared-key", { stateVectors: { "shared-key": "U1Yx" } });
			await settle2();

			expect(seen).toEqual([{ key: "shared-key", sv: "U1Yx" }]);
		} finally {
			portA.close();
			portB.close();
			relayHost.close();
		}
	});

	it("nudges the EXISTING subscriber, not the joiner", async () => {
		const host = makeDevice();
		const first = makeDevice();
		const second = makeDevice();
		const dir = new Map(
			[host, first, second].map((d) => [
				d.account,
				{ ed25519Pub: d.edPublic, x25519Pub: d.x25519Pub },
			]),
		);
		const relayHost = new LanRelayHost({
			hostAccount: host.account,
			handshake: makeLanHostHandshake({
				hostAccount: () => host.account,
				activeDevices: () => dir,
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, host.edSecret)),
				verify: testVerify2,
			}),
		});
		const clientHooks = (d: ReturnType<typeof makeDevice>) =>
			makeLanClientHandshake({
				deviceAccount: () => d.account,
				openSealed: (a) => openLanChallenge({ ...a, deviceX25519Secret: d.x25519Secret }),
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, d.edSecret)),
				activeDevices: () => dir,
				verify: testVerify2,
			});

		const firstResyncs: string[] = [];
		const secondResyncs: string[] = [];
		const portA = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: relayHost.webSocketCtor(),
			requireAdmission: true,
			lanHandshake: clientHooks(first),
			onResync: (k) => firstResyncs.push(k),
		});
		const portB = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: relayHost.webSocketCtor(),
			requireAdmission: true,
			lanHandshake: clientHooks(second),
			onResync: (k) => secondResyncs.push(k),
		});
		try {
			portA.connect();
			await settle2();
			portA.subscribe("shared-key");
			await settle2();
			expect(firstResyncs).toEqual([]); // nobody else there yet

			portB.connect();
			await settle2();
			portB.subscribe("shared-key");
			await settle2();

			// The peer that was already on the channel is asked to re-emit…
			expect(firstResyncs).toEqual(["shared-key"]);
			// …and the joiner is not (it has nothing to offer).
			expect(secondResyncs).toEqual([]);
		} finally {
			portA.close();
			portB.close();
			relayHost.close();
		}
	});
});

describe("the X25519 secret stays inside the session (LAN-2b(a) seam)", () => {
	// `makeLanClientHandshake` takes a VERB (`openSealed`) rather than an accessor
	// for the HPKE recipient secret. The distinction matters: a leaked Ed25519
	// device secret lets an attacker sign, but a leaked X25519 recipient secret
	// lets them decrypt EVERY challenge ever sealed to that device. The session's
	// `exposeIdentityForPairing` already withholds it — it hands out
	// `deviceX25519Public` only — and this seam preserves that property.
	const rosterOf = (...devices: ReturnType<typeof makeDevice>[]) =>
		new Map<string, LanRosterEntry>(
			devices.map((d) => [d.account, { ed25519Pub: d.edPublic, x25519Pub: d.x25519Pub }]),
		);

	it("never asks for the secret — only for an envelope to be opened", () => {
		const host = makeDevice();
		const client = makeDevice();
		const roster = rosterOf(host, client);

		const seen: Array<{ hostAccount: string; clientAccount: string }> = [];
		const clientSide = makeLanClientHandshake({
			deviceAccount: () => client.account,
			// The only capability handed over: open THIS envelope. The closure holds
			// the secret; the handshake never sees it.
			openSealed: (a) => {
				seen.push({ hostAccount: a.hostAccount, clientAccount: a.clientAccount });
				return openLanChallenge({ ...a, deviceX25519Secret: client.x25519Secret });
			},
			signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, client.edSecret)),
			activeDevices: () => roster,
			verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
		});
		const hostSide = makeLanHostHandshake({
			hostAccount: () => host.account,
			activeDevices: () => roster,
			signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, host.edSecret)),
			verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
		});

		const sealed = hostSide.sealFor(client.account, NONCE);
		expect(sealed).not.toBeNull();
		const auth = clientSide.onSealedChallenge(host.account, sealed as SealedChallenge);
		expect(auth).not.toBeNull();
		// The verb receives both accounts, so the AAD binding remains the opener's
		// to enforce — moving the call site did not weaken it.
		expect(seen).toEqual([{ hostAccount: host.account, clientAccount: client.account }]);
		// And the round trip still authenticates end to end.
		expect(hostSide.verifyClient(client.account, (auth as { sig: string }).sig, NONCE)).toBe(true);
	});

	it("fails closed when the opener declines — there is no plaintext fallback", () => {
		const host = makeDevice();
		const client = makeDevice();
		const roster = rosterOf(host, client);
		const clientSide = makeLanClientHandshake({
			deviceAccount: () => client.account,
			openSealed: () => null,
			signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, client.edSecret)),
			activeDevices: () => roster,
			verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
		});
		const hostSide = makeLanHostHandshake({
			hostAccount: () => host.account,
			activeDevices: () => roster,
			signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, host.edSecret)),
			verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
		});
		const sealed = hostSide.sealFor(client.account, NONCE);
		expect(clientSide.onSealedChallenge(host.account, sealed as SealedChallenge)).toBeNull();
	});
});
