/**
 * 10.3c — the multi-device wrap fan-out producer.
 *
 * 10.3b built the RECEIVER and never a producer, so nothing in production ever
 * wrapped an entity DEK for a paired device: two of one user's own devices
 * have never synced a single entity. These tests pin the producer's rules,
 * every one of which is a real trap the rung's design named.
 */

import { describe, expect, it, vi } from "vitest";
import { PLACEHOLDER_DEK_VERSION, fanOutEntityWrap, planWrapFanout } from "./wrap-fanout";

const SELF = "self-ed25519-pub";
const OTHER = "other-ed25519-pub";

function device(ed: string, x?: string) {
	return x === undefined ? { deviceEd25519Pub: ed } : { deviceEd25519Pub: ed, deviceX25519Pub: x };
}

describe("planWrapFanout", () => {
	it("never wraps for this device — it already holds the DEK", () => {
		const plan = planWrapFanout([device(SELF, "self-x"), device(OTHER, "other-x")], SELF);
		expect(plan.map((d) => d.deviceEd25519Pub)).toEqual([OTHER]);
	});

	it("skips a device with no X25519 key — there is nothing to seal to", () => {
		const plan = planWrapFanout([device(SELF, "self-x"), device(OTHER)], SELF);
		expect(plan).toEqual([]);
	});

	it("skips a device whose X25519 key is empty rather than absent", () => {
		const plan = planWrapFanout([device(SELF, "self-x"), device(OTHER, "")], SELF);
		expect(plan).toEqual([]);
	});

	it("returns nothing for a single-device identity", () => {
		expect(planWrapFanout([device(SELF, "self-x")], SELF)).toEqual([]);
	});
});

describe("fanOutEntityWrap", () => {
	function deps(overrides: Partial<Parameters<typeof fanOutEntityWrap>[0]> = {}) {
		const emitted: Array<{ entityId: string; route: string; recipient: string }> = [];
		return {
			emitted,
			args: {
				entityId: "ent_1",
				dek: new Uint8Array(32).fill(7),
				version: 3,
				type: "brainstorm/Note/v1",
				devices: [device(SELF, "self-x"), device(OTHER, "other-x")],
				selfDeviceEd25519Pub: SELF,
				identityRoute: "inbox:identity-pub",
				wrapFor: (_dek: Uint8Array, recipientPubB64: string) => ({ recipientPubB64 }),
				emit: async (entityId: string, wrap: { recipientPubB64: string }, route: string) => {
					emitted.push({ entityId, route, recipient: wrap.recipientPubB64 });
				},
				...overrides,
			} as Parameters<typeof fanOutEntityWrap>[0],
		};
	}

	it("seals one wrap per sibling device and routes it to the identity inbox", async () => {
		const { args, emitted } = deps();
		const result = await fanOutEntityWrap(args);
		expect(result.sent).toBe(1);
		expect(emitted).toEqual([
			{ entityId: "ent_1", route: "inbox:identity-pub", recipient: "other-x" },
		]);
	});

	it("REFUSES to fan out a placeholder DEK — version 0 loses to every real wrap", async () => {
		const { args, emitted } = deps({ version: PLACEHOLDER_DEK_VERSION });
		const result = await fanOutEntityWrap(args);
		expect(result.sent).toBe(0);
		expect(result.refused).toBe("placeholder-dek");
		expect(emitted).toEqual([]);
	});

	it("refuses any non-positive ordinal, not just the placeholder constant", async () => {
		const { args } = deps({ version: -1 });
		expect((await fanOutEntityWrap(args)).refused).toBe("placeholder-dek");
	});

	it("keeps going when one device's emit fails, and reports the failure", async () => {
		const failing = vi.fn(async (_id: string, wrap: { recipientPubB64: string }) => {
			if (wrap.recipientPubB64 === "b-x") throw new Error("relay down");
		});
		const { args } = deps({
			devices: [device(SELF, "self-x"), device("a", "a-x"), device("b", "b-x"), device("c", "c-x")],
			emit: failing,
		});
		const result = await fanOutEntityWrap(args);
		expect(result.sent).toBe(2);
		expect(result.failed).toEqual(["b"]);
	});

	it("is a no-op with no siblings rather than an error", async () => {
		const { args, emitted } = deps({ devices: [device(SELF, "self-x")] });
		const result = await fanOutEntityWrap(args);
		expect(result.sent).toBe(0);
		expect(result.refused).toBeUndefined();
		expect(emitted).toEqual([]);
	});
});
