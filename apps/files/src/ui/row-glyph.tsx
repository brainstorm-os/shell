import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { CSSProperties } from "react";
import { type Entity, FILE_TYPE, FOLDER_TYPE, readName } from "../types/entity";
import { ViewMode } from "../view-mode";
import { readEntityIcon } from "./entity-view";
import { EntityIcon } from "./entity-visuals";

/** `data-glyph` on the host — the stylesheet keys the glyph colour off it. */
export enum RowGlyphKind {
	Folder = "folder",
	File = "file",
	Unknown = "unknown",
}

/** Trailing extension of `name`, uppercased for the tile chip ("JPG",
 *  "PDF"). Hidden-file prefixes and extension-less names yield null. Capped
 *  so "markdown" doesn't blow the chip out. */
function extensionChip(name: string): string | null {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return null;
	const ext = name.slice(dot + 1);
	if (ext.length > 5) return null;
	return ext.toUpperCase();
}

function isTileMode(mode: ViewMode): boolean {
	return mode === ViewMode.Grid || mode === ViewMode.Gallery;
}

export type RowGlyphProps = {
	entity: Entity;
	mode: ViewMode;
	iconSize: number;
	openerAppId: string | null;
};

/**
 * The row's leading glyph slot, shared by every view mode. It is NEVER
 * empty: an empty host is what let the name slide into the grid's icon track
 * (the 0.15.0 "file names invisible in List" regression).
 *
 * Image files render their stored blob (`brainstorm://asset/<assetId>`,
 * decided by the shell's preview-safe `assetMime`); anything with its OWN
 * icon renders it; folders render the folder glyph. Other files fall back to
 * an extension chip on tiles and the file-kind glyph in the one-lane lists
 * (a chip can't fit a 20px slot). A non-File/Folder object (the universal
 * browser) with no own icon shows its default opener app's squircle
 * (`brainstorm://app-icon/<appId>`) — the same sanctioned type-identity
 * badge the dashboard pins use — and the generic entity glyph when no opener
 * is registered.
 */
export function RowGlyph({ entity, mode, iconSize, openerAppId }: RowGlyphProps) {
	const icon = readEntityIcon(entity);
	const isFolder = entity.type === FOLDER_TYPE;
	const isFile = entity.type === FILE_TYPE;
	const assetId = entity.properties.assetId;
	const assetMime = entity.properties.assetMime;
	const hasImage =
		typeof assetId === "string" &&
		assetId !== "" &&
		typeof assetMime === "string" &&
		assetMime.startsWith("image/");
	const chip =
		isFile && isTileMode(mode) && !hasImage && !icon ? extensionChip(readName(entity)) : null;
	const appIcon = !isFolder && !isFile && !icon && !hasImage ? openerAppId : null;
	const kind = isFolder ? RowGlyphKind.Folder : isFile ? RowGlyphKind.File : RowGlyphKind.Unknown;
	return (
		<span
			className="content-row__glyph"
			data-kind={isFolder ? RowGlyphKind.Folder : RowGlyphKind.File}
			data-glyph={kind}
			// Pipe the tile-size preset's icon metric to the stylesheet so the
			// glyph / squircle / thumbnail scale with the tile instead of the
			// CSS pinning one fixed pixel size across Small/Medium/Large.
			style={{ "--glyph-size": `${iconSize}px` } as CSSProperties}
			aria-hidden="true"
		>
			{hasImage ? (
				<img
					className="content-row__thumb"
					src={`brainstorm://asset/${assetId}`}
					alt=""
					loading="lazy"
					draggable={false}
				/>
			) : icon ? (
				<EntityIcon icon={icon} size={iconSize} />
			) : isFolder ? (
				<Icon name={IconName.Folder} size={iconSize} />
			) : chip ? (
				<span className="content-row__ext">{chip}</span>
			) : isFile ? (
				<Icon name={IconName.KindFile} size={iconSize} />
			) : appIcon ? (
				<img
					className="content-row__app-icon"
					src={`brainstorm://app-icon/${appIcon}`}
					alt=""
					loading="lazy"
					draggable={false}
				/>
			) : (
				<Icon name={IconName.Entity} size={iconSize} />
			)}
		</span>
	);
}
