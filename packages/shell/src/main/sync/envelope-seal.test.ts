import { describe, expect, it, vi } from "vitest";
import {
	XCHACHA_KEY_BYTES,
	XCHACHA_NONCE_BYTES,
	bytesToBase64,
	generateSymmetricKey,
} from "../credentials/crypto";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { type MemberWrapPayload, wrapDekForRecipient } from "../credentials/member-wraps";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { ED25519_SIG_BYTES, decodeFrame, encodeFrame } from "./envelope-codec";
import {
	EntityIdMismatch,
	openUpdateEnvelope,
	openWrapBootstrapEnvelope,
	sealUpdateEnvelope,
	sealWrapBootstrapEnvelope,
} from "./envelope-seal";
import { PROTOCOL_VERSION, type RoutingHeader, WireKind } from "./routing-header";

function must<T>(v: T | null | undefined, m: string): T {
	if (v == null) throw new Error(m);
	return v;
}

function makeDevice() {
	const pair = ed25519.keygen();
	const secret = new Uint8Array(pair.secretKey);
	const pub = new Uint8Array(pair.publicKey);
	const sign = (bytes: Uint8Array): Uint8Array => new Uint8Array(ed25519.sign(bytes, secret));
	const verify = (sig: Uint8Array, bytes: Uint8Array): boolean => {
		try {
			return ed25519.verify(sig, bytes, pub);
		} catch {
			return false;
		}
	};
	return { secret, pub, sign, verify };
}

function freshNonceB64(): string {
	const n = new Uint8Array(XCHACHA_NONCE_BYTES);
	crypto.getRandomValues(n);
	return bytesToBase64(n);
}

const header = (overrides: Partial<RoutingHeader> = {}): RoutingHeader => ({
	v: PROTOCOL_VERSION,
	kind: WireKind.Update,
	entityId: "ent_seal",
	sender: "sender-b64",
	seq: 0,
	nonce: freshNonceB64(),
	ts: 1700000000000,
	...overrides,
});

describe("sealUpdateEnvelope / openUpdateEnvelope", () => {
	it("seal/open round-trip with the right DEK + sig", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const payload = new TextEncoder().encode("hello yjs");
		const frame = sealUpdateEnvelope({ dek, header: header(), payload, sign: d.sign });
		const out = openUpdateEnvelope({
			frame,
			dek,
			resolvedEntityId: frame.header.entityId,
			verify: d.verify,
		});
		expect(new TextDecoder().decode(out)).toBe("hello yjs");
	});

	it("open fails with a wrong DEK (Poly1305 rejects)", () => {
		const d = makeDevice();
		const frame = sealUpdateEnvelope({
			dek: generateSymmetricKey(),
			header: header(),
			payload: new Uint8Array([1, 2, 3]),
			sign: d.sign,
		});
		expect(() =>
			openUpdateEnvelope({
				frame,
				dek: generateSymmetricKey(),
				resolvedEntityId: frame.header.entityId,
				verify: d.verify,
			}),
		).toThrow();
	});

	it("open fails if a single ciphertext byte is flipped", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const frame = sealUpdateEnvelope({
			dek,
			header: header(),
			payload: new Uint8Array([7, 7, 7]),
			sign: d.sign,
		});
		const tampered = new Uint8Array(frame.ciphertext);
		tampered[0] = must(tampered[0], "tampered[0]") ^ 0x01;
		expect(() =>
			openUpdateEnvelope({
				frame: { ...frame, ciphertext: tampered },
				dek,
				resolvedEntityId: frame.header.entityId,
				verify: d.verify,
			}),
		).toThrow();
	});

	it("open fails if header.kind is flipped via reassembled frame (AAD binding)", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const frame = sealUpdateEnvelope({
			dek,
			header: header(),
			payload: new Uint8Array([9]),
			sign: d.sign,
		});
		const tampered = { ...frame, header: { ...frame.header, kind: WireKind.Snapshot } };
		expect(() =>
			openUpdateEnvelope({
				frame: tampered,
				dek,
				resolvedEntityId: tampered.header.entityId,
				verify: d.verify,
			}),
		).toThrow(); // signature would still cover original header → mismatch
	});

	it("flipped sig fails verify BEFORE AEAD is invoked (dek is not even read)", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const frame = sealUpdateEnvelope({
			dek,
			header: header(),
			payload: new Uint8Array([1]),
			sign: d.sign,
		});
		const badSig = new Uint8Array(frame.sig);
		badSig[0] = must(badSig[0], "badSig[0]") ^ 0xff;
		const verifySpy = vi.fn(() => false);
		expect(() =>
			openUpdateEnvelope({
				frame: { ...frame, sig: badSig },
				dek,
				resolvedEntityId: frame.header.entityId,
				verify: verifySpy,
			}),
		).toThrow(/signature verification failed/);
		expect(verifySpy).toHaveBeenCalledOnce();
	});

	it("flipped sender pubkey causes verify failure", () => {
		const dek = generateSymmetricKey();
		const real = makeDevice();
		const imposter = makeDevice();
		const frame = sealUpdateEnvelope({
			dek,
			header: header(),
			payload: new Uint8Array([42]),
			sign: real.sign,
		});
		expect(() =>
			openUpdateEnvelope({
				frame,
				dek,
				resolvedEntityId: frame.header.entityId,
				verify: imposter.verify,
			}),
		).toThrow(/signature/);
	});

	it("AAD is recomputed from frame.header (caller cannot supply alternate header)", () => {
		// Reassemble the frame with a substituted header that has a different
		// `seq`. Even if the recipient passes a verify closure that accepts
		// (i.e. forgery is "free"), AEAD AAD mismatch must still reject.
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const orig = sealUpdateEnvelope({
			dek,
			header: header({ seq: 0 }),
			payload: new Uint8Array([1, 2]),
			sign: d.sign,
		});
		const swapped = { ...orig, header: { ...orig.header, seq: 99 } };
		const verifyAlways = vi.fn(() => true);
		expect(() =>
			openUpdateEnvelope({
				frame: swapped,
				dek,
				resolvedEntityId: swapped.header.entityId,
				verify: verifyAlways,
			}),
		).toThrow(); // Poly1305 fails because AAD now contains a different header
	});

	it("EntityIdMismatch is thrown BEFORE verify when routed id != resolved id", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const frame = sealUpdateEnvelope({
			dek,
			header: header({ entityId: "ent_routed" }),
			payload: new Uint8Array([1]),
			sign: d.sign,
		});
		const verifySpy = vi.fn(() => true);
		expect(() =>
			openUpdateEnvelope({
				frame,
				dek,
				resolvedEntityId: "ent_resolved",
				verify: verifySpy,
			}),
		).toThrow(EntityIdMismatch);
		expect(verifySpy).not.toHaveBeenCalled();
	});

	it("seal returning a non-64-byte signature throws Invalid before send", () => {
		const dek = generateSymmetricKey();
		expect(() =>
			sealUpdateEnvelope({
				dek,
				header: header(),
				payload: new Uint8Array([1]),
				sign: () => new Uint8Array(32),
			}),
		).toThrow(/64-byte/);
	});

	it("encode -> decode -> open path also resists ciphertext byte flips on the wire", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const frame = sealUpdateEnvelope({
			dek,
			header: header(),
			payload: new Uint8Array([5, 5, 5]),
			sign: d.sign,
		});
		const wireBytes = encodeFrame(frame);
		// Flip a byte inside the ciphertext region (skip header + 2 + sig + 4).
		const view = new DataView(wireBytes.buffer);
		const headerLen = view.getUint32(0, false);
		const ctOffset = 4 + headerLen + 2 + ED25519_SIG_BYTES + 4;
		wireBytes[ctOffset] = must(wireBytes[ctOffset], "wireBytes[ctOffset]") ^ 0x10;
		const decoded = decodeFrame(wireBytes);
		expect(() =>
			openUpdateEnvelope({
				frame: decoded,
				dek,
				resolvedEntityId: decoded.header.entityId,
				verify: d.verify,
			}),
		).toThrow();
	});

	it("wrong-size DEK is rejected on seal AND on open", () => {
		const d = makeDevice();
		expect(() =>
			sealUpdateEnvelope({
				dek: new Uint8Array(XCHACHA_KEY_BYTES - 1),
				header: header(),
				payload: new Uint8Array([1]),
				sign: d.sign,
			}),
		).toThrow(/dek must be/);
		const frame = sealUpdateEnvelope({
			dek: generateSymmetricKey(),
			header: header(),
			payload: new Uint8Array([1]),
			sign: d.sign,
		});
		expect(() =>
			openUpdateEnvelope({
				frame,
				dek: new Uint8Array(0),
				resolvedEntityId: frame.header.entityId,
				verify: d.verify,
			}),
		).toThrow(/dek must be/);
	});
});

describe("sealWrapBootstrapEnvelope / openWrapBootstrapEnvelope", () => {
	const wrapHeader = (overrides: Partial<RoutingHeader> = {}): RoutingHeader => ({
		v: PROTOCOL_VERSION,
		kind: WireKind.WrapBootstrap,
		entityId: "ent_wb",
		sender: "sender-b64",
		seq: 0,
		nonce: freshNonceB64(),
		ts: 1700000000000,
		...overrides,
	});

	function makeWrap(): {
		wrap: MemberWrapPayload;
		entityId: string;
		dek: Uint8Array;
		deviceSecret: Uint8Array;
	} {
		const dek = generateSymmetricKey();
		const device = generateDeviceX25519();
		const entityId = "ent_wb";
		const wrap = wrapDekForRecipient(dek, device.publicKey, entityId);
		return { wrap, entityId, dek, deviceSecret: device.secretKey };
	}

	it("seal/open round-trip yields the same MemberWrapPayload", () => {
		const d = makeDevice();
		const { wrap } = makeWrap();
		const frame = sealWrapBootstrapEnvelope({ header: wrapHeader(), wrap, sign: d.sign });
		const out = openWrapBootstrapEnvelope({
			frame,
			resolvedEntityId: frame.header.entityId,
			verify: d.verify,
		});
		expect(out).toEqual(wrap);
	});

	it("seal refuses a non-WrapBootstrap header kind", () => {
		const d = makeDevice();
		const { wrap } = makeWrap();
		expect(() =>
			sealWrapBootstrapEnvelope({
				header: wrapHeader({ kind: WireKind.Update }),
				wrap,
				sign: d.sign,
			}),
		).toThrow(/wrap-bootstrap/);
	});

	it("open refuses a non-WrapBootstrap header (caller cannot route an Update through this path)", () => {
		const d = makeDevice();
		const { wrap } = makeWrap();
		const frame = sealWrapBootstrapEnvelope({ header: wrapHeader(), wrap, sign: d.sign });
		const swapped = { ...frame, header: { ...frame.header, kind: WireKind.Update } };
		expect(() =>
			openWrapBootstrapEnvelope({
				frame: swapped,
				resolvedEntityId: swapped.header.entityId,
				verify: vi.fn(() => true),
			}),
		).toThrow(/wrap-bootstrap/);
	});

	it("EntityIdMismatch is thrown BEFORE verify when routed id != resolved id", () => {
		const d = makeDevice();
		const { wrap } = makeWrap();
		const frame = sealWrapBootstrapEnvelope({
			header: wrapHeader({ entityId: "ent_routed" }),
			wrap,
			sign: d.sign,
		});
		const verifySpy = vi.fn(() => true);
		expect(() =>
			openWrapBootstrapEnvelope({
				frame,
				resolvedEntityId: "ent_other",
				verify: verifySpy,
			}),
		).toThrow(EntityIdMismatch);
		expect(verifySpy).not.toHaveBeenCalled();
	});

	it("flipped sig fails verify", () => {
		const d = makeDevice();
		const { wrap } = makeWrap();
		const frame = sealWrapBootstrapEnvelope({ header: wrapHeader(), wrap, sign: d.sign });
		const badSig = new Uint8Array(frame.sig);
		const firstByte = badSig[0] ?? 0;
		badSig[0] = firstByte ^ 0xff;
		expect(() =>
			openWrapBootstrapEnvelope({
				frame: { ...frame, sig: badSig },
				resolvedEntityId: frame.header.entityId,
				verify: d.verify,
			}),
		).toThrow(/signature/);
	});

	it("flipped payload byte fails verify (sig covers payload)", () => {
		const d = makeDevice();
		const { wrap } = makeWrap();
		const frame = sealWrapBootstrapEnvelope({ header: wrapHeader(), wrap, sign: d.sign });
		const tampered = new Uint8Array(frame.ciphertext);
		const firstByte = tampered[0] ?? 0;
		tampered[0] = firstByte ^ 0x01;
		expect(() =>
			openWrapBootstrapEnvelope({
				frame: { ...frame, ciphertext: tampered },
				resolvedEntityId: frame.header.entityId,
				verify: d.verify,
			}),
		).toThrow(/signature/);
	});

	it("malformed wrap JSON rejected with Invalid", () => {
		const d = makeDevice();
		// build a frame whose payload isn't JSON; sign it so verify passes.
		const header = wrapHeader();
		const headerBytes = new TextEncoder().encode(
			JSON.stringify({
				v: header.v,
				kind: header.kind,
				entityId: header.entityId,
				sender: header.sender,
				seq: header.seq,
				nonce: header.nonce,
				ts: header.ts,
			}),
		);
		const payload = new TextEncoder().encode("not json {");
		const signed = new Uint8Array(headerBytes.length + payload.length);
		signed.set(headerBytes, 0);
		signed.set(payload, headerBytes.length);
		const sig = d.sign(signed);
		expect(() =>
			openWrapBootstrapEnvelope({
				frame: { header, ciphertext: payload, sig },
				resolvedEntityId: header.entityId,
				verify: d.verify,
			}),
		).toThrow(/malformed wrap JSON/);
	});

	it("non-wrap JSON payload rejected with Invalid (shape validator)", () => {
		const d = makeDevice();
		const header = wrapHeader();
		const headerBytes = new TextEncoder().encode(
			JSON.stringify({
				v: header.v,
				kind: header.kind,
				entityId: header.entityId,
				sender: header.sender,
				seq: header.seq,
				nonce: header.nonce,
				ts: header.ts,
			}),
		);
		const payload = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
		const signed = new Uint8Array(headerBytes.length + payload.length);
		signed.set(headerBytes, 0);
		signed.set(payload, headerBytes.length);
		const sig = d.sign(signed);
		expect(() =>
			openWrapBootstrapEnvelope({
				frame: { header, ciphertext: payload, sig },
				resolvedEntityId: header.entityId,
				verify: d.verify,
			}),
		).toThrow(/MemberWrapPayload/);
	});

	it("encode → decode → open round-trips through the wire codec", () => {
		const d = makeDevice();
		const { wrap } = makeWrap();
		const frame = sealWrapBootstrapEnvelope({ header: wrapHeader(), wrap, sign: d.sign });
		const wireBytes = encodeFrame(frame);
		const decoded = decodeFrame(wireBytes);
		const out = openWrapBootstrapEnvelope({
			frame: decoded,
			resolvedEntityId: decoded.header.entityId,
			verify: d.verify,
		});
		expect(out).toEqual(wrap);
	});

	it("seal refuses an invalid MemberWrapPayload", () => {
		const d = makeDevice();
		expect(() =>
			sealWrapBootstrapEnvelope({
				header: wrapHeader(),
				wrap: { hello: "world" } as unknown as MemberWrapPayload,
				sign: d.sign,
			}),
		).toThrow(/MemberWrapPayload/);
	});

	it("sign returning wrong-size sig is rejected on seal", () => {
		const { wrap } = makeWrap();
		expect(() =>
			sealWrapBootstrapEnvelope({
				header: wrapHeader(),
				wrap,
				sign: () => new Uint8Array(32),
			}),
		).toThrow(/64-byte/);
	});
});

describe("expectedRoutingId (10.11 routing-token mode)", () => {
	it("opens when the header carries the expected routing token instead of the raw id", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const token = "tok_b64url_pseudonym";
		const sealed = sealUpdateEnvelope({
			dek,
			header: header({ entityId: token }),
			payload: new Uint8Array([1, 2, 3]),
			sign: d.sign,
		});
		const plaintext = openUpdateEnvelope({
			frame: sealed,
			dek,
			resolvedEntityId: "ent_seal",
			verify: d.verify,
			expectedRoutingId: token,
		});
		expect(plaintext).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("rejects when the routed token is not the expected one (EntityIdMismatch)", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const sealed = sealUpdateEnvelope({
			dek,
			header: header({ entityId: "tok_actual" }),
			payload: new Uint8Array([1]),
			sign: d.sign,
		});
		expect(() =>
			openUpdateEnvelope({
				frame: sealed,
				dek,
				resolvedEntityId: "ent_seal",
				verify: d.verify,
				expectedRoutingId: "tok_expected",
			}),
		).toThrow(EntityIdMismatch);
	});

	it("absent expectedRoutingId keeps the legacy raw-id equality check load-bearing", () => {
		const dek = generateSymmetricKey();
		const d = makeDevice();
		const sealed = sealUpdateEnvelope({
			dek,
			header: header({ entityId: "tok_actual" }),
			payload: new Uint8Array([1]),
			sign: d.sign,
		});
		expect(() =>
			openUpdateEnvelope({
				frame: sealed,
				dek,
				resolvedEntityId: "ent_seal",
				verify: d.verify,
			}),
		).toThrow(EntityIdMismatch);
	});
});
