// @vitest-environment jsdom
/**
 * PRES-3 — `usePresence` (the fleet header primitive) + `presenceAwarenessFor`.
 * Publishes THIS device's presence and returns live remote peers, over the real
 * transport in the shell and a local channel standalone.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceSelf } from "./presence-awareness";
import { presenceAwarenessFor, usePresence } from "./use-presence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TYPE = "brainstorm/Note/v1";
const SELF: PresenceSelf = { pubkey: "pk_alice", displayName: "Alice", fingerprint: "fp_alice" };

function setBrainstorm(bs: unknown): void {
	(window as unknown as { brainstorm?: unknown }).brainstorm = bs;
}

function makeShell() {
	const publish = vi.fn(
		(_input: { entityId: string; type: string; state: Record<string, unknown> | null }) =>
			Promise.resolve(),
	);
	const untrack = vi.fn((_input: { entityId: string }) => Promise.resolve());
	let cb: ((peers: { clientId: number; state: Record<string, unknown> }[]) => void) | null = null;
	setBrainstorm({
		services: { presence: { publish, untrack } },
		presence: {
			onPeers: (
				_id: string,
				c: (p: { clientId: number; state: Record<string, unknown> }[]) => void,
			) => {
				cb = c;
				return () => {};
			},
		},
	});
	return {
		publish,
		untrack,
		pushPeers: (peers: { clientId: number; state: Record<string, unknown> }[]) => cb?.(peers),
	};
}

afterEach(() => setBrainstorm(undefined));

describe("presenceAwarenessFor", () => {
	it("no shell → local channel; shell → publishes to the presence service", () => {
		setBrainstorm(undefined);
		const local = presenceAwarenessFor("n1", TYPE);
		local.setLocalStateField("presence", { id: "u" });
		expect(local.getStates().get(local.clientID)).toEqual({ presence: { id: "u" } });

		const shell = makeShell();
		const synced = presenceAwarenessFor("note-1", TYPE);
		synced.setLocalStateField("presence", { id: "alice" });
		expect(shell.publish).toHaveBeenCalledWith({
			entityId: "note-1",
			type: TYPE,
			state: { presence: { id: "alice" } },
		});
	});
});

function Harness({ entityId }: { entityId: string | null }) {
	const peers = usePresence(entityId, TYPE, SELF);
	return <output data-testid="peers">{peers.map((p) => p.name).join(",")}</output>;
}

describe("usePresence", () => {
	let host: HTMLDivElement;
	let root: Root;

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	function render(entityId: string | null): void {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		act(() => root.render(<Harness entityId={entityId} />));
	}

	it("publishes self on mount and renders inbound peers", async () => {
		const shell = makeShell();
		render("note-1");
		// Self published under the presence key (name = Alice).
		expect(shell.publish).toHaveBeenCalled();
		const call = shell.publish.mock.calls[0]?.[0] as {
			state: { presence?: { name?: string } };
		};
		expect(call.state.presence?.name).toBe("Alice");

		// A remote peer arrives → rendered in the stack (external-store re-render
		// flushes as a microtask, so drive it with an async act).
		await act(async () => {
			shell.pushPeers([
				{ clientId: 7, state: { presence: { id: "pk_bob", name: "Bob", color: "#2f6df6" } } },
			]);
		});
		expect(host.querySelector('[data-testid="peers"]')?.textContent).toBe("Bob");
	});

	it("clears our presence on unmount (untrack)", () => {
		const shell = makeShell();
		render("note-1");
		act(() => root.unmount());
		expect(shell.untrack).toHaveBeenCalledWith({ entityId: "note-1" });
		// re-mount a no-op host so afterEach unmount is safe
		render(null);
	});
});
