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

	// Synthetic machines. The first column is what the OS enumerated, in the
	// order it enumerated it; the second is the address the listener must bind.
	it.each<[string, [string, string][], string]>([
		[
			"Linux laptop with Docker enumerated first",
			[
				["docker0", "172.17.0.1"],
				["br-4f2a9c", "172.18.0.1"],
				["wlp3s0", "192.168.1.23"],
			],
			"192.168.1.23",
		],
		[
			"macOS with a VPN tunnel ahead of Wi-Fi",
			[
				["utun4", "10.8.0.2"],
				["en0", "192.168.1.10"],
				["bridge100", "192.168.64.1"],
			],
			"192.168.1.10",
		],
		[
			"Windows with Hyper-V, WSL and a VPN client",
			[
				["vEthernet (Default Switch)", "172.28.112.1"],
				["vEthernet (WSL)", "172.22.0.1"],
				["Corp VPN", "10.20.0.7"],
				["Wi-Fi", "192.168.0.14"],
			],
			"192.168.0.14",
		],
		[
			"Ethernet that failed DHCP beside working Wi-Fi",
			[
				["en5", "169.254.20.3"],
				["en0", "192.168.1.10"],
			],
			"192.168.1.10",
		],
		[
			"Wi-Fi and Ethernet both up: OS order decides between equals",
			[
				["en0", "192.168.1.10"],
				["en7", "192.168.1.11"],
			],
			"192.168.1.10",
		],
		[
			"a USB Ethernet dongle with a MAC-derived name",
			[
				["tailscale0", "10.64.0.3"],
				["enx00e04c680001", "192.168.5.9"],
			],
			"192.168.5.9",
		],
		[
			"containers only: a wrong-but-explainable choice beats none",
			[
				["podman0", "10.88.0.1"],
				["cni0", "10.244.0.1"],
			],
			"10.88.0.1",
		],
		[
			"an unknown adapter still beats a known overlay",
			[
				["wg0", "10.9.0.2"],
				["weird9", "10.0.0.5"],
			],
			"10.0.0.5",
		],
		[
			"only link-local anywhere",
			[
				["utun2", "169.254.9.9"],
				["en0", "169.254.1.1"],
			],
			"169.254.1.1",
		],
	])("%s", (_machine, enumerated, expected) => {
		const ranked = rankLanInterfaces(enumerated.map(([name, address]) => ({ name, address })));
		expect(ranked[0]?.address).toBe(expected);
		expect(ranked).toHaveLength(enumerated.length);
	});

	it("an empty enumeration (an IPv6-only network) ranks to nothing", () => {
		expect(rankLanInterfaces([])).toEqual([]);
	});
});
