/**
 * Constant-time webhook-secret comparison (11b.8). Shared by every ingress
 * plane (loopback listener, relay client) so the secret check is identical and
 * timing-safe everywhere — a webhook endpoint that leaks a byte-by-byte timing
 * oracle would let a local process brute-force the secret.
 */

import { timingSafeEqual } from "node:crypto";

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
