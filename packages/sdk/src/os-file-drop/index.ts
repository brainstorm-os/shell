/**
 * `@brainstorm-os/sdk/os-file-drop` — drop files from the OS into a vault
 * surface as File/v1 objects (9.8.17). Files' content list is consumer one;
 * Database's collection views are the planned second.
 */

export {
	OsFileDragTracker,
	type OsFileDropOptions,
	bindOsFileDrop,
	createOsFileDropHandlers,
	isOsFileDrag,
} from "./drop-target";
export {
	type CreatedFileEntity,
	type DroppedFileLike,
	FILE_ENTITY_TYPE,
	type FileEntityCreator,
	type ImportOptions,
	type ImportedOsFile,
	type OsFileImporter,
	fileEntityProperties,
	importDroppedOsFile,
	importDroppedOsFiles,
	importOsFilesAsEntities,
} from "./import";
export { DEFAULT_MIME, mimeFromName } from "./mime";
export { useOsFileDrop } from "./use-os-file-drop";
