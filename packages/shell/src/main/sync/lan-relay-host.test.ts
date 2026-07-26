/**
 * LAN-1 / LAN-2 — embedded blind relay host + roster-verified admission.
 *
 * Proves, in-process (no real socket — that binding is withheld behind the
 * security review), that:
 *   - host election is deterministic (lower device id hosts);
 *   - an OPEN host (no admit) lets clients connect + fan out frames — cloud
 *     relay parity;
 *   - a GATED host challenges every connection; a roster member with a valid
 *     nonce signature is admitted (auth-ok) and its frames fan out; a
 *     non-roster peer and a valid-roster-but-forged-signature peer are BOTH
 *     rejected (socket closed, never admitted).
 */

import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "../pairing/pairing-channel";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { encodeFrame } from "./envelope-codec";
import {
	LanRole,
	electLanRole,
	lanRosterAdmissionSet,
	makeLanAdmissionVerifier,
	makeLanChallengeResponder,
} from "./lan-admission";
import { LanRelayHost } from "./lan-relay-host";
import { type RoutingHeader, WireKind } from "./routing-header";
import { WebSocketRelayPort } from "./websocket-relay-port";

async function flush(times = 12): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

async function waitFor(pred: () => boolean, tries = 40): Promise<boolean> {
	for (let i = 0; i < tries; i++) {
		if (pred()) return true;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	return pred();
}

/** A device identity for the roster + challenge signing. */
function makeDevice() {
	const kp = ed25519.keygen();
	const account = bytesToBase64Url(new Uint8Array(kp.publicKey));
	const responder = makeLanChallengeResponder({
		deviceAccount: () => account,
		signWithDeviceKey: (msg) => new Uint8Array(ed25519.sign(msg, kp.secretKey)),
	});
	return { kp, account, responder };
}

/** Inject the test ed25519 verify (arg order differs from native). */
const testVerify = (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean =>
	ed25519.verify(sig, msg, pub);

function frameFor(entityId: string, sender: string): Uint8Array {
	const header: RoutingHeader = {
		v: 1,
		kind: WireKind.Update,
		entityId,
		sender,
		seq: 0,
		nonce: bytesToBase64Url(new Uint8Array(24)),
		ts: 1_700_000_000_000,
	};
	return encodeFrame({ header, ciphertext: new Uint8Array([1, 2, 3, 4]), sig: new Uint8Array(64) });
}

describe("electLanRole (OQ-LAN-2 lock)", () => {
	it("lower device id hosts, higher is guest — symmetric", () => {
		expect(electLanRole("aaa", "bbb")).toBe(LanRole.Host);
		expect(electLanRole("bbb", "aaa")).toBe(LanRole.Guest);
		// Both peers compute the same split from the same pair.
		expect(electLanRole("aaa", "bbb")).not.toBe(electLanRole("bbb", "aaa"));
	});

	it("rejects empty or identical ids", () => {
		expect(() => electLanRole("", "b")).toThrow();
		expect(() => electLanRole("a", "a")).toThrow();
	});
});

describe("LanRelayHost — open (no admission)", () => {
	it("clients connect and fan out frames (cloud-relay parity)", async () => {
		const host = new LanRelayHost();
		const ctor = host.webSocketCtor();
		const a = makeDevice();
		const b = makeDevice();
		const portA = new WebSocketRelayPort({ url: "lan://host", wsImpl: ctor });
		const portB = new WebSocketRelayPort({ url: "lan://host", wsImpl: ctor });
		try {
			portA.connect();
			portB.connect();
			await portA.awaitOpen();
			await portB.awaitOpen();
			const received: Uint8Array[] = [];
			portB.onFrame((f) => received.push(f));
			portA.subscribe("k1");
			portB.subscribe("k1");
			await flush();
			portA.send(frameFor("k1", a.account));
			await waitFor(() => received.length > 0);
			expect(received.length).toBe(1);
			// No admission ⇒ never "gated".
			expect(portA.gatedAdmission()).toBe(false);
			expect(b.account).not.toBe(a.account);
		} finally {
			portA.close();
			portB.close();
			host.close();
		}
	});
});

describe("LanRelayHost — roster-verified admission (LAN-2)", () => {
	it("admits a roster member with a valid nonce signature; frames fan out", async () => {
		const a = makeDevice();
		const b = makeDevice();
		const roster = new Set([a.account, b.account]);
		const admit = makeLanAdmissionVerifier({
			activeDeviceKeys: () => roster,
			verify: testVerify,
		});
		const host = new LanRelayHost({ admit });
		const ctor = host.webSocketCtor();
		const portA = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: ctor,
			onChallenge: a.responder,
		});
		const portB = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: ctor,
			onChallenge: b.responder,
		});
		try {
			portA.connect();
			portB.connect();
			expect(await waitFor(() => portA.gatedAdmission())).toBe(true);
			expect(await waitFor(() => portB.gatedAdmission())).toBe(true);
			const received: Uint8Array[] = [];
			portB.onFrame((f) => received.push(f));
			portA.subscribe("k1");
			portB.subscribe("k1");
			await flush();
			portA.send(frameFor("k1", a.account));
			expect(await waitFor(() => received.length > 0)).toBe(true);
		} finally {
			portA.close();
			portB.close();
			host.close();
		}
	});

	it("rejects a non-roster peer (never admitted, socket closed)", async () => {
		const member = makeDevice();
		const intruder = makeDevice();
		const roster = new Set([member.account]); // intruder NOT in roster
		let admitCalls = 0;
		const admit = makeLanAdmissionVerifier({
			activeDeviceKeys: () => {
				admitCalls += 1;
				return roster;
			},
			verify: testVerify,
		});
		const host = new LanRelayHost({ admit });
		const ctor = host.webSocketCtor();
		const port = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: ctor,
			onChallenge: intruder.responder,
		});
		try {
			port.connect();
			await flush(30);
			expect(port.gatedAdmission()).toBe(false);
			expect(admitCalls).toBeGreaterThan(0); // the host DID evaluate + reject
		} finally {
			port.close();
			host.close();
		}
	});

	it("rejects a roster member whose signature is forged", async () => {
		const good = makeDevice();
		const roster = new Set([good.account]);
		const admit = makeLanAdmissionVerifier({
			activeDeviceKeys: () => roster,
			verify: testVerify,
		});
		const host = new LanRelayHost({ admit });
		const ctor = host.webSocketCtor();
		// A responder that claims `good.account` but signs with a DIFFERENT key.
		const wrongKey = ed25519.keygen();
		const forged = makeLanChallengeResponder({
			deviceAccount: () => good.account,
			signWithDeviceKey: (msg) => new Uint8Array(ed25519.sign(msg, wrongKey.secretKey)),
		});
		const port = new WebSocketRelayPort({ url: "lan://host", wsImpl: ctor, onChallenge: forged });
		try {
			port.connect();
			await flush(30);
			expect(port.gatedAdmission()).toBe(false);
		} finally {
			port.close();
			host.close();
		}
	});
});

describe("lanRosterAdmissionSet — the admission principal (gate G3/G4/G8)", () => {
	const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

	it("transcodes roster base64 to the canonical base64url the wire uses", () => {
		const dev = ed25519.keygen();
		const pub = new Uint8Array(dev.publicKey);
		const set = lanRosterAdmissionSet([{ deviceEd25519Pub: b64(pub) }]);
		// The roster stores base64; the wire account is base64url. A naive
		// string-equality membership check would never match across the two.
		expect(set.has(bytesToBase64Url(pub))).toBe(true);
	});

	it("excludes revoked devices when built from listActive()", () => {
		// listActive() is what a wiring must pass; a revoked row simply isn't in it.
		const kept = new Uint8Array(ed25519.keygen().publicKey);
		const revoked = new Uint8Array(ed25519.keygen().publicKey);
		const all = [
			{ deviceEd25519Pub: b64(kept), revokedAt: undefined },
			{ deviceEd25519Pub: b64(revoked), revokedAt: 123 },
		];
		const active = all.filter((r) => r.revokedAt === undefined);
		const set = lanRosterAdmissionSet(active);
		expect(set.has(bytesToBase64Url(kept))).toBe(true);
		expect(set.has(bytesToBase64Url(revoked))).toBe(false);
	});

	it("drops malformed / wrong-length roster rows rather than admitting them", () => {
		const set = lanRosterAdmissionSet([
			{ deviceEd25519Pub: "" },
			{ deviceEd25519Pub: "not-base64-!!!" },
			{ deviceEd25519Pub: b64(new Uint8Array(16)) },
		]);
		expect(set.size).toBe(0);
	});

	it("REJECTS a non-canonical encoding of a real member key", () => {
		// base64url decoding is lenient: several strings decode to the same 32
		// bytes. Accepting a variant would admit a device that the roster's
		// string-keyed revocation checks then miss (G8), so the verifier
		// demands the canonical spelling.
		const dev = ed25519.keygen();
		const pub = new Uint8Array(dev.publicKey);
		const canonical = bytesToBase64Url(pub);
		// 32 bytes encode to 43 base64url chars: the last char carries 4
		// significant bits + 2 IGNORED ones, so flipping only its low bits gives
		// a different string that decodes to the identical key. That malleability
		// is the premise of this test, asserted rather than assumed — a naive
		// `endsWith("A") ? "B" : "A"` flip silently changes the bytes for most
		// keys and would make this pass for the wrong reason.
		const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const lastIndex = ALPHABET.indexOf(canonical[canonical.length - 1] as string);
		const variant = canonical.slice(0, -1) + (ALPHABET[lastIndex ^ 0b01] as string);
		expect(variant).not.toBe(canonical);
		expect([...base64UrlToBytes(variant)]).toEqual([...pub]);

		const admit = makeLanAdmissionVerifier({
			activeDeviceKeys: () => lanRosterAdmissionSet([{ deviceEd25519Pub: b64(pub) }]),
			verify: () => true, // isolate the encoding check from the signature check
		});
		const nonce = bytesToBase64Url(new Uint8Array(32).fill(1));
		const sig = bytesToBase64Url(new Uint8Array(64));
		expect(admit(canonical, sig, nonce)).toBe(true);
		expect(admit(variant, sig, nonce)).toBe(false);
	});
});
