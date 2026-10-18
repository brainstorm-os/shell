/**
 * Vault media (B11.28) — the files already in the vault (`brainstorm/File/v1`
 * rows, bytes in the shell asset store) as insertable media, so an image or
 * attachment can be reused instead of re-uploaded from the OS.
 *
 * Same URL rule as Preview's `entityToPreviewFile`: an explicit `attachment`
 * URL wins, else the asset blob at `brainstorm://asset/<assetId>`; the MIME is
 * the one that URL actually serves (`assetMime` — the asset protocol serves
 * active content such as SVG as octet-stream, so an SVG is a file, not an
 * image, here).
 */

import { FILE_ENTITY_TYPE, type VaultEntity } from "@brainstorm-os/sdk-types";
import { filterEntities } from "./plugins/mention-ops";

export enum VaultMediaFilter {
	Image = "image",
	Any = "any",
}

export type VaultMedia = {
	id: string;
	name: string;
	url: string;
	mime: string;
	size: number | null;
};

/** Rows shown at once — the filter narrows, the list never grows unbounded. */
export const VAULT_MEDIA_PICKER_LIMIT = 50;

const ASSET_ID_RE = /^[0-9a-f-]{36}$/;

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function isImageMime(mime: string): boolean {
	return mime.startsWith("image/") && mime !== "image/svg+xml";
}

export function vaultMediaFromEntity(entity: VaultEntity): VaultMedia | null {
	if (entity.type !== FILE_ENTITY_TYPE) return null;
	const props = entity.properties as Record<string, unknown>;
	const attachment = readString(props.attachment);
	const assetId = readString(props.assetId);
	let url: string | null = null;
	let mime: string | null = null;
	if (attachment?.startsWith("brainstorm://")) {
		url = attachment;
		mime = readString(props.mime);
	} else if (assetId && ASSET_ID_RE.test(assetId)) {
		url = `brainstorm://asset/${assetId}`;
		mime = readString(props.assetMime) ?? readString(props.mime);
	}
	if (!url || !mime) return null;
	const size = typeof props.size === "number" && Number.isFinite(props.size) ? props.size : null;
	return { id: entity.id, name: readString(props.name) ?? entity.id, url, mime, size };
}

/** Title-ranked vault media matching `query`, narrowed by `filter`. */
export function filterVaultMedia(
	entities: readonly VaultEntity[],
	filter: VaultMediaFilter,
	query: string,
): VaultMedia[] {
	const byId = new Map<string, VaultMedia>();
	const candidates: VaultEntity[] = [];
	for (const entity of entities) {
		const media = vaultMediaFromEntity(entity);
		if (!media) continue;
		if (filter === VaultMediaFilter.Image && !isImageMime(media.mime)) continue;
		byId.set(entity.id, media);
		candidates.push(entity);
	}
	const out: VaultMedia[] = [];
	for (const { entity } of filterEntities(candidates, query)) {
		const media = byId.get(entity.id);
		if (media) out.push(media);
		if (out.length >= VAULT_MEDIA_PICKER_LIMIT) break;
	}
	return out;
}
