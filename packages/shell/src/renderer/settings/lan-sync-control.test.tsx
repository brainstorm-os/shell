// @vitest-environment jsdom
/**
 * P2P-1 — Settings → Sync → Local network.
 *
 * The regression these guard is the one that made the whole feature
 * unreachable: the LAN control was rendered ONLY inside `SyncSection`'s
 * "status unavailable" early return, so on the normal path a user could never
 * see it — and even then it only ever set the host half, because no dial
 * control existed at all.
 */

import { SyncTransportKind } from "@brainstorm-os/protocol/sync-status-types";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanSyncControl } from "./lan-sync-control";
import { SyncSection } from "./sync-section";

type Bridge = {
	snapshot: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	getLanHostMode: ReturnType<typeof vi.fn>;
	setLanHostMode: ReturnType<typeof vi.fn>;
	getLanPeering: ReturnType<typeof vi.fn>;
	setLanDialMode: ReturnType<typeof vi.fn>;
	setLanPeerAddress: ReturnType<typeof vi.fn>;
};

const PEERING = {
	dialMode: "auto",
	manualUrl: null,
	activeUrl: "ws://192.168.1.20:51820",
	listenerUrl: "ws://192.168.1.10:51820",
	peers: [{ instance: "brainstorm-aabbccdd", urls: ["ws://192.168.1.20:51820"] }],
};

let bridge: Bridge;

beforeEach(() => {
	bridge = {
		snapshot: vi.fn().mockResolvedValue(null),
		on: vi.fn().mockReturnValue(() => undefined),
		getLanHostMode: vi.fn().mockResolvedValue("when-vault-open"),
		setLanHostMode: vi.fn().mockResolvedValue("off"),
		getLanPeering: vi.fn().mockResolvedValue(PEERING),
		setLanDialMode: vi.fn().mockResolvedValue({ ...PEERING, dialMode: "off" }),
		setLanPeerAddress: vi.fn().mockResolvedValue(null),
	};
	(window as unknown as { brainstorm: unknown }).brainstorm = { syncStatus: bridge };
});

afterEach(() => {
	(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	document.body.innerHTML = "";
});

async function mount(node: React.ReactElement): Promise<{ html: string; container: HTMLElement }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(node);
	});
	return { html: container.innerHTML, container };
}

describe("<LanSyncControl>", () => {
	it("reads both halves through the privileged bridge", async () => {
		await mount(<LanSyncControl />);
		expect(bridge.getLanHostMode).toHaveBeenCalled();
		expect(bridge.getLanPeering).toHaveBeenCalled();
	});

	it("renders the host toggle AND the dial picker — the two ends of one sentence", async () => {
		const { html } = await mount(<LanSyncControl />);
		expect(html).toContain("lan-host-mode");
		expect(html).toContain("lan-dial-mode");
	});

	it("shows this device's address so the other machine has something to type", async () => {
		const { html } = await mount(<LanSyncControl />);
		expect(html).toContain("ws://192.168.1.10:51820");
	});

	it("lists a discovered peer while finding devices automatically", async () => {
		const { html } = await mount(<LanSyncControl />);
		expect(html).toContain("brainstorm-aabbccdd");
	});

	it("claims 'no server' only when the live transport really is LAN", async () => {
		const off = await mount(<LanSyncControl transportKind={SyncTransportKind.WebSocket} />);
		expect(off.html).not.toContain("lan-sync-live");
		const on = await mount(<LanSyncControl transportKind={SyncTransportKind.Lan} />);
		expect(on.html).toContain("lan-sync-live");
	});

	it("offers the address field only in manual mode", async () => {
		const auto = await mount(<LanSyncControl />);
		expect(auto.html).not.toContain("lan-peer-address");
		bridge.getLanPeering.mockResolvedValue({ ...PEERING, dialMode: "manual" });
		const manual = await mount(<LanSyncControl />);
		expect(manual.html).toContain("lan-peer-address");
	});

	it("renders nothing until the bridge answers, rather than a half-panel", () => {
		expect(renderToStaticMarkup(<LanSyncControl />)).toBe("");
	});
});

describe("<SyncSection> reachability", () => {
	it("renders the LAN group on the placeholder path", async () => {
		const { html } = await mount(<SyncSection />);
		expect(html).toContain("lan-sync");
	});

	it("renders the LAN group on the LIVE path too — the regression this fixes", async () => {
		bridge.snapshot.mockResolvedValue({
			state: "syncing",
			transportState: "open",
			relayUrl: "ws://192.168.1.20:51820",
			connectionId: "c1",
			lastInboundAtMs: Date.now(),
			lastOutboundAtMs: Date.now(),
			droppedSends: 0,
			droppedInbound: 0,
			seqStateBytes: 0,
			pairKeyCount: 0,
			attachmentSyncPausedReason: null,
			transportKind: SyncTransportKind.Lan,
		});
		const { html } = await mount(<SyncSection />);
		expect(html).toContain("lan-sync");
		expect(html).toContain("lan-dial-mode");
	});
});
