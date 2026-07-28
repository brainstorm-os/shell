/**
 * The only place that decides whether the shell opens a listening socket, so
 * every case is enumerated rather than sampled.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_LAN_HOST_MODE,
	LanHostMode,
	parseLanHostMode,
	shouldListenOnLan,
} from "./lan-host-policy";

const state = (over: Partial<Parameters<typeof shouldListenOnLan>[0]> = {}) => ({
	mode: DEFAULT_LAN_HOST_MODE,
	hasSession: true,
	hasSharedEntities: false,
	...over,
});

describe("shouldListenOnLan", () => {
	it("defaults to NOT listening", () => {
		// The feature is inert until someone opts in. This is the shell's first
		// inbound socket in a shipped build; a user who never asked for LAN sync
		// should not be listening on their network.
		expect(DEFAULT_LAN_HOST_MODE).toBe(LanHostMode.Off);
		expect(shouldListenOnLan(state())).toBe(false);
	});

	it("never listens without a session, in ANY mode", () => {
		// No session ⇒ no device roster ⇒ a bound socket could admit nobody. That
		// is pure exposure for zero function, so the session gate precedes the mode.
		for (const mode of Object.values(LanHostMode)) {
			expect(shouldListenOnLan(state({ mode, hasSession: false }))).toBe(false);
			expect(shouldListenOnLan(state({ mode, hasSession: false, hasSharedEntities: true }))).toBe(
				false,
			);
		}
	});

	it("WhenVaultOpen listens with a session, shared or not", () => {
		expect(shouldListenOnLan(state({ mode: LanHostMode.WhenVaultOpen }))).toBe(true);
		expect(
			shouldListenOnLan(state({ mode: LanHostMode.WhenVaultOpen, hasSharedEntities: true })),
		).toBe(true);
	});

	it("WhenShared listens only while something is actually shared", () => {
		expect(shouldListenOnLan(state({ mode: LanHostMode.WhenShared }))).toBe(false);
		expect(shouldListenOnLan(state({ mode: LanHostMode.WhenShared, hasSharedEntities: true }))).toBe(
			true,
		);
	});

	it("Off stays off even with everything else true", () => {
		expect(shouldListenOnLan(state({ mode: LanHostMode.Off, hasSharedEntities: true }))).toBe(false);
	});
});

describe("parseLanHostMode", () => {
	it("round-trips the real modes", () => {
		expect(parseLanHostMode(LanHostMode.WhenVaultOpen)).toBe(LanHostMode.WhenVaultOpen);
		expect(parseLanHostMode(LanHostMode.WhenShared)).toBe(LanHostMode.WhenShared);
		expect(parseLanHostMode(LanHostMode.Off)).toBe(LanHostMode.Off);
	});

	it("falls back to Off on anything unrecognised", () => {
		// A corrupt or hand-edited settings file must not be able to turn the
		// listener ON — the failure direction matters here.
		for (const raw of [undefined, null, "", "yes", true, 1, {}, "WHEN_VAULT_OPEN"]) {
			expect(parseLanHostMode(raw)).toBe(LanHostMode.Off);
		}
	});
});
