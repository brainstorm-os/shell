import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../credentials/crypto";
import { type DeviceX25519Keypair, generateDeviceX25519 } from "../credentials/device-x25519";
import { unwrapDekForRecipient } from "../credentials/member-wraps";
import { AccessRole, type ResolvedMember } from "./access-record";
import { rewrapDekForSurvivors } from "./survivor-rewrap";

const ENT = "ent_rot_1";

function member(over: Partial<ResolvedMember> & { device?: DeviceX25519Keypair }): ResolvedMember {
	const { device, ...rest } = over;
	return {
		member: rest.member ?? `user_${Math.random().toString(36).slice(2, 8)}`,
		x25519: device ? bytesToBase64(device.publicKey) : null,
		role: AccessRole.Editor,
		addedBy: "owner",
		addedAt: 1000,
		revokedAt: null,
		revokedBy: null,
		grantValid: true,
		revokeValid: false,
		active: true,
		...rest,
	};
}

function dek32(seed: number): Uint8Array {
	return new Uint8Array(32).fill(seed);
}

/** First element or throw — stands in for a non-null assertion (biome bans `!`). */
function first<T>(xs: readonly T[]): T {
	const [head] = xs;
	if (head === undefined) throw new Error("expected a non-empty array");
	return head;
}

describe("rewrapDekForSurvivors (ROT-1)", () => {
	it("wraps DEK′ for every active survivor with a device key", () => {
		const a = generateDeviceX25519();
		const b = generateDeviceX25519();
		const { wraps, skipped } = rewrapDekForSurvivors(
			dek32(7),
			2,
			[member({ member: "alice", device: a }), member({ member: "bob", device: b })],
			ENT,
		);
		expect(wraps.map((w) => w.member).sort()).toEqual(["alice", "bob"]);
		expect(skipped).toEqual([]);
	});

	it("NEVER wraps for a revoked (inactive) member — the forward-secrecy guarantee", () => {
		const survivor = generateDeviceX25519();
		const revoked = generateDeviceX25519();
		const { wraps } = rewrapDekForSurvivors(
			dek32(9),
			2,
			[
				member({ member: "survivor", device: survivor }),
				// The revoked member's row is present but inactive (revokeAccess set it).
				member({ member: "revoked", device: revoked, active: false, revokedAt: 2000 }),
			],
			ENT,
		);
		expect(wraps.map((w) => w.member)).toEqual(["survivor"]);
		expect(wraps.some((w) => w.member === "revoked")).toBe(false);
	});

	it("a survivor's wrap opens to DEK′ with their device secret", () => {
		const device = generateDeviceX25519();
		const newDek = dek32(11);
		const { wraps } = rewrapDekForSurvivors(newDek, 2, [member({ member: "alice", device })], ENT);
		const opened = unwrapDekForRecipient(first(wraps).wrap, device.secretKey, ENT);
		expect([...opened]).toEqual([...newDek]);
	});

	it("the revoked member's device secret CANNOT open any survivor wrap", () => {
		const survivor = generateDeviceX25519();
		const revoked = generateDeviceX25519();
		const { wraps } = rewrapDekForSurvivors(
			dek32(13),
			2,
			[
				member({ member: "survivor", device: survivor }),
				member({ member: "revoked", device: revoked, active: false }),
			],
			ENT,
		);
		// The only wrap is the survivor's; the revoked device key can't unseal it.
		expect(() => unwrapDekForRecipient(first(wraps).wrap, revoked.secretKey, ENT)).toThrow();
	});

	it("reports survivors with no device key as skipped (pre-collection-sharing grants)", () => {
		const withKey = generateDeviceX25519();
		const { wraps, skipped } = rewrapDekForSurvivors(
			dek32(15),
			2,
			[
				member({ member: "hasKey", device: withKey }),
				member({ member: "noKey" }), // x25519 = null
			],
			ENT,
		);
		expect(wraps.map((w) => w.member)).toEqual(["hasKey"]);
		expect(skipped).toEqual(["noKey"]);
	});

	it("de-duplicates by device key (one wrap per distinct recipient)", () => {
		const shared = generateDeviceX25519();
		const { wraps } = rewrapDekForSurvivors(
			dek32(17),
			2,
			[
				member({ member: "deviceA", device: shared }),
				member({ member: "deviceA-again", device: shared }),
			],
			ENT,
		);
		expect(wraps).toHaveLength(1);
	});

	it("binds the wrap to the entity id (a wrap for one entity won't open under another)", () => {
		const device = generateDeviceX25519();
		const { wraps } = rewrapDekForSurvivors(dek32(19), 2, [member({ member: "a", device })], ENT);
		expect(() => unwrapDekForRecipient(first(wraps).wrap, device.secretKey, "ent_other")).toThrow();
	});
});
