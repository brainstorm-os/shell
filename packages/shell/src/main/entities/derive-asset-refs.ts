/**
 * `derive-asset-refs` — pure helpers for the implicit asset-ref bind writer
 * (Asset-B4). An entity never lists its assets explicitly; it stores a
 * `brainstorm://asset/<id>` URL in some property (a `Bookmark`'s favicon /
 * cover, an uploaded file's `attachment`, an image embedded in body markdown).
 * The `asset_refs` table — which asset-DEK re-homing (Asset-B1), GC
 * reachability, and sync all read — must therefore be *derived* from those
 * URLs on every property write.
 *
 * This module is the pure half: extract the referenced asset ids from a
 * property bag, and map an asset's `kind` to the ref `role`. No I/O, no clock —
 * the reconcile writer in `entities-service.ts` supplies the DB + local-
 * existence filter (a ref's `asset_id` FK-references a local `assets` row).
 */

import { AssetKind, AssetRefRole } from "../assets/asset-types";

/** The `brainstorm://asset/<id>` URL scheme, anchored to the id segment. The
 *  id charset is the URL-unreserved set (RFC 3986 `unreserved`), which covers
 *  the minted safe-charset asset ids (randomUUID hex + hyphen today) and stops
 *  cleanly at any delimiter — whitespace, a quote, a markdown `)`/`]`, `<`,
 *  `>` — so an id embedded mid-string (an `attachment` field, a body markdown
 *  image) is pulled out without dragging trailing punctuation in. Global so a
 *  single string can carry several. */
const ASSET_URL_RE = /brainstorm:\/\/asset\/([A-Za-z0-9._~-]+)/g;

/** Pull every distinct asset id referenced by a `brainstorm://asset/<id>` URL
 *  anywhere in a property bag. Walks strings (global scan), arrays, and nested
 *  objects; ignores non-string leaves and non-asset URLs. Deduped. Pure. */
export function extractAssetIds(properties: Record<string, unknown>): Set<string> {
	const ids = new Set<string>();
	collect(properties, ids);
	return ids;
}

function collect(value: unknown, ids: Set<string>): void {
	if (typeof value === "string") {
		// `matchAll` needs the regex's lastIndex reset per string; a shared
		// global regex is stateful, so re-run from a fresh iterator each call.
		for (const match of value.matchAll(ASSET_URL_RE)) {
			const id = match[1];
			if (id) ids.add(id);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collect(item, ids);
		return;
	}
	if (value && typeof value === "object") {
		for (const nested of Object.values(value as Record<string, unknown>)) collect(nested, ids);
	}
}

/** Map a stored asset's `kind` to the `role` its owning entity's ref carries.
 *  Favicon/cover are 1:1; an `upload` binds as `inline` (the body-embedded
 *  file/image role — there is no distinct `upload` ref role). */
export function assetRefRoleForKind(kind: AssetKind): AssetRefRole {
	switch (kind) {
		case AssetKind.Favicon:
			return AssetRefRole.Favicon;
		case AssetKind.Cover:
			return AssetRefRole.Cover;
		case AssetKind.Upload:
			return AssetRefRole.Inline;
	}
}
