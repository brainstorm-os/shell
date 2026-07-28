/**
 * Constant-time webhook-secret comparison (11b.8). Shared by every ingress
 * plane (loopback listener, relay client) so the secret check is identical and
 * timing-safe everywhere — a webhook endpoint that leaks a byte-by-byte timing
 * oracle would let a local process brute-force the secret.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { WebhookRoute } from "./automations-host";

/** True iff `provided` equals `expected`, compared in constant time. A length
 *  mismatch returns false immediately (timingSafeEqual requires equal-length
 *  buffers) — the secret is fixed-length per route, so length is not itself a
 *  useful oracle. */
export function webhookSecretMatches(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Connector-6 — verify `provided` against a hex SHA-256 digest (hash-only
 *  at-rest custody: registry.db never holds the plaintext, so an offline read
 *  of the DB cannot recover a live endpoint secret). Hashing the presented
 *  value first means the comparison runs over fixed-length digests —
 *  constant-time by construction. */
export function webhookSecretMatchesSha256(provided: string, expectedHex: string): boolean {
	const digest = createHash("sha256").update(provided, "utf8").digest();
	const expected = Buffer.from(expectedHex, "hex");
	if (expected.length !== digest.length) return false;
	return timingSafeEqual(digest, expected);
}

/** Verify a presented secret against a route's custody form. A route with
 *  neither verifier authenticates nothing — fail-closed. */
export function webhookRouteSecretMatches(provided: string, route: WebhookRoute): boolean {
	if (route.secret !== undefined) return webhookSecretMatches(provided, route.secret);
	if (route.secretSha256 !== undefined)
		return webhookSecretMatchesSha256(provided, route.secretSha256);
	return false;
}
