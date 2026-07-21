/**
 * Media upload helpers — extracted to `@brainstorm-os/editor` (the shared
 * media stack) so every editor surface uploads the same way. The shared
 * implementation routes through the host uploader wired with
 * `setEditorHost({ uploadFile })` (Notes wires it in `main.tsx` from
 * `services.storage.uploadFile`). Re-exported here for Notes' command
 * call sites + the media-files test.
 */

export {
	MediaFileKind,
	classifyMediaFile,
	collectMediaFiles,
	dataTransferHasFiles,
	readAsDataUrl,
	resolveBinarySrc,
	resolveImageSrc,
	tryUploadFile,
} from "@brainstorm-os/editor";
