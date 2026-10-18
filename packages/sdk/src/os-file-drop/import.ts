/**
 * Turn OS files dropped on an app into vault File/v1 objects (9.8.17).
 *
 * Two layers, because the two consumers persist differently:
 *  - `importDroppedOsFiles` seals each dropped file's bytes into the vault's
 *    encrypted asset store (`files.import`, bytes variant — the drop gesture
 *    is the user mediation) and answers what a File/v1 row must carry. Files
 *    uses this layer: it inserts rows into its own optimistic folder tree with
 *    collision-renamed names before persisting.
 *  - `importOsFilesAsEntities` adds the `entities.create` step for a surface
 *    that has no local tree — Database dropping files into a collection.
 *
 * One failed file never aborts the batch: it is reported through `onError`
 * and skipped, matching the picker-upload posture.
 */

import type { FileImportResult } from "@brainstorm-os/sdk-types";
import { mimeFromName } from "./mime";

export const FILE_ENTITY_TYPE = "brainstorm/File/v1" as const;

/** The `files.import` subset these helpers need. */
export type OsFileImporter = {
	import(input: { name: string; bytes: Uint8Array | ArrayBuffer }): Promise<FileImportResult>;
};

/** The `entities.create` subset `importOsFilesAsEntities` needs. */
export type FileEntityCreator = {
	create(type: string, properties: Record<string, unknown>): Promise<{ id: string }>;
};

/** A dropped file the shell has stored — everything a File/v1 row carries
 *  except the (possibly collision-renamed) display name the caller picks. */
export type ImportedOsFile = {
	name: string;
	/** Extension-truthful MIME (what the file is). */
	mime: string;
	size: number;
	/** Content hash of the stored bytes — the duplicate-detection key. */
	hash: string;
	assetId: string;
	/** The shell's preview-safe served MIME for `brainstorm://asset/<id>`. */
	assetMime: string;
};

/** The minimal `File` shape read here — a DOM `File` satisfies it, and
 *  tests can pass a plain object. */
export type DroppedFileLike = {
	readonly name: string;
	arrayBuffer(): Promise<ArrayBuffer>;
};

export type ImportOptions = {
	onError?(file: DroppedFileLike, error: unknown): void;
};

/** Store one dropped file. Throws when reading or importing fails — the
 *  batch helpers below catch per file. */
export async function importDroppedOsFile(
	file: DroppedFileLike,
	importer: OsFileImporter,
): Promise<ImportedOsFile> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const reply = await importer.import({ name: file.name, bytes });
	return {
		name: file.name,
		mime: mimeFromName(file.name),
		size: reply.size,
		hash: reply.contentHash,
		assetId: reply.assetId,
		assetMime: reply.mime,
	};
}

export async function importDroppedOsFiles(
	files: Iterable<DroppedFileLike>,
	importer: OsFileImporter,
	options: ImportOptions = {},
): Promise<ImportedOsFile[]> {
	const imported: ImportedOsFile[] = [];
	for (const file of files) {
		try {
			imported.push(await importDroppedOsFile(file, importer));
		} catch (error) {
			options.onError?.(file, error);
		}
	}
	return imported;
}

/** The File/v1 property bag for a stored file. `name` overrides the dropped
 *  name (a caller that collision-renames passes the final one). */
export function fileEntityProperties(
	imported: ImportedOsFile,
	name: string = imported.name,
): Record<string, unknown> {
	return {
		name,
		mime: imported.mime,
		size: imported.size,
		hash: imported.hash,
		assetId: imported.assetId,
		assetMime: imported.assetMime,
	};
}

export type CreatedFileEntity = { id: string; file: ImportedOsFile };

/** Import every dropped file and create one File/v1 entity per stored file.
 *  Returns the created rows in drop order; a file whose import or create
 *  fails is reported through `onError` and left out. */
export async function importOsFilesAsEntities(
	files: Iterable<DroppedFileLike>,
	services: { files: OsFileImporter; entities: FileEntityCreator },
	options: ImportOptions = {},
): Promise<CreatedFileEntity[]> {
	const created: CreatedFileEntity[] = [];
	for (const source of files) {
		try {
			const file = await importDroppedOsFile(source, services.files);
			const entity = await services.entities.create(FILE_ENTITY_TYPE, fileEntityProperties(file));
			created.push({ id: entity.id, file });
		} catch (error) {
			options.onError?.(source, error);
		}
	}
	return created;
}
