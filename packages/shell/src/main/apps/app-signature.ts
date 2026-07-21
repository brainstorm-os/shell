/**
 * Optional manifest-signature verification seam (13.2).
 *
 * Per §Update integrity:
 *
 *   > v1 ships without mandatory app signing (apps may install from local
 *   > packages or URLs). v2 requires signatures.
 *
 * So v1's posture is **advisory / fail-open-with-warning**, NOT enforce-block:
 * an unsigned app installs normally; a signed app is verified against the
 * configured trusted keys and the outcome is *recorded* on the registry row,
 * but a bad/untrusted signature does not (yet) block install. Enforcement is a
 * one-flag flip later — `shouldBlockInstall(status, { enforce: true })` is the
 * single chokepoint that turns the recorded status into a hard reject.
 *
 * The signature itself is Ed25519 over the **canonical manifest bytes with the
 * `signature` field removed** (so the signature can't sign over itself). The
 * signer publishes a `keyId`; the shell resolves it against a `TrustedAppKeys`
 * registry of Ed25519 public keys. Verify-only — this module never touches a
 * private key and never imports keystore/keyring APIs (crypto-routing rule:
 * only `main/credentials/` may). It uses the same `ed25519Verify` from
 * `@brainstorm-os/native` the sync envelope verifier uses.
 */

import { ed25519Verify } from "@brainstorm-os/native";

/** Outcome of checking a manifest's signature. Recorded on the `apps` row as a
 *  string (the enum values ARE the wire format). */
export enum AppSignatureStatus {
	/** No `signature` field on the manifest — the common v1 case. */
	Unsigned = "unsigned",
	/** Signature present + matched a trusted key. */
	Verified = "verified",
	/** Signature present but its `keyId` isn't in the trusted-key registry. */
	Untrusted = "untrusted",
	/** Signature present + key trusted, but the Ed25519 check failed (tamper,
	 *  wrong key, malformed signature). */
	Invalid = "invalid",
}

/** A manifest's embedded signature block (optional). `value` is base64 of the
 *  64-byte Ed25519 signature; `keyId` names the signer's public key. */
export type ManifestSignature = {
	alg: "ed25519";
	keyId: string;
	value: string;
};

/** Trusted Ed25519 verification keys, keyed by signer `keyId`. Verify-only —
 *  raw 32-byte public keys, never a private key. An empty registry means "no
 *  signer is trusted yet", so every signed manifest reads `Untrusted`. */
export type TrustedAppKeys = ReadonlyMap<string, Uint8Array>;

export type SignatureVerification = {
	status: AppSignatureStatus;
	/** The signer key id, when the manifest carried a signature. */
	keyId?: string;
	/** Advisory human-readable note (logged; never thrown). */
	detail?: string;
};

/** Pull the `signature` block off a manifest object if present + well-shaped.
 *  A malformed signature block is treated as *absent* (Unsigned) rather than
 *  Invalid — a garbage field shouldn't be more punishing than no field, and
 *  the manifest validator already gates structural shape elsewhere. */
export function extractManifestSignature(manifest: unknown): ManifestSignature | null {
	if (!manifest || typeof manifest !== "object") return null;
	const sig = (manifest as Record<string, unknown>).signature;
	if (!sig || typeof sig !== "object") return null;
	const s = sig as Record<string, unknown>;
	if (s.alg !== "ed25519") return null;
	if (typeof s.keyId !== "string" || s.keyId.length === 0) return null;
	if (typeof s.value !== "string" || s.value.length === 0) return null;
	return { alg: "ed25519", keyId: s.keyId, value: s.value };
}

/**
 * Canonical bytes a manifest signature covers: the manifest JSON with the
 * `signature` field stripped, serialized with **sorted keys** so re-ordering
 * fields in the on-disk JSON can't change what was signed. UTF-8 encoded.
 *
 * The signer computes the identical bytes (strip `signature`, canonical-sort,
 * UTF-8) and signs them; the verifier recomputes here.
 */
export function canonicalManifestBytes(manifest: unknown): Uint8Array {
	const stripped =
		manifest && typeof manifest === "object"
			? (() => {
					const { signature: _signature, ...rest } = manifest as Record<string, unknown>;
					return rest;
				})()
			: manifest;
	return new TextEncoder().encode(canonicalJson(stripped));
}

/** Deterministic JSON: object keys sorted recursively. Arrays keep order. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const body = keys
		.filter((k) => obj[k] !== undefined)
		.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
		.join(",");
	return `{${body}}`;
}

/**
 * Verify a manifest's optional signature against the trusted-key registry.
 * Total — never throws (a malformed base64 / signature reads as `Invalid`,
 * not an exception), so the install path stays fail-open. The *recording* of
 * the result is the caller's job; `shouldBlockInstall` is the (currently
 * always-off) enforcement gate.
 */
export function verifyManifestSignature(
	manifest: unknown,
	trustedKeys: TrustedAppKeys,
): SignatureVerification {
	const sig = extractManifestSignature(manifest);
	if (!sig) return { status: AppSignatureStatus.Unsigned };

	const key = trustedKeys.get(sig.keyId);
	if (!key) {
		return {
			status: AppSignatureStatus.Untrusted,
			keyId: sig.keyId,
			detail: `no trusted key for signer ${sig.keyId}`,
		};
	}

	let signatureBytes: Uint8Array;
	try {
		signatureBytes = base64ToBytes(sig.value);
	} catch {
		return {
			status: AppSignatureStatus.Invalid,
			keyId: sig.keyId,
			detail: "signature value is not valid base64",
		};
	}

	try {
		const ok = ed25519Verify(key, canonicalManifestBytes(manifest), signatureBytes);
		return ok
			? { status: AppSignatureStatus.Verified, keyId: sig.keyId }
			: {
					status: AppSignatureStatus.Invalid,
					keyId: sig.keyId,
					detail: "Ed25519 signature check failed",
				};
	} catch (error) {
		return {
			status: AppSignatureStatus.Invalid,
			keyId: sig.keyId,
			detail: `Ed25519 verify threw: ${(error as Error).message}`,
		};
	}
}

/**
 * The single enforcement chokepoint. v1 ships with `enforce: false` everywhere,
 * so this returns `false` (never blocks) regardless of status — install is
 * advisory. Flipping `enforce` to `true` (v2) makes a present-but-bad signature
 * (`Untrusted` / `Invalid`) block install; `Unsigned` and `Verified` always
 * pass (an unsigned local app is still installable even under enforcement —
 * mandatory-signing is a separate, stricter policy than reject-bad-signature).
 */
export function shouldBlockInstall(
	status: AppSignatureStatus,
	policy: { enforce: boolean },
): boolean {
	if (!policy.enforce) return false;
	return status === AppSignatureStatus.Untrusted || status === AppSignatureStatus.Invalid;
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
