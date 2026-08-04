import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { generateDeviceEd25519 } from "../credentials/device-ed25519";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { sealQrIdentityForB } from "./pairing-handshake";
import { PairingState } from "./pairing-handshake";
import { PairingMode } from "./pairing-payload";
import {
	PairingService,
	type PairingServiceSession,
	makePairingServiceHandler,
} from "./pairing-service";

function makeFakeSession(overrides: Partial<PairingServiceSession> = {}): PairingServiceSession {
	const userPair = ed25519.keygen();
	const userPublic = new Uint8Array(userPair.publicKey);
	const userSecret = new Uint8Array(userPair.secretKey);
	const deviceEd = generateDeviceEd25519();
	const deviceX = generateDeviceX25519();
	const records: ReturnType<PairingServiceSession["devicesList"]> = [];
	let storedIdentitySecret: Uint8Array | null = null;
	let reopened = 0;
	const base: PairingServiceSession = {
		vaultId: "vlt_pair_test",
		getUserIdentity: () => ({ publicKey: userPublic, secretKey: userSecret }),
		getDeviceEd25519: () => ({ publicKey: deviceEd.publicKey, secretKey: deviceEd.secretKey }),
		getDeviceX25519: () => ({ publicKey: deviceX.publicKey }),
		getRelayUrl: () => "wss://relay.example.test/v1",
		saveIdentitySecret: async (secret) => {
			storedIdentitySecret = new Uint8Array(secret);
		},
		// F-493 — a pristine vault by default, so the existing cases still join.
		// The refusal path has its own cases below.
		listEntityPrincipals: async () => [{ createdBy: "brainstorm.shell" }],
		reopenForAdoptedIdentity: async () => {
			reopened += 1;
		},
		devicesAdd: (record) => {
			records.push(record);
			return record;
		},
		devicesList: () => records.map((r) => ({ ...r })),
		devicesRevoke: (pub) => {
			for (let i = 0; i < records.length; i++) {
				const r = records[i];
				if (r && r.deviceEd25519Pub === pub && r.revokedAt === undefined) {
					records[i] = { ...r, revokedAt: Date.now() };
					return true;
				}
			}
			return false;
		},
	};
	(base as { _stored?: () => Uint8Array | null })._stored = () => storedIdentitySecret;
	return { ...base, ...overrides };
}

function makeEnvelope(method: string, args: unknown[]): Envelope {
	return {
		v: 1,
		msg: "m_test",
		app: "shell",
		service: "pairing",
		method,
		args,
		caps: [],
	};
}

describe("PairingService — IPC layer", () => {
	it("startAddDevice mints a payload + SAS and the machine arms for join", async () => {
		const session = makeFakeSession();
		const svc = new PairingService({ getSession: async () => session });
		const out = await svc.startAddDevice({ mode: PairingMode.Qr });
		expect(out.requestId).toMatch(/^pair_/);
		expect(out.sas).toMatch(/^\d{6}$/);
		expect(out.payload.length).toBeGreaterThan(0);
		expect(out.mode).toBe(PairingMode.Qr);
		expect(svc.pendingRequestCount()).toBe(1);
	});

	it("scanPayload + confirmSas appends a signed add-device record + saves identity", async () => {
		const sourceSession = makeFakeSession();
		const sourceSvc = new PairingService({ getSession: async () => sourceSession });
		const started = await sourceSvc.startAddDevice({ mode: PairingMode.Qr });
		const sourceIdentity = sourceSession.getUserIdentity();

		// Pull the pairingSecret out of the source service via a fresh
		// decode + seal — the service keeps pairingSecret in-process so the
		// test reaches into the encoded payload the same way the renderer
		// would post-and-deliver to B.
		const { decodePairingPayload } = await import("./pairing-payload");
		const payload = decodePairingPayload(started.payload);
		const sealedIdentity = sealQrIdentityForB(sourceIdentity.secretKey, payload.pairingSecret);

		// Target side: distinct session (separate device keys) but joining
		// the *same* user identity.
		const targetSession = makeFakeSession();
		const targetSvc = new PairingService({ getSession: async () => targetSession });
		const scanned = await targetSvc.scanPayload({
			payload: started.payload,
			sealedIdentity,
		});
		expect(scanned.sas).toBe(started.sas);
		const confirmed = await targetSvc.confirmSas({ requestId: scanned.requestId });
		expect(confirmed.addedRecord.deviceEd25519Pub.length).toBeGreaterThan(0);
		expect(confirmed.addedRecord.sig.length).toBeGreaterThan(0);
		// P2P-1 — the joiner records BOTH ends: itself, and the device it just
		// paired with. It used to record only itself, which left it unable to
		// recognise the source as a rostered host, so LAN admission could never
		// succeed and every dial fell back to the relay.
		const rostered = targetSession.devicesList();
		expect(rostered.length).toBe(2);
		expect(rostered.map((d) => d.deviceEd25519Pub)).toContain(confirmed.addedRecord.deviceEd25519Pub);
		// Only the source's Ed25519 travels in the QR payload, so its row carries
		// an empty X25519: a member we can verify, but cannot yet seal to.
		const sourceRow = rostered.find(
			(d) => d.deviceEd25519Pub !== confirmed.addedRecord.deviceEd25519Pub,
		);
		expect(sourceRow?.deviceX25519Pub).toBe("");

		const stored = (targetSession as unknown as { _stored: () => Uint8Array | null })._stored();
		expect(stored).not.toBeNull();
		expect(Buffer.compare(stored as Uint8Array, sourceIdentity.secretKey)).toBe(0);
	});

	it("cancelPairing transitions to Cancelled", async () => {
		const svc = new PairingService({ getSession: async () => makeFakeSession() });
		const started = await svc.startAddDevice({ mode: PairingMode.Qr });
		const out = await svc.cancelPairing({ requestId: started.requestId });
		expect(out.state).toBe(PairingState.Cancelled);
	});

	it("listDevices and revokeDevice round-trip", async () => {
		const session = makeFakeSession();
		const svc = new PairingService({ getSession: async () => session });
		// Manually seed a record so revoke can find it.
		session.devicesAdd({
			deviceEd25519Pub: "seed-pub",
			deviceX25519Pub: "seed-xpub",
			deviceLabel: "seed",
			addedAt: 1_700_000_000,
			addedBy: "owner",
			sig: "seed-sig",
		});
		const list = await svc.listDevices();
		expect(list.records.length).toBe(1);
		const revoked = await svc.revokeDevice({ deviceEd25519Pub: "seed-pub" });
		expect(revoked.revoked).toBe(true);
		const stillThere = await svc.revokeDevice({ deviceEd25519Pub: "seed-pub" });
		expect(stillThere.revoked).toBe(false);
	});

	it("startAddDevice rejects when no syncRelay is configured", async () => {
		const session = makeFakeSession({ getRelayUrl: () => null });
		const svc = new PairingService({ getSession: async () => session });
		await expect(svc.startAddDevice({})).rejects.toMatchObject({ name: "Unavailable" });
	});
});

describe("makePairingServiceHandler — broker handler", () => {
	it("Unavailable when no service is wired", async () => {
		const handler = makePairingServiceHandler({ getService: async () => null });
		await expect(handler(makeEnvelope("listDevices", [{}]))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("Invalid on unknown methods", async () => {
		const svc = new PairingService({ getSession: async () => makeFakeSession() });
		const handler = makePairingServiceHandler({ getService: async () => svc });
		await expect(handler(makeEnvelope("frobnicate", [{}]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("forwards startAddDevice through the handler", async () => {
		const session = makeFakeSession();
		const svc = new PairingService({ getSession: async () => session });
		const handler = makePairingServiceHandler({ getService: async () => svc });
		const result = (await handler(makeEnvelope("startAddDevice", [{ mode: PairingMode.Qr }]))) as {
			requestId: string;
			sas: string;
		};
		expect(result.requestId).toMatch(/^pair_/);
		expect(result.sas).toMatch(/^\d{6}$/);
	});

	it("forwards listDevices through the handler", async () => {
		const session = makeFakeSession();
		session.devicesAdd({
			deviceEd25519Pub: "p1",
			deviceX25519Pub: "x1",
			deviceLabel: "",
			addedAt: 1,
			addedBy: "b",
			sig: "s",
		});
		const svc = new PairingService({ getSession: async () => session });
		const handler = makePairingServiceHandler({ getService: async () => svc });
		const out = (await handler(makeEnvelope("listDevices", [{}]))) as {
			records: unknown[];
		};
		expect(out.records.length).toBe(1);
	});

	it("propagates Invalid from the service layer (bad cancel id)", async () => {
		const svc = new PairingService({ getSession: async () => makeFakeSession() });
		const handler = makePairingServiceHandler({ getService: async () => svc });
		await expect(
			handler(makeEnvelope("cancelPairing", [{ requestId: "does-not-exist" }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("F-493 — refuses to join when the vault already holds the user's own work", async () => {
		const sourceSession = makeFakeSession();
		const sourceSvc = new PairingService({ getSession: async () => sourceSession });
		const started = await sourceSvc.startAddDevice({ mode: PairingMode.Qr });
		const sourceIdentity = sourceSession.getUserIdentity();
		const { decodePairingPayload } = await import("./pairing-payload");
		const payload = decodePairingPayload(started.payload);
		const sealedIdentity = sealQrIdentityForB(sourceIdentity.secretKey, payload.pairingSecret);

		// A vault with one note the person wrote. Joining would re-point it at the
		// source's identity, and `authorizesWrapInstall` treats a frame from this
		// vault's own sovereign key as authorised to ROTATE a DEK on any entity —
		// so the source would gain unconditional authority over that note.
		const targetSession = makeFakeSession({
			listEntityPrincipals: async () => [
				{ createdBy: "brainstorm.shell" },
				{ createdBy: "io.brainstorm.welcome" },
				{ createdBy: "Se7lyssNZ0D+UDiRLKxlza4GlrSMNKed861JJCAyIYQ=" },
			],
		});
		const targetSvc = new PairingService({ getSession: async () => targetSession });

		await expect(
			targetSvc.scanPayload({ payload: started.payload, sealedIdentity }),
		).rejects.toMatchObject({ name: "Invalid" });

		// And it refused BEFORE writing anything: the identity secret is the
		// thing that would have bricked the vault, so a refusal that still
		// stored it would be no refusal at all.
		const stored = (targetSession as unknown as { _stored: () => Uint8Array | null })._stored();
		expect(stored).toBeNull();
	});

	it("F-492 — re-opens the vault after joining so the session adopts the identity", async () => {
		const sourceSession = makeFakeSession();
		const sourceSvc = new PairingService({ getSession: async () => sourceSession });
		const started = await sourceSvc.startAddDevice({ mode: PairingMode.Qr });
		const sourceIdentity = sourceSession.getUserIdentity();
		const { decodePairingPayload } = await import("./pairing-payload");
		const payload = decodePairingPayload(started.payload);
		const sealedIdentity = sealQrIdentityForB(sourceIdentity.secretKey, payload.pairingSecret);

		let reopens = 0;
		const targetSession = makeFakeSession({
			reopenForAdoptedIdentity: async () => {
				reopens += 1;
			},
		});
		const targetSvc = new PairingService({ getSession: async () => targetSession });
		const scanned = await targetSvc.scanPayload({ payload: started.payload, sealedIdentity });
		expect(reopens).toBe(0); // not yet — the pair is not complete at scan time
		await targetSvc.confirmSas({ requestId: scanned.requestId });
		expect(reopens).toBe(1);
	});

	it("F-492 — a re-open failure leaves the device PAIRED, not half-joined", async () => {
		const sourceSession = makeFakeSession();
		const sourceSvc = new PairingService({ getSession: async () => sourceSession });
		const started = await sourceSvc.startAddDevice({ mode: PairingMode.Qr });
		const sourceIdentity = sourceSession.getUserIdentity();
		const { decodePairingPayload } = await import("./pairing-payload");
		const payload = decodePairingPayload(started.payload);
		const sealedIdentity = sealQrIdentityForB(sourceIdentity.secretKey, payload.pairingSecret);

		const targetSession = makeFakeSession({
			reopenForAdoptedIdentity: async () => {
				throw new Error("vault busy");
			},
		});
		const targetSvc = new PairingService({ getSession: async () => targetSession });
		const scanned = await targetSvc.scanPayload({ payload: started.payload, sealedIdentity });
		// The pair itself is durable before the re-open is attempted, so a failure
		// costs a restart — never an un-paired device holding a half-adopted key.
		const confirmed = await targetSvc.confirmSas({ requestId: scanned.requestId });
		expect(confirmed.addedRecord.sig.length).toBeGreaterThan(0);
		expect(targetSession.devicesList().length).toBe(2);
	});
});
