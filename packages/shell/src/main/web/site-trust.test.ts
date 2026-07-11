/**
 * Browser-8 — the per-site trust store. Strict-by-default; a trusted origin
 * relaxes the web-privacy posture for pages it's the first party of. Only
 * `trusted: true` rows persist; untrust deletes.
 */

import { describe, expect, it } from "vitest";
import type { SiteTrustGrant } from "../../web-privacy-wire-types";
import { SiteTrustStore, parseSiteTrustGrants } from "./site-trust";

const X = "https://x.com";
const Y = "https://example.com";

describe("SiteTrustStore", () => {
	it("is strict by default — an unknown origin is not trusted", () => {
		const store = new SiteTrustStore();
		expect(store.isTrusted(X)).toBe(false);
	});

	it("trusts an origin and reflects it in isTrusted + list", () => {
		const store = new SiteTrustStore();
		expect(store.set(X, true, 100)).toBe(true);
		expect(store.isTrusted(X)).toBe(true);
		expect(store.isTrusted(Y)).toBe(false);
		expect(store.list()).toEqual([{ origin: X, trusted: true, updatedAt: 100 }]);
	});

	it("untrusting deletes the row (absence = strict default)", () => {
		const store = new SiteTrustStore([{ origin: X, trusted: true, updatedAt: 1 }]);
		expect(store.isTrusted(X)).toBe(true);
		expect(store.set(X, false, 200)).toBe(true); // changed
		expect(store.isTrusted(X)).toBe(false);
		expect(store.list()).toEqual([]);
		expect(store.set(X, false, 300)).toBe(false); // already absent → no change
	});

	it("revokeOrigin drops the trust", () => {
		const store = new SiteTrustStore([{ origin: X, trusted: true, updatedAt: 1 }]);
		expect(store.revokeOrigin(X)).toBe(true);
		expect(store.isTrusted(X)).toBe(false);
		expect(store.revokeOrigin(X)).toBe(false);
	});

	it("seeds only trusted rows and sorts the list by origin", () => {
		const store = new SiteTrustStore([
			{ origin: Y, trusted: true, updatedAt: 2 },
			{ origin: X, trusted: true, updatedAt: 1 },
		]);
		// Sorted by origin: example.com before x.com.
		expect(store.list().map((g) => g.origin)).toEqual([Y, X]);
	});
});

describe("parseSiteTrustGrants", () => {
	it("keeps well-formed trusted rows", () => {
		const rows: SiteTrustGrant[] = [{ origin: X, trusted: true, updatedAt: 5 }];
		expect(parseSiteTrustGrants(rows)).toEqual(rows);
	});

	it("drops malformed rows (bad origin, non-true trusted, bad ts, non-array)", () => {
		expect(parseSiteTrustGrants("nope")).toEqual([]);
		expect(
			parseSiteTrustGrants([
				{ origin: "x.com", trusted: true, updatedAt: 1 }, // bare host, not an origin
				{ origin: X, trusted: false, updatedAt: 1 }, // only true persists
				{ origin: Y, trusted: true, updatedAt: Number.NaN }, // bad ts
				{ origin: X, trusted: true, updatedAt: 9 }, // the one good row
			]),
		).toEqual([{ origin: X, trusted: true, updatedAt: 9 }]);
	});
});
