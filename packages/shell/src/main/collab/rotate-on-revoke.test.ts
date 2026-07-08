import { describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../credentials/crypto";
import { type DeviceX25519Keypair, generateDeviceX25519 } from "../credentials/device-x25519";
import { AccessRole, type ResolvedMember } from "./access-record";
import { type RotateOnRevokePorts, rotateOnRevoke } from "./rotate-on-revoke";

const ENT = "ent_rot_2";

function member(over: Partial<ResolvedMember> & { device?: DeviceX25519Keypair }): ResolvedMember {
	const { device, ...rest } = over;
	return {
		member: rest.member ?? "m",
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

/** A DEK′ the mint port hands out; a recognizable non-zero fill. */
function mintedDek(): Uint8Array {
	return new Uint8Array(32).fill(0x5a);
}

function ports(
	over: Partial<RotateOnRevokePorts> & { calls?: string[] } = {},
): RotateOnRevokePorts {
	const calls = over.calls ?? [];
	const survivor = generateDeviceX25519();
	const revoked = generateDeviceX25519();
	return {
		mintDek: vi.fn(() => {
			calls.push("mint");
			return { dek: mintedDek(), dekId: "dek2" };
		}),
		currentMembers: () => [
			member({ member: "survivor", device: survivor }),
			member({ member: "revoked", device: revoked, active: false, revokedAt: 2000 }),
		],
		publishWraps: vi.fn(async () => {
			calls.push("publish");
		}),
		reSealSnapshot: vi.fn(async () => {
			calls.push("reseal");
		}),
		rotate: vi.fn(async () => {
			calls.push("rotate");
		}),
		...over,
	};
}

describe("rotateOnRevoke (ROT-2)", () => {
	it("runs the choreography in the fail-closed order: mint → publish → reseal → rotate", async () => {
		const calls: string[] = [];
		const result = await rotateOnRevoke(ENT, ports({ calls }));
		expect(calls).toEqual(["mint", "publish", "reseal", "rotate"]);
		expect(result.rewrapped).toBe(1); // the one survivor
		expect(result.skipped).toEqual([]);
	});

	it("publishes wraps ONLY for the survivor, and rotates with the freshly-minted DEK", async () => {
		let publishedTo: string[] = [];
		let rotatedDek: Uint8Array | null = null;
		const p = ports({
			publishWraps: async (_e, wraps) => {
				publishedTo = wraps.map((w) => w.member);
			},
			rotate: async (_e, dek) => {
				rotatedDek = new Uint8Array(dek); // copy before the orchestrator zeroes it
			},
		});
		await rotateOnRevoke(ENT, p);
		expect(publishedTo).toEqual(["survivor"]);
		expect(rotatedDek).not.toBeNull();
		expect([...(rotatedDek as unknown as Uint8Array)]).toEqual([...mintedDek()]);
	});

	it("zeroes the in-memory DEK′ after the rotation completes", async () => {
		let dekRef: Uint8Array | null = null;
		const p = ports({
			mintDek: () => {
				dekRef = mintedDek();
				return { dek: dekRef, dekId: "dek2" };
			},
		});
		await rotateOnRevoke(ENT, p);
		expect(dekRef).not.toBeNull();
		expect((dekRef as unknown as Uint8Array).every((b) => b === 0)).toBe(true);
	});

	it("is fail-closed: if the coordinator throws, the DEK is still persisted (minted) and zeroed", async () => {
		let minted = false;
		let dekRef: Uint8Array | null = null;
		const p = ports({
			mintDek: () => {
				minted = true;
				dekRef = mintedDek();
				return { dek: dekRef, dekId: "dek2" };
			},
			rotate: async () => {
				throw new Error("node denied the re-home");
			},
		});
		await expect(rotateOnRevoke(ENT, p)).rejects.toThrow("node denied");
		expect(minted).toBe(true); // DEK′ persisted before the failing flip → retry converges
		expect((dekRef as unknown as Uint8Array).every((b) => b === 0)).toBe(true); // still zeroed
	});

	it("does NOT flip the wire if publishing wraps fails (survivors must get DEK′ first)", async () => {
		const calls: string[] = [];
		const p = ports({
			calls,
			publishWraps: async () => {
				calls.push("publish");
				throw new Error("emit failed");
			},
		});
		await expect(rotateOnRevoke(ENT, p)).rejects.toThrow("emit failed");
		expect(calls).toEqual(["mint", "publish"]); // never reached reseal/rotate
	});

	it("surfaces survivors with no device key via onSkipped and still rotates", async () => {
		const onSkipped = vi.fn();
		const survivor = generateDeviceX25519();
		const p = ports({
			onSkipped,
			currentMembers: () => [
				member({ member: "survivor", device: survivor }),
				member({ member: "keyless" }), // no x25519
			],
		});
		const result = await rotateOnRevoke(ENT, p);
		expect(onSkipped).toHaveBeenCalledWith(ENT, ["keyless"]);
		expect(result.skipped).toEqual(["keyless"]);
		expect(result.rewrapped).toBe(1);
	});

	it("seals the wrap type when entityType is provided", async () => {
		const survivor = generateDeviceX25519();
		const entityType = vi.fn(() => "brainstorm/Note/v1");
		const p = ports({
			entityType,
			currentMembers: () => [member({ member: "survivor", device: survivor })],
		});
		await rotateOnRevoke(ENT, p);
		expect(entityType).toHaveBeenCalledWith(ENT);
	});
});
