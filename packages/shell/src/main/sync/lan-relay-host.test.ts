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
		account: () => account,
		signNonce: (nonce) => new Uint8Array(ed25519.sign(nonce, kp.secretKey)),
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
			isRosterMember: (acc) => roster.has(acc),
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
			isRosterMember: (acc) => {
				admitCalls += 1;
				return roster.has(acc);
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
			isRosterMember: (acc) => roster.has(acc),
			verify: testVerify,
		});
		const host = new LanRelayHost({ admit });
		const ctor = host.webSocketCtor();
		// A responder that claims `good.account` but signs with a DIFFERENT key.
		const wrongKey = ed25519.keygen();
		const forged = makeLanChallengeResponder({
			account: () => good.account,
			signNonce: (nonce) => new Uint8Array(ed25519.sign(nonce, wrongKey.secretKey)),
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
