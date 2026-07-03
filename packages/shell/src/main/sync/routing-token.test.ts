/**
 * Stage 10.11 — routing-token derivation + table (OQ-197).
 *
 * The derivation is the privacy boundary: deterministic across devices that
 * share the DEK, unlinkable without it, rotating with it. The table is the
 * client's resolve surface, including the grace-window previous generation.
 */

import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import { ROUTING_TOKEN_BYTES, RoutingTokenTable, deriveRoutingToken } from "./routing-token";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("deriveRoutingToken", () => {
	it("is deterministic — same DEK + entity id give the same token", () => {
		const dek = generateSymmetricKey();
		expect(deriveRoutingToken(dek, "ent_a")).toBe(deriveRoutingToken(dek, "ent_a"));
	});

	it("is base64url of the pinned output width", () => {
		const token = deriveRoutingToken(generateSymmetricKey(), "ent_a");
		expect(token).toMatch(BASE64URL);
		expect(Buffer.from(token, "base64url").length).toBe(ROUTING_TOKEN_BYTES);
	});

	it("never equals the raw entity id (the whole point)", () => {
		for (let i = 0; i < 32; i++) {
			const entityId = `ent_${i}`;
			expect(deriveRoutingToken(generateSymmetricKey(), entityId)).not.toBe(entityId);
		}
	});

	it("64-pass property: distinct (dek, entityId) pairs yield distinct tokens", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 32; i++) {
			const dek = generateSymmetricKey();
			for (const entityId of [`ent_${i}_x`, `ent_${i}_y`]) {
				const token = deriveRoutingToken(dek, entityId);
				expect(seen.has(token)).toBe(false);
				seen.add(token);
			}
		}
		expect(seen.size).toBe(64);
	});

	it("rotating the DEK rotates the token; the old one is not derivable from the new", () => {
		const oldDek = generateSymmetricKey();
		const newDek = generateSymmetricKey();
		expect(deriveRoutingToken(oldDek, "ent_a")).not.toBe(deriveRoutingToken(newDek, "ent_a"));
	});

	it("rejects an empty DEK and an empty entity id", () => {
		expect(() => deriveRoutingToken(new Uint8Array(0), "ent_a")).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
		expect(() => deriveRoutingToken(generateSymmetricKey(), "")).toThrowError(
			expect.objectContaining({ name: "Invalid" }),
		);
	});
});

describe("RoutingTokenTable", () => {
	it("install → tokenFor/resolve round-trip; isTokenFor binds token ↔ entity", () => {
		const table = new RoutingTokenTable();
		const dek = generateSymmetricKey();
		const token = table.install("ent_a", dek);
		expect(table.tokenFor("ent_a")).toBe(token);
		expect(table.resolve(token)).toBe("ent_a");
		expect(table.isTokenFor(token, "ent_a")).toBe(true);
		expect(table.isTokenFor(token, "ent_b")).toBe(false);
		expect(table.resolve("unknown")).toBeNull();
	});

	it("re-installing the same DEK is a no-op (no phantom rotation)", () => {
		const table = new RoutingTokenTable();
		const dek = generateSymmetricKey();
		const token = table.install("ent_a", dek);
		expect(table.install("ent_a", dek)).toBe(token);
		expect(table.previousTokenFor("ent_a")).toBeNull();
	});

	it("installing a NEW DEK rotates: previous token stays resolvable for grace", () => {
		const table = new RoutingTokenTable();
		const oldToken = table.install("ent_a", generateSymmetricKey());
		const newToken = table.install("ent_a", generateSymmetricKey());
		expect(newToken).not.toBe(oldToken);
		expect(table.tokenFor("ent_a")).toBe(newToken);
		expect(table.previousTokenFor("ent_a")).toBe(oldToken);
		// BOTH generations resolve during grace (late frames from unflipped peers).
		expect(table.resolve(newToken)).toBe("ent_a");
		expect(table.resolve(oldToken)).toBe("ent_a");
		expect(table.isTokenFor(oldToken, "ent_a")).toBe(true);
	});

	it("a second rotation drops the oldest generation (exactly one previous kept)", () => {
		const table = new RoutingTokenTable();
		const t1 = table.install("ent_a", generateSymmetricKey());
		const t2 = table.install("ent_a", generateSymmetricKey());
		const t3 = table.install("ent_a", generateSymmetricKey());
		expect(table.resolve(t1)).toBeNull();
		expect(table.resolve(t2)).toBe("ent_a");
		expect(table.resolve(t3)).toBe("ent_a");
		expect(table.previousTokenFor("ent_a")).toBe(t2);
	});

	it("endGrace drops the previous generation only", () => {
		const table = new RoutingTokenTable();
		const oldToken = table.install("ent_a", generateSymmetricKey());
		const newToken = table.install("ent_a", generateSymmetricKey());
		table.endGrace("ent_a");
		expect(table.resolve(oldToken)).toBeNull();
		expect(table.resolve(newToken)).toBe("ent_a");
		expect(table.previousTokenFor("ent_a")).toBeNull();
		// Idempotent.
		table.endGrace("ent_a");
		expect(table.resolve(newToken)).toBe("ent_a");
	});

	it("remove forgets every generation; clear empties the table", () => {
		const table = new RoutingTokenTable();
		const oldToken = table.install("ent_a", generateSymmetricKey());
		const newToken = table.install("ent_a", generateSymmetricKey());
		const otherToken = table.install("ent_b", generateSymmetricKey());
		table.remove("ent_a");
		expect(table.tokenFor("ent_a")).toBeNull();
		expect(table.resolve(oldToken)).toBeNull();
		expect(table.resolve(newToken)).toBeNull();
		expect(table.resolve(otherToken)).toBe("ent_b");
		table.clear();
		expect(table.resolve(otherToken)).toBeNull();
	});
});
