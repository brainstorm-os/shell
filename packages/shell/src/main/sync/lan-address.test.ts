import { describe, expect, it } from "vitest";
import { isBindableAddress, isPrivateIpv4, rankLanInterfaces } from "./lan-address";

describe("isBindableAddress", () => {
	it.each(["10.0.0.1", "192.168.1.20", "172.16.5.5", "169.254.1.1", "127.0.0.1"])(
		"accepts %s",
		(a) => expect(isBindableAddress(a)).toBe(true),
	);

	it.each([
		"8.8.8.8",
		"0.0.0.0",
		"0",
		"0x0",
		"::0",
		"::1",
		"example.com",
		"10.0.0.1.",
		"",
		"172.32.0.1",
	])("refuses %s", (a) => expect(isBindableAddress(a)).toBe(false));
});

describe("isPrivateIpv4", () => {
	it("excludes loopback, which is not reachable by a peer", () => {
		expect(isPrivateIpv4("127.0.0.1")).toBe(false);
		expect(isBindableAddress("127.0.0.1")).toBe(true);
	});
});

describe("rankLanInterfaces", () => {
	// The failure this ordering exists to prevent is SILENT: taking `[0]` off the
	// OS enumeration binds a Docker bridge or a VPN tunnel, and every symptom
	// then points at discovery or admission instead.
	it("puts physical adapters ahead of virtual ones", () => {
		const ranked = rankLanInterfaces([
			{ name: "docker0", address: "172.17.0.1" },
			{ name: "utun4", address: "10.8.0.2" },
			{ name: "en0", address: "192.168.1.10" },
		]);
		expect(ranked[0]?.name).toBe("en0");
		expect(ranked.at(-1)?.name).toMatch(/docker0|utun4/);
	});

	it.each([
		["docker0", "vboxnet0", "en0"],
		["vmnet1", "veth1234", "eth0"],
		["br-abc123", "tailscale0", "wlan0"],
	])("ranks %s and %s behind %s", (a, b, physical) => {
		const ranked = rankLanInterfaces([
			{ name: a, address: "172.17.0.1" },
			{ name: b, address: "10.8.0.2" },
			{ name: physical, address: "192.168.1.10" },
		]);
		expect(ranked[0]?.name).toBe(physical);
	});

	it("handles Windows-style adapter names", () => {
		const ranked = rankLanInterfaces([
			{ name: "vEthernet (Default Switch)", address: "172.17.0.1" },
			{ name: "Wi-Fi", address: "192.168.1.10" },
		]);
		expect(ranked[0]?.name).toBe("Wi-Fi");
	});

	it("leaves unknown names in the middle rather than guessing", () => {
		const ranked = rankLanInterfaces([
			{ name: "docker0", address: "172.17.0.1" },
			{ name: "weird9", address: "10.0.0.5" },
			{ name: "en0", address: "192.168.1.10" },
		]);
		expect(ranked.map((i) => i.name)).toEqual(["en0", "weird9", "docker0"]);
	});

	it("is a copy — the caller's array is untouched", () => {
		const input = [
			{ name: "docker0", address: "172.17.0.1" },
			{ name: "en0", address: "192.168.1.10" },
		];
		rankLanInterfaces(input);
		expect(input[0]?.name).toBe("docker0");
	});
});
