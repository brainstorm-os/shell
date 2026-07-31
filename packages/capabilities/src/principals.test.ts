/**
 * Ledger principal kinds (Agent-Teams-1) — agent principals (Ed25519
 * fingerprints) and app principals (bundle ids) must be disjoint value spaces,
 * because uninstall-shaped sweeps (`revokeAllFor`) and the grants UI resolve
 * them differently while the broker's `has()` stays kind-blind.
 */

import { describe, expect, it } from "vitest";
import { PrincipalKind, isAgentPrincipal, principalKindOf } from "./principals";

describe("principals", () => {
	it("classifies a real agent fingerprint as Agent", () => {
		// The exact shape fingerprintPublicKey emits: ed25519:<16 lowercase hex>.
		expect(principalKindOf("ed25519:0123456789abcdef")).toBe(PrincipalKind.Agent);
		expect(isAgentPrincipal("ed25519:0123456789abcdef")).toBe(true);
	});

	it("classifies app bundle ids and the synthetic shell id as App", () => {
		for (const appId of ["io.brainstorm.notes", "io.brainstorm.agent", "shell", "com.example.x"]) {
			expect(principalKindOf(appId)).toBe(PrincipalKind.App);
		}
	});

	it("refuses malformed fingerprints (not hex, wrong prefix, empty tail)", () => {
		for (const bad of [
			"ed25519:",
			"ed25519:XYZ",
			"ed25519:0123456789ABCDEF", // uppercase — never emitted
			"ed25519 0123456789abcdef",
			"x25519:0123456789abcdef",
			"ed25519:short",
		]) {
			expect(isAgentPrincipal(bad)).toBe(false);
			expect(principalKindOf(bad)).toBe(PrincipalKind.App);
		}
	});
});
