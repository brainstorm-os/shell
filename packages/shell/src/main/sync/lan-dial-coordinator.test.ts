import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LAN_CANDIDATE_TTL_MS,
	DEFAULT_LAN_DIAL_COOLDOWN_MS,
	LanDialCoordinator,
	LanDialMode,
	LanDialSource,
	type LanDialTarget,
	parseLanDialMode,
	parseLanPeerAddress,
} from "./lan-dial-coordinator";
import type { LanPeerCandidate } from "./lan-discovery";

function candidate(instance: string, urls: string[]): LanPeerCandidate {
	return {
		instance,
		addresses: urls.map((u) => new URL(u).hostname),
		port: Number(new URL(urls[0] ?? "ws://10.0.0.1:1").port),
		urls,
	};
}

describe("parseLanPeerAddress", () => {
	it.each([
		["192.168.1.20:51820", "ws://192.168.1.20:51820"],
		["ws://192.168.1.20:51820", "ws://192.168.1.20:51820"],
		["  10.0.0.4:9000  ", "ws://10.0.0.4:9000"],
		["127.0.0.1:9000", "ws://127.0.0.1:9000"],
	])("normalises %s", (raw, expected) => {
		expect(parseLanPeerAddress(raw)).toBe(expected);
	});

	it.each([
		["", "empty"],
		["192.168.1.20", "no port — a LAN listener's port is ephemeral"],
		["evil.example.com:80", "a hostname would mean a DNS lookup from typed input"],
		["8.8.8.8:80", "a routable address is not the local network"],
		["0.0.0.0:80", "wildcard"],
		["wss://192.168.1.20:443", "wss to a peer is meaningless"],
		["http://192.168.1.20:80", "wrong scheme"],
		["192.168.1.20:0", "port 0"],
		["192.168.1.20:70000", "port out of range"],
		["user:pw@192.168.1.20:80", "credentials in the address"],
		["192.168.1.20:80/path", "a path"],
		["x".repeat(200), "oversized"],
	])("refuses %s (%s)", (raw) => {
		expect(parseLanPeerAddress(raw)).toBeNull();
	});
});

describe("parseLanDialMode", () => {
	it("falls back to Off on anything unrecognised", () => {
		expect(parseLanDialMode("nonsense")).toBe(LanDialMode.Off);
		expect(parseLanDialMode(undefined)).toBe(LanDialMode.Off);
		expect(parseLanDialMode({})).toBe(LanDialMode.Off);
		expect(parseLanDialMode(LanDialMode.Auto)).toBe(LanDialMode.Auto);
	});
});

describe("LanDialCoordinator", () => {
	let now = 1_000_000;
	let targets: (LanDialTarget | null)[];
	let coordinator: LanDialCoordinator;

	beforeEach(() => {
		now = 1_000_000;
		targets = [];
		coordinator = new LanDialCoordinator({
			onTargetChanged: (t) => targets.push(t),
			now: () => now,
		});
	});

	it("dials nothing while Off, however many peers turn up", () => {
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		expect(coordinator.target()).toBeNull();
		expect(targets).toEqual([]);
	});

	it("selects a discovered peer once Auto is on", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		expect(coordinator.target()).toEqual({
			url: "ws://10.0.0.2:5000",
			source: LanDialSource.Discovery,
			instance: "a",
		});
		expect(targets).toHaveLength(1);
	});

	it("hands sync back to the relay when the dial fails, and cools the address off", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		coordinator.noteDialUnusable("ws://10.0.0.2:5000");
		expect(coordinator.target()).toBeNull();

		// Still cooling: a re-advert must not re-dial a sleeping machine every
		// few seconds.
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		expect(coordinator.target()).toBeNull();

		now += DEFAULT_LAN_DIAL_COOLDOWN_MS + 1;
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		expect(coordinator.target()?.url).toBe("ws://10.0.0.2:5000");
	});

	it("moves to the peer's next address when the first is cooling", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000", "ws://192.168.1.9:5000"]));
		coordinator.noteDialUnusable("ws://10.0.0.2:5000");
		expect(coordinator.target()?.url).toBe("ws://192.168.1.9:5000");
	});

	it("does not swap a healthy link out because a fresher advert arrived", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		now += 1_000;
		coordinator.offerCandidate(candidate("b", ["ws://10.0.0.3:5000"]));
		expect(coordinator.target()?.url).toBe("ws://10.0.0.2:5000");
		expect(targets).toHaveLength(1);
	});

	it("expires a record on our own clock — mDNS never says a peer went away", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		now += DEFAULT_LAN_CANDIDATE_TTL_MS + 1;
		expect(coordinator.knownPeers()).toEqual([]);
		// The expiry is observed on the next selection, not by a timer.
		coordinator.setMode(LanDialMode.Manual);
		coordinator.setMode(LanDialMode.Auto);
		expect(coordinator.target()).toBeNull();
	});

	it("in Manual mode dials only the typed address, ignoring discovery", () => {
		coordinator.setMode(LanDialMode.Manual);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		expect(coordinator.target()).toBeNull();
		coordinator.setManualUrl("ws://192.168.1.20:51820");
		expect(coordinator.target()).toEqual({
			url: "ws://192.168.1.20:51820",
			source: LanDialSource.Manual,
		});
	});

	it("re-typing an address clears its cooldown — 'try again' must try again", () => {
		coordinator.setMode(LanDialMode.Manual);
		coordinator.setManualUrl("ws://192.168.1.20:51820");
		coordinator.noteDialUnusable("ws://192.168.1.20:51820");
		expect(coordinator.target()).toBeNull();
		coordinator.setManualUrl(null);
		coordinator.setManualUrl("ws://192.168.1.20:51820");
		expect(coordinator.target()?.url).toBe("ws://192.168.1.20:51820");
	});

	it("an admitted link clears the cooldown", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		coordinator.noteDialUnusable("ws://10.0.0.2:5000");
		coordinator.noteDialOpen("ws://10.0.0.2:5000");
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		expect(coordinator.target()?.url).toBe("ws://10.0.0.2:5000");
	});

	it("drops every learned peer on reset — a new identity verified none of them", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		coordinator.reset();
		expect(coordinator.target()).toBeNull();
		expect(coordinator.knownPeers()).toEqual([]);
	});

	it("turning the mode Off drops a live target immediately", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		coordinator.setMode(LanDialMode.Off);
		expect(coordinator.target()).toBeNull();
		expect(targets.at(-1)).toBeNull();
	});

	it("does not re-notify when the selection has not moved", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		expect(targets).toHaveLength(1);
	});

	it("ignores a candidate with no dialable URL", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate({ instance: "a", addresses: [], port: 1, urls: [] });
		expect(coordinator.target()).toBeNull();
	});

	it("reports known peers freshest first for the Settings list", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("a", ["ws://10.0.0.2:5000"]));
		now += 1_000;
		coordinator.offerCandidate(candidate("b", ["ws://10.0.0.3:5000"]));
		expect(coordinator.knownPeers().map((p) => p.instance)).toEqual(["b", "a"]);
	});

	it("carries pairing provenance through so a payload-learned peer is dialable", () => {
		coordinator.setMode(LanDialMode.Auto);
		coordinator.offerCandidate(candidate("paired", ["ws://10.0.0.9:5000"]), LanDialSource.Pairing);
		expect(coordinator.target()?.source).toBe(LanDialSource.Pairing);
	});

	it("survives a consumer that throws, with selection already committed", () => {
		const onTargetChanged = vi.fn(() => {
			throw new Error("consumer blew up");
		});
		const throwing = new LanDialCoordinator({ onTargetChanged, now: () => now });
		throwing.setMode(LanDialMode.Manual);
		expect(() => throwing.setManualUrl("ws://10.0.0.2:5000")).not.toThrow();
		expect(throwing.target()?.url).toBe("ws://10.0.0.2:5000");
		expect(onTargetChanged).toHaveBeenCalledTimes(1);
	});
});
