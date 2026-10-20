/**
 * `entityToPreviewFile(entity)` — the missing link between a bare
 * `intent.open` / `quick-look` and a renderable surface.
 *
 * The shell's only *guaranteed* delivery on a fresh Preview launch is the
 * handshake `LaunchContext = { reason: "open-entity", entityId }` — no
 * MIME, no URL, no sibling list (those ride the `app:intent` push, which
 * the bus only fires when Preview was *already* running). So with just an
 * id, Preview must resolve the file itself: it holds `entities.read:*`
 * and calls `entities.get(id)`, then this pure function turns the row
 * into the `PreviewFile` the host already knows how to mount.
 *
 * A `brainstorm/File/v1` row from the Files app carries `{ name, mime,
 * size, assetId, assetMime }` — its bytes live in the shell asset store,
 * served at `brainstorm://asset/<assetId>`. Other producers may instead
 * carry a ready `attachment` URL. Either way the URL survives the bridge
 * (bytes never cross structured clone); a row with no usable URL or MIME
 * resolves to `null` and the host shows its honest "no preview" pane
 * rather than a broken surface.
 *
 * Kept DOM-free + framework-free so the resolution branch is unit-tested
 * without a renderer or a live bridge.
 */

import type { PreviewFile } from "../demo/dataset";

/** The subset of an `entities.get` row this resolver reads. Matches the
 *  SDK `Entity` shape (`{ id, type, properties }`) without taking a
 *  cross-package type dependency — the bridge return is structurally
 *  typed and the only fields that matter are these. */
export type ResolvableEntity = {
	id?: unknown;
	/** The envelope's own modification time. A `File/v1` row from Files
	 *  carries recency HERE, not in `properties` — reading only the property
	 *  showed "Modified —" for every freshly imported file while Files said
	 *  "Today". */
	updatedAt?: unknown;
	properties?: Record<string, unknown> | null;
};

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build the single-file `PreviewFile` for a resolved entity, or `null`
 * when the row can't be previewed (no id, no MIME, or no bridge-safe
 * URL). `null` is the host's cue to keep the empty state — never a
 * fabricated source.
 */
export function entityToPreviewFile(
	entity: ResolvableEntity | null | undefined,
): PreviewFile | null {
	if (!entity) return null;
	const id = readString(entity.id);
	if (!id) return null;
	const props = entity.properties;
	if (!props || typeof props !== "object") return null;

	// Two storage shapes resolve to a bridge-safe URL: a `File/v1` row from the
	// Files app stores its bytes in the shell asset store (`assetId` + `assetMime`,
	// served at `brainstorm://asset/<id>`); other entities carry a ready
	// `attachment` URL with a sibling `mime`. Prefer the explicit attachment,
	// fall back to the asset blob — without this, every uploaded file (the common
	// case) failed the gate below and Preview showed nothing.
	//
	// The MIME MUST be the one the URL will actually serve, not the truthful
	// upload MIME: the asset protocol downgrades active content to
	// `application/octet-stream` (an `.svg` uploads as `image/svg+xml` but serves
	// inert), and `assetMime` already holds that served value. Picking `mime`
	// here would mount (say) the image renderer on octet-stream bytes — a broken
	// surface instead of the honest "no preview" pane. So the asset path uses
	// `assetMime`; the attachment path uses its sibling `mime`.
	const attachment = readString(props.attachment);
	const assetId = readString(props.assetId);
	let url: string | null;
	let mime: string | null;
	if (attachment) {
		url = attachment;
		mime = readString(props.mime);
	} else if (assetId) {
		url = `brainstorm://asset/${assetId}`;
		mime = readString(props.assetMime) ?? readString(props.mime);
	} else {
		url = null;
		mime = null;
	}
	// Without a MIME the host can't pick a renderer; without a URL there's
	// nothing to fetch (bytes don't survive the preload bridge). Either
	// gap means "not previewable" — the host's job is to say so cleanly.
	if (!mime || !url) return null;

	const name = readString(props.name) ?? id;
	const sizeBytes = readNumberOrNull(props.size);
	const modifiedAt = readNumberOrNull(entity.updatedAt) ?? readNumberOrNull(props.updatedAt);

	return {
		id,
		info: { name, mime, sizeBytes, modifiedAt },
		source: { kind: "url", url, mime, sizeBytes },
	};
}
