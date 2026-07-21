/**
 * IconPack/v1 read access for the 9.9.3 picker. The theme-editor does not
 * author icon packs in 9.9.3 (per-glyph SVG authoring needs an asset
 * pipeline — deferred); it only enumerates installed packs to pick one
 * and loads the chosen pack so the in-editor preview can apply it via the
 * shared `setActiveIconPack` seam.
 */

import {
	type IconGlyph,
	type IconPackDef,
	IconPackStyle,
	type VaultEntity,
	isValidIconPack,
} from "@brainstorm-os/sdk-types";
import type { InstalledPack } from "../logic/icon-pack-options";
import type { EntitiesService } from "./runtime";

const ICON_PACK_TYPE = "brainstorm/IconPack/v1";

/** Project the installed `IconPack/v1` entities out of a whole-vault
 *  snapshot — the pure derivation the live icon-pack picker runs on (the
 *  snapshot flows through `@brainstorm-os/react-yjs` `useVaultEntities`). */
export function iconPacksFromSnapshot(entities: ReadonlyArray<VaultEntity>): InstalledPack[] {
	return entities
		.filter((e) => e.type === ICON_PACK_TYPE && e.deletedAt === null)
		.map((e) => ({
			id: e.id,
			name:
				typeof e.properties.name === "string" && e.properties.name.trim().length > 0
					? e.properties.name
					: e.id,
		}));
}

export async function listIconPacks(
	entities: EntitiesService | null | undefined,
): Promise<InstalledPack[]> {
	if (!entities) return [];
	const records = await entities.query({ type: ICON_PACK_TYPE });
	return records.map((r) => ({
		id: r.id,
		name:
			typeof r.properties.name === "string" && r.properties.name.trim().length > 0
				? r.properties.name
				: r.id,
	}));
}

/** Rebuild an `IconPackDef` from an entity's properties defensively;
 *  returns `null` when the result isn't a valid pack (so the preview
 *  never applies a broken pack). */
export function propertiesToIconPack(
	props: Record<string, unknown> | null | undefined,
): IconPackDef | null {
	const p = props ?? {};
	const styleRaw = (p.metadata as { style?: unknown } | undefined)?.style;
	const pack: IconPackDef = {
		name: typeof p.name === "string" ? p.name : "",
		version: typeof p.version === "string" ? p.version : "",
		license: typeof p.license === "string" ? p.license : "",
		metadata: { style: (styleRaw as IconPackStyle) ?? IconPackStyle.Line },
		icons: (p.icons as Record<string, IconGlyph>) ?? {},
		fallback: typeof p.fallback === "string" ? p.fallback : "",
	};
	return isValidIconPack(pack) ? pack : null;
}

export async function loadIconPack(
	entities: EntitiesService | null | undefined,
	id: string,
): Promise<IconPackDef | null> {
	if (!entities) return null;
	const record = await entities.get(id);
	return record ? propertiesToIconPack(record.properties) : null;
}
