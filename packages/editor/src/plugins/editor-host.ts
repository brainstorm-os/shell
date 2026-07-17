/**
 * EditorHost — a module-level bridge for the imperative host operations
 * the shared editor's plugins/decorators need (open an entity, upload a
 * file). The package never imports an app runtime (`window.brainstorm` /
 * `getBrainstorm()`); each app calls `setEditorHost({...})` once at boot
 * to wire these, and the editor reads them via `getEditorHost()`.
 *
 * Why a module bridge rather than a React context: the consumers are
 * imperative — a plain `dispatchOpenEntity` helper, click handlers inside
 * Lexical decorators, async typeahead handlers — none of which sit at a
 * place a hook can be called. The reactive vault-entity SNAPSHOT (titles
 * / icons / typeahead lists) is a separate concern owned by
 * `entity-index` (`setEntityIndexSource`); this bridge is only the
 * fire-and-forget operations.
 *
 * Every field is optional: an unwired host means the operation is a
 * no-op, so the same plugins mount cleanly in previews/tests.
 */

import type { NavigationMode } from "@brainstorm/sdk";
import type { BpService } from "@brainstorm/sdk-types";

/** Result shape of the shell's `storage.uploadFile` surface. */
export type EditorUploadResult = {
	url: string;
	hash: string;
	ext: string;
	size: number;
	mime: string;
};

/** Upload a file's bytes through the shell and get back a durable
 *  `brainstorm://app-file/…` URL. Mirrors `services.storage.uploadFile`. */
export type EditorUploadFn = (
	filename: string,
	bytes: Uint8Array,
	mime?: string,
) => Promise<EditorUploadResult>;

/** The slice of the shell's `services.blocks` registry the shared
 *  block-embed decorator needs: resolve the providing app's live block for
 *  an entity type, and fetch a block's bundle source for the sandboxed
 *  iframe mount. Mirrors `BlocksService.forType` / `.source` (both behind
 *  the default-minimum `blocks.read` grant). */
export type EditorBlocksHost = {
	forType: (entityType: string) => Promise<string | null>;
	source: (blockId: string) => Promise<string | null>;
};

export type EditorHost = {
	/** Navigate to an entity (link-markup click, mention chip, backlink,
	 *  page-ref). Wraps the shell's open-entity intent. `mode` carries the
	 *  click-derived navigation mode (replace / new-tab / new-window).
	 *  `blockId` is the optional `#block-<id>` anchor (B11.13) — the
	 *  receiving app scrolls to + flashes that block after opening. */
	openEntity?: (target: {
		entityId: string;
		entityType?: string;
		mode?: NavigationMode;
		blockId?: string;
	}) => void;
	/** Upload media bytes (drag-drop / paste / media inspector). */
	uploadFile?: EditorUploadFn;
	/** Block registry lookups for the `/embed` entity card (`BlockEmbedNode`):
	 *  `forType` upgrades the fallback card to the providing app's live block,
	 *  `source` fetches that block's bundle. Unwired → the card renders the
	 *  generic chrome (still navigable) and never mounts an iframe. */
	blocks?: EditorBlocksHost;
	/** Block-Protocol graph transport handed to `<BpBlockMount bp>` so a live
	 *  embedded block can query/update entities through the host broker.
	 *  Unwired → the block mounts without graph traffic. */
	bp?: BpService;
};

let host: EditorHost = {};

/** Wire the editor's imperative host operations. Call once at app boot. */
export function setEditorHost(next: EditorHost): void {
	host = next;
}

/** Read the wired host. Returns an empty host (all ops absent) when none
 *  is set, so callers null-check each op and degrade rather than throw. */
export function getEditorHost(): EditorHost {
	return host;
}
