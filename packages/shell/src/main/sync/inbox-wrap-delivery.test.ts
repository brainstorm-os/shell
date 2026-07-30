/**
 * F-466 regression — the cross-user share's inbox `WrapBootstrap` must reach a
 * receiver whose inbox subscription predates the socket opening, over the
 * PRODUCTION transport stack against a plain (never-admitting) relay server.
 *
 * The bug: `makeRelayPort` classified any loopback/private `syncRelay` URL as
 * a LAN peer and built the port with `requireAdmission: true`. A relay server
 * never runs the LAN admission handshake, so the port sat "Open but never
 * admitted" — and the G5 hold silently swallowed every subscription made
 * before the socket opened. The LiveSyncEngine subscribes the identity's inbox
 * channel at session activation (before the relay is even configured), so the
 * owner's `WrapBootstrap` routed to that inbox had no subscriber: the receiver
 * then failed every Update with "no DEK for entity" and the share never
 * converged (dogfood collab session 001).
 *
 * The stack under test is the real one end to end: `ActiveRelayOrchestrator`
 * (subscription migration across the loopback→WebSocket rebuild) →
 * `WebSocketRelayPort` (announce/hold semantics) → a subscription-honoring
 * in-memory relay hub (mirrors the relay-server `FrameRouter`: fans a frame to
 * subscribers of `header.route ?? header.entityId`, never echoes, never
 * admits) → `CollabDevBridge`/`SharingEngine` on two real `VaultSession`s —
 * the receiver's REAL install path (`receiveWrapBootstrap` → HPKE unwrap →
 * DEK install → encrypted state apply).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessRole } from "../collab/access-record";
import { CollabDevBridge } from "../collab/collab-dev-bridge";
import { inboxChannelFor } from "../collab/inbox-channel";
import { VaultSession } from "../vault/session";
import { ActiveRelayOrchestrator, type MakeRelayPort } from "./active-relay";
import { decodeFrame } from "./envelope-codec";
import {
	CONTROL_CHANNEL_BYTE,
	FRAME_CHANNEL_BYTE,
	WebSocketRelayPort,
	WebSocketRelayState,
} from "./websocket-relay-port";

const ENTITY_ID = "ent_f466_brief";
const ENTITY_TYPE = "brainstorm/Note/v1";

/** In-memory stand-in for the relay server: honors `subscribe`/`unsubscribe`
 *  controls, fans a binary frame to every OTHER connection subscribed to the
 *  frame's `route ?? entityId`, and — like the plain relay server — NEVER
 *  sends `auth-ok` (ignores unknown controls such as `hello`). */
class RelayHub {
	readonly sockets: HubSocket[] = [];

	/** All subscribe-announced routing keys, in arrival order (assert surface). */
	readonly announcedKeys: string[] = [];

	route(from: HubSocket, wire: Uint8Array): void {
		const channel = wire[0];
		if (channel === CONTROL_CHANNEL_BYTE) {
			const msg = JSON.parse(new TextDecoder().decode(wire.subarray(1))) as {
				op?: string;
				entityIds?: string[];
			};
			if (msg.op === "subscribe") {
				for (const id of msg.entityIds ?? []) {
					from.subs.add(id);
					this.announcedKeys.push(id);
				}
			}
			if (msg.op === "unsubscribe") {
				for (const id of msg.entityIds ?? []) from.subs.delete(id);
			}
			return; // hello + anything else: ignored, never answered
		}
		if (channel !== FRAME_CHANNEL_BYTE) return;
		const frame = wire.subarray(1);
		let key: string;
		try {
			const decoded = decodeFrame(frame);
			key = decoded.header.route ?? decoded.header.entityId;
		} catch {
			return;
		}
		for (const socket of this.sockets) {
			if (socket === from || !socket.subs.has(key)) continue;
			socket.deliver(wire);
		}
	}
}

/** One fake client socket registered with the hub. Opens asynchronously so a
 *  connect + subscribe sequence hits the real CONNECTING→OPEN transition. */
class HubSocket {
	readonly subs = new Set<string>();
	readyState = 0;
	binaryType: string | undefined;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;

	constructor(private readonly hub: RelayHub) {
		hub.sockets.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.onopen?.();
		});
	}

	send(data: Uint8Array): void {
		this.hub.route(this, new Uint8Array(data));
	}

	close(): void {
		this.readyState = 3;
	}

	deliver(wire: Uint8Array): void {
		this.onmessage?.({ data: wire });
	}
}

function hubWsCtor(hub: RelayHub): new (url: string) => HubSocket {
	return class {
		constructor(_url: string) {
			// biome-ignore lint/correctness/noConstructorReturn: fake ctor returns the hub-bound socket
			return new HubSocket(hub);
		}
	} as unknown as new (
		url: string,
	) => HubSocket;
}

/** The production `makeRelayPort` shape from `main/index.ts`: the trust model
 *  comes from the EXPLICIT `lan` flag — a relay URL (any address) gets the
 *  ungated port; only `lan: true` engages `requireAdmission`. */
function productionShapedFactory(hub: RelayHub): MakeRelayPort {
	return (url, target) => {
		const port = target.lan
			? new WebSocketRelayPort({ url, wsImpl: hubWsCtor(hub), requireAdmission: true })
			: new WebSocketRelayPort({ url, wsImpl: hubWsCtor(hub) });
		port.connect();
		return port;
	};
}

async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("F-466 — inbox WrapBootstrap delivery over the production transport stack", () => {
	let dirMira: string;
	let dirMarcus: string;
	let mira: VaultSession;
	let marcus: VaultSession;
	let orchMira: ActiveRelayOrchestrator;
	let orchMarcus: ActiveRelayOrchestrator;
	let bridgeMira: CollabDevBridge;
	let bridgeMarcus: CollabDevBridge;

	beforeEach(async () => {
		dirMira = await mkdtemp(join(tmpdir(), "bs-f466-mira-"));
		dirMarcus = await mkdtemp(join(tmpdir(), "bs-f466-marcus-"));
		mira = await VaultSession.create({
			vaultId: "vlt_f466_mira",
			vaultPath: dirMira,
			forceInsecure: true,
		});
		marcus = await VaultSession.create({
			vaultId: "vlt_f466_marcus",
			vaultPath: dirMarcus,
			forceInsecure: true,
		});
	});

	afterEach(async () => {
		bridgeMira?.dispose();
		bridgeMarcus?.dispose();
		orchMira?.dispose();
		orchMarcus?.dispose();
		mira.dispose();
		marcus.dispose();
		await rm(dirMira, { recursive: true, force: true });
		await rm(dirMarcus, { recursive: true, force: true });
	});

	it("a share converges when the receiver's inbox subscription predates the socket open (relay on 127.0.0.1)", async () => {
		const hub = new RelayHub();
		// The dogfood/self-hosted shape: a RELAY (lan absent ⇒ false) on a
		// loopback address — exactly the URL the old address-inference misread.
		let target: { url: string; lan: boolean } | null = null;
		const readTarget = async (): Promise<{ url: string; lan: boolean } | null> => target;
		orchMira = new ActiveRelayOrchestrator({
			makeRelayPort: productionShapedFactory(hub),
			readSyncRelayUrl: readTarget,
		});
		orchMarcus = new ActiveRelayOrchestrator({
			makeRelayPort: productionShapedFactory(hub),
			readSyncRelayUrl: readTarget,
		});
		await orchMira.onSessionChanged({ vaultId: "vlt_f466_mira", vaultPath: dirMira });
		await orchMarcus.onSessionChanged({ vaultId: "vlt_f466_marcus", vaultPath: dirMarcus });

		bridgeMira = new CollabDevBridge(mira, () => orchMira);
		bridgeMarcus = new CollabDevBridge(marcus, () => orchMarcus);

		// Session activation subscribes the identity inbox (LiveSyncEngine.start)
		// — BEFORE any relay is configured, i.e. while loopback is live.
		orchMarcus.subscribe(inboxChannelFor(bridgeMarcus.whoami().userPubB64));

		// The harness then points both shells at the shared relay; the
		// orchestrator rebuild migrates the inbox subscription onto the fresh
		// (still-CONNECTING) WebSocket port.
		target = { url: "ws://127.0.0.1:9443", lan: false };
		await orchMira.reconfigure();
		await orchMarcus.reconfigure();
		const openPorts = () =>
			[orchMira.currentPort(), orchMarcus.currentPort()].every(
				(p) => p instanceof WebSocketRelayPort && p.state === WebSocketRelayState.Open,
			);
		await until(openPorts, "both WebSocket ports to open");

		// THE F-466 pin: the pre-open inbox subscription must be announced to
		// the relay once the socket opens (the broken gated port held it
		// forever, so the wrap below had no subscriber and was dropped).
		const marcusInbox = inboxChannelFor(bridgeMarcus.whoami().userPubB64);
		await until(
			() => hub.announcedKeys.includes(marcusInbox),
			"the receiver's inbox subscription to reach the relay",
		);

		await bridgeMira.provisionEntity(ENTITY_ID, ENTITY_TYPE);
		await bridgeMira.editText(ENTITY_ID, "Operating hub - Q3 brief. ");
		await bridgeMira.installShareReceiver(ENTITY_ID, ENTITY_TYPE);
		await bridgeMarcus.installShareReceiver(ENTITY_ID, ENTITY_TYPE);

		const invite = await bridgeMarcus.createInvite("Marcus");
		await bridgeMira.share({
			entityId: ENTITY_ID,
			type: ENTITY_TYPE,
			invite,
			role: AccessRole.Editor,
		});

		// Receiver's REAL install path: WrapBootstrap → HPKE unwrap → DEK
		// install → encrypted full-state apply. "No DEK for entity" is exactly
		// what this read times out on when the wrap never arrives.
		let text = "";
		await until(() => {
			void bridgeMarcus.readText(ENTITY_ID).then((t) => {
				text = t;
			});
			return text.includes("Q3 brief");
		}, "the receiver to decrypt the shared brief");
		expect(text).toContain("Q3 brief");

		const access = await bridgeMarcus.access(ENTITY_ID);
		const marcusB64 = bridgeMarcus.whoami().userPubB64;
		expect(access.find((m) => m.member === marcusB64)?.active).toBe(true);
	});

	it("an EXPLICIT lan target against a never-admitting host announces nothing (fail-closed keeps)", async () => {
		const hub = new RelayHub();
		let target: { url: string; lan: boolean } | null = null;
		orchMarcus = new ActiveRelayOrchestrator({
			makeRelayPort: productionShapedFactory(hub),
			readSyncRelayUrl: async () => target,
		});
		await orchMarcus.onSessionChanged({ vaultId: "vlt_f466_marcus", vaultPath: dirMarcus });
		orchMarcus.subscribe("inbox:someone");
		target = { url: "ws://192.168.1.20:9443", lan: true };
		await orchMarcus.reconfigure();
		await until(() => hub.sockets.length === 1 && hub.sockets[0]?.readyState === 1, "socket open");
		orchMarcus.subscribe(ENTITY_ID);
		await new Promise((r) => setTimeout(r, 50));
		// No admission ⇒ no routing metadata on the wire, ever (G5).
		expect(hub.announcedKeys).toEqual([]);
	});
});
