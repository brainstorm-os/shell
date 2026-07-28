/**
 * Pure resolution for the `brainstorm://asset/<id>` protocol branch: validate
 * the id, decrypt-and-fetch via the `AssetStore`, and fail closed. Extracted
 * from the Electron protocol handler so the validation + fail-closed posture
 * is unit-testable without a live `protocol.handle`.
 *
 * Access posture (A-boundary): an active (unlocked) vault session is the gate
 * — without the master key nothing decrypts, so a locked/absent vault serves
 * nothing. This matches the existing `cover` / `app-file` handlers, which
 * serve any vault image to any renderer. Tighter owner-graph access
 * enforcement (an app must hold `entities.read` for a referencing entity) is
 * the fuller-subsystem hardening tracked in OQ-237.
 */

/** A randomUUID asset id: 36 chars, lowercase hex + hyphens. Rejects path
 *  separators, `..`, and uppercase — no traversal reaches the store. */
const ASSET_ID_RE = /^[0-9a-f-]{36}$/;

/** Asset-B4b — the `?tier=` values a `brainstorm://asset/` request may name.
 *  `thumb` prefers the parent's derived preview (eager tier) and falls back
 *  to the full blob; absent/unknown serves the full blob. */
export enum AssetServeTier {
	Thumb = "thumb",
}

export type AssetReader = {
	readAsset(assetId: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
};

export type AssetServeResult =
	| { ok: true; mime: string; bytes: Uint8Array }
	| { ok: false; status: 400 | 404 };

export async function resolveAssetForServe(
	store: AssetReader,
	rawAssetId: string,
): Promise<AssetServeResult> {
	if (!ASSET_ID_RE.test(rawAssetId)) return { ok: false, status: 400 };
	try {
		const asset = await store.readAsset(rawAssetId);
		if (!asset) return { ok: false, status: 404 };
		return { ok: true, mime: asset.mime, bytes: asset.bytes };
	} catch {
		// Fail closed: a tampered blob / wrong key / inconsistent row must
		// never leak a partial or error-distinguishable response.
		return { ok: false, status: 404 };
	}
}
