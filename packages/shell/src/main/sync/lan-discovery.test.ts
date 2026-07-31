import { describe, expect, it } from "vitest";
import {
	LAN_MAX_INSTANCE_NAME,
	LAN_SERVICE_TYPE,
	LanTxtKey,
	buildLanAdvertTxt,
	mintLanInstanceName,
	parseLanAdvert,
} from "./lan-discovery";
import { deriveLanDiscoverySecret } from "./lan-discovery-tag";

const SECRET = deriveLanDiscoverySecret(new Uint8Array(32).fill(3));
const ROGUE = deriveLanDiscoverySecret(new Uint8Array(32).fill(4));
const NOW = 1_800_000_000_000;
const PORT = 51_820;
const ADDRESSES = ["192.168.1.10"];

function advert(overrides: Record<string, unknown> = {}, name = "brainstorm-aabbccdd") {
	return {
		name,
		txt: {
			...buildLanAdvertTxt({ secret: SECRET, port: PORT, addresses: ADDRESSES, nowMs: NOW }),
			...overrides,
		},
	};
}

describe("LAN_SERVICE_TYPE", () => {
	it("is the type the spike measured on the wire", () => {
		expect(LAN_SERVICE_TYPE).toBe("brainstorm-sync");
	});
});

describe("parseLanAdvert", () => {
	it("accepts our own well-formed advert and derives the dial URLs", () => {
		const candidate = parseLanAdvert({ record: advert(), secret: SECRET, nowMs: NOW });
		expect(candidate).not.toBeNull();
		expect(candidate?.port).toBe(PORT);
		expect(candidate?.urls).toEqual(["ws://192.168.1.10:51820"]);
	});

	it("refuses an advert tagged by a different identity — the whole point of the gate", () => {
		const record = {
			name: "brainstorm-deadbeef",
			txt: buildLanAdvertTxt({ secret: ROGUE, port: PORT, addresses: ADDRESSES, nowMs: NOW }),
		};
		expect(parseLanAdvert({ record, secret: SECRET, nowMs: NOW })).toBeNull();
	});

	it("refuses an advert with no tag at all", () => {
		expect(
			parseLanAdvert({ record: advert({ [LanTxtKey.Tag]: "" }), secret: SECRET, nowMs: NOW }),
		).toBeNull();
	});

	it("refuses a tag lifted onto a substituted address", () => {
		const record = advert({ [LanTxtKey.Addresses]: "192.168.1.99" });
		expect(parseLanAdvert({ record, secret: SECRET, nowMs: NOW })).toBeNull();
	});

	it("drops our own advert when we are also browsing", () => {
		expect(
			parseLanAdvert({
				record: advert(),
				secret: SECRET,
				nowMs: NOW,
				ownInstance: "brainstorm-aabbccdd",
			}),
		).toBeNull();
	});

	describe("bounded parsing of untrusted advert fields", () => {
		it.each([
			["non-object record", { record: 42 }],
			["null record", { record: null }],
			["missing name", { record: { txt: advert().txt } }],
			["non-string name", { record: { name: 7, txt: advert().txt } }],
			["empty name", { record: advert({}, "") }],
			["oversized name", { record: advert({}, "x".repeat(LAN_MAX_INSTANCE_NAME + 1)) }],
			["missing txt", { record: { name: "brainstorm-aabbccdd" } }],
			["wrong txt version", { record: advert({ [LanTxtKey.Version]: "2" }) }],
			["non-numeric port", { record: advert({ [LanTxtKey.Port]: "http" }) }],
			["zero port", { record: advert({ [LanTxtKey.Port]: "0" }) }],
			["out-of-range port", { record: advert({ [LanTxtKey.Port]: "70000" }) }],
			["empty address list", { record: advert({ [LanTxtKey.Addresses]: "" }) }],
			[
				"hostname instead of a literal",
				{ record: advert({ [LanTxtKey.Addresses]: "evil.example.com" }) },
			],
			["routable address", { record: advert({ [LanTxtKey.Addresses]: "8.8.8.8" }) }],
			["wildcard address", { record: advert({ [LanTxtKey.Addresses]: "0.0.0.0" }) }],
			[
				"too many addresses",
				{ record: advert({ [LanTxtKey.Addresses]: "10.0.0.1,10.0.0.2,10.0.0.3,10.0.0.4,10.0.0.5" }) },
			],
			["duplicate addresses", { record: advert({ [LanTxtKey.Addresses]: "10.0.0.1,10.0.0.1" }) }],
			[
				"oversized address field",
				{ record: advert({ [LanTxtKey.Addresses]: "10.0.0.1,".repeat(40) }) },
			],
			["non-numeric epoch", { record: advert({ [LanTxtKey.Epoch]: "soon" }) }],
			["negative epoch", { record: advert({ [LanTxtKey.Epoch]: "-1" }) }],
		])("refuses %s", (_label, { record }) => {
			expect(parseLanAdvert({ record, secret: SECRET, nowMs: NOW })).toBeNull();
		});
	});
});

describe("mintLanInstanceName", () => {
	it("is random per boot, so the name is not a tracking handle", () => {
		let n = 0;
		const seq = () => new Uint8Array(8).fill(n++);
		expect(mintLanInstanceName(seq)).not.toBe(mintLanInstanceName(seq));
	});

	it("fits inside the DNS-SD instance-name ceiling", () => {
		const name = mintLanInstanceName(() => new Uint8Array(8).fill(255));
		expect(name.length).toBeLessThanOrEqual(LAN_MAX_INSTANCE_NAME);
	});
});
