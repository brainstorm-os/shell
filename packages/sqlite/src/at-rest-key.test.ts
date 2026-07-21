import { describe, expect, it } from "vitest";
import {
	AT_REST_KEY_BYTES,
	AtRestDb,
	atRestInfoString,
	deriveAtRestKey,
	keyToHex,
	zeroKey,
} from "./at-rest-key";

const MASTER = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

describe("at-rest key derivation", () => {
	it("derives a 32-byte key for each DB", () => {
		for (const db of Object.values(AtRestDb)) {
			const k = deriveAtRestKey(MASTER, db);
			expect(k).toBeInstanceOf(Uint8Array);
			expect(k.length).toBe(AT_REST_KEY_BYTES);
		}
	});

	it("is deterministic — same master + db ⇒ same key (returning user)", () => {
		const a = keyToHex(deriveAtRestKey(MASTER, AtRestDb.Entities));
		const b = keyToHex(deriveAtRestKey(new Uint8Array(MASTER), AtRestDb.Entities));
		expect(a).toBe(b);
	});

	it("domain-separates: every DB gets a distinct key", () => {
		const hexes = Object.values(AtRestDb).map((db) => keyToHex(deriveAtRestKey(MASTER, db)));
		expect(new Set(hexes).size).toBe(hexes.length);
	});

	it("changes when the master key changes", () => {
		const other = new Uint8Array(32).fill(9);
		expect(keyToHex(deriveAtRestKey(MASTER, AtRestDb.Ledger))).not.toBe(
			keyToHex(deriveAtRestKey(other, AtRestDb.Ledger)),
		);
	});

	it("rejects a non-32-byte master key", () => {
		expect(() => deriveAtRestKey(new Uint8Array(16), AtRestDb.Search)).toThrow(/32-byte/);
		expect(() => deriveAtRestKey("nope" as unknown as Uint8Array, AtRestDb.Search)).toThrow();
	});

	it("info string is versioned + per-db", () => {
		expect(atRestInfoString(AtRestDb.Registry)).toBe("registry.db at-rest v1");
		expect(atRestInfoString(AtRestDb.Search)).toBe("search.db at-rest v1");
	});

	it("hex form is 64 lowercase hex chars", () => {
		const k = deriveAtRestKey(MASTER, AtRestDb.Registry);
		expect(keyToHex(k)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("zeroKey wipes the buffer", () => {
		const k = deriveAtRestKey(MASTER, AtRestDb.Ledger);
		expect(k.some((b) => b !== 0)).toBe(true);
		zeroKey(k);
		expect(k.every((b) => b === 0)).toBe(true);
	});
});
