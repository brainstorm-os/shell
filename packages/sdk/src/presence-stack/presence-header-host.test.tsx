// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { PresenceSelf } from "./presence-awareness";
import { disposePresenceHeader, renderPresenceHeader } from "./presence-header-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TYPE = "brainstorm/List/v1";
const SELF: PresenceSelf = { pubkey: "pk_bob", displayName: "Bob", fingerprint: "fp_bob" };

function setBrainstorm(bs: unknown): void {
	(window as unknown as { brainstorm?: unknown }).brainstorm = bs;
}

afterEach(() => setBrainstorm(undefined));

describe("renderPresenceHeader", () => {
	let host: HTMLDivElement;

	afterEach(() => {
		disposePresenceHeader(host);
		host.remove();
	});

	it("renders nothing when there are no remote peers", () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		setBrainstorm({
			services: {
				roster: { self: async () => SELF },
				presence: {
					publish: async () => {},
					untrack: async () => {},
				},
			},
			presence: { onPeers: () => () => {} },
		});
		act(() => renderPresenceHeader(host, "list-1", TYPE));
		expect(host.querySelector(".bs-presence")).toBeNull();
	});

	it("paints avatars when peers arrive", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		let push: ((peers: { clientId: number; state: Record<string, unknown> }[]) => void) | null = null;
		setBrainstorm({
			services: {
				roster: { self: async () => SELF },
				presence: {
					publish: async () => {},
					untrack: async () => {},
				},
			},
			presence: {
				onPeers: (_id: string, cb: typeof push) => {
					push = cb;
					return () => {};
				},
			},
		});
		act(() => renderPresenceHeader(host, "list-1", TYPE));
		await act(async () => {
			push?.([
				{
					clientId: 2,
					state: { presence: { id: "pk_alice", name: "Alice", color: "#e8590c" } },
				},
			]);
		});
		expect(host.querySelectorAll(".bs-presence__avatar").length).toBe(1);
	});
});
