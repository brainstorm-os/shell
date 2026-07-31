/**
 * P2P-1 — the keepalive across a real client/host pair.
 *
 * The unit tests drive the port against a fake socket; this drives the shipped
 * `LanRelayHost` through its in-process `WebSocketCtor`, so the ping actually
 * has to survive the host's admission gate, its message pump and its blind
 * router. Two properties matter and neither is visible from the client alone:
 *
 *  - the host ANSWERS an admitted peer's ping, so the client's deadline clears;
 *  - the host answers NOTHING before admission, so `ping` is not a pre-auth
 *    liveness oracle a stranger can scan the LAN with.
 */

import { describe, expect, it } from "vitest";
import { LanRelayHost } from "./lan-relay-host";
import {
	CONTROL_CHANNEL_BYTE,
	WebSocketRelayPort,
	WebSocketRelayState,
	encodeControlMessage,
} from "./websocket-relay-port";

const flush = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("waitFor: timed out");
}

describe("heartbeat against the real LanRelayHost", () => {
	it("an admitted peer's ping is answered, and the port stays Open", async () => {
		const host = new LanRelayHost();
		const port = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: host.webSocketCtor(),
			heartbeatIntervalMs: 20,
			heartbeatTimeoutMs: 1_000,
		});
		try {
			port.connect();
			await port.awaitOpen();
			// Several heartbeat rounds: if the host did not answer, the 1 s
			// deadline would fire and the port would degrade.
			await new Promise((r) => setTimeout(r, 200));
			expect(port.state).toBe(WebSocketRelayState.Open);
		} finally {
			port.close();
			host.close();
		}
	});

	it("degrades when the host stops answering, without closing the socket", async () => {
		const host = new LanRelayHost();
		const degraded: boolean[] = [];
		const port = new WebSocketRelayPort({
			url: "lan://host",
			wsImpl: host.webSocketCtor(),
			heartbeatIntervalMs: 20,
			heartbeatTimeoutMs: 60,
			onDegraded: (d) => degraded.push(d),
		});
		try {
			port.connect();
			await port.awaitOpen();
			await flush();
			// Freeze the host: it holds the socket open and answers nothing, which
			// is what a `SIGSTOP`ped or sleeping peer looks like on the wire.
			host.close();
			await waitFor(() => port.state === WebSocketRelayState.Degraded);
			expect(degraded[0]).toBe(true);
		} finally {
			port.close();
		}
	});

	it("does not answer a ping before admission — no pre-auth liveness oracle", async () => {
		// A host with an `admit` callback challenges and holds the connection
		// unauthenticated. A stranger's ping must get nothing back.
		const host = new LanRelayHost({ admit: async () => false });
		const ctor = host.webSocketCtor();
		const replies: Uint8Array[] = [];
		const socket = new ctor("lan://host");
		socket.onmessage = (event) => {
			const data = event.data;
			if (data instanceof Uint8Array) replies.push(data);
		};
		try {
			await flush();
			const before = replies.length;
			socket.send(encodeControlMessage({ op: "ping", t: 1 }));
			await flush();
			const added = replies.slice(before);
			const pongs = added.filter((wire) => {
				if (wire[0] !== CONTROL_CHANNEL_BYTE) return false;
				try {
					return (
						(JSON.parse(new TextDecoder().decode(wire.subarray(1))) as { op?: string }).op === "pong"
					);
				} catch {
					return false;
				}
			});
			expect(pongs).toEqual([]);
		} finally {
			socket.close();
			host.close();
		}
	});
});
