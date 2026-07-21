/**
 * Bridge to the shell app preload — types only the slice of
 * `window.brainstorm` Preview uses: the launch handshake, the `intent`
 * lifecycle push channel, and `services.entities.get` (to resolve a bare
 * entity id to a renderable file). Null outside the shell.
 *
 * Cross-app open wiring (see [[project_cross_app_linking]]): when Files (or
 * any app) dispatches `intents.dispatch("open"|"quick-look", { entityId,
 * context, siblings })`, the shell delivers it two ways and Preview honours
 * both — (1) the launch handshake for a freshly-opened window, (2) the
 * `app:intent` push re-emitted as the SDK `runtime.on("intent")` event for
 * an already-running window.
 */

import type { Entity, PropertiesService, VaultEntitiesService } from "@brainstorm-os/sdk-types";
import type { SaveFileService } from "@brainstorm-os/sdk/export-file";
import type { PreviewContext } from "../types/preview-context";

/** Wire-shape an originating app puts on the intent payload. Bytes-mode
 *  sources are intentionally excluded — they don't survive structured-clone
 *  cleanly across the preload bridge, and dispatching apps already have a
 *  URL representation. */
export type PreviewContextSibling = {
	id: string;
	name: string;
	mime: string;
	sizeBytes?: number | null;
	modifiedAt?: number | null;
	url: string;
};

export type OpenPayload = {
	entityId?: unknown;
	context?: PreviewContext | null;
	siblings?: ReadonlyArray<PreviewContextSibling>;
};

type IntentEvent = {
	type: string;
	intent?: { verb?: string; payload?: OpenPayload };
};

export type PreviewRuntime = {
	launch?: { reason?: string } & OpenPayload;
	on?: (
		event: "intent",
		handler: (e: IntentEvent) => void,
	) => { unsubscribe?: () => void } | unknown;
	services?: {
		entities?: {
			get?: (id: string) => Promise<unknown>;
			/** Write-through for editable file properties + the comment mutation
			 *  triple. Absent on a standalone/older shell — the inspector then
			 *  renders read-only with no Comments tab. */
			create?: (type: string, properties: Record<string, unknown>) => Promise<Entity>;
			update?: (id: string, patch: Record<string, unknown>) => Promise<Entity>;
			delete?: (id: string) => Promise<void>;
		} | null;
		/** Vault-scoped property catalog driving the editable inspector rows (the
		 *  shared `PropertiesProvider` consumes it). Null on a standalone preview
		 *  build — the inspector falls back to read-only facts. */
		properties?: PropertiesService | null;
		/** Whole-vault live snapshot driving the library sidebar — read through
		 *  `@brainstorm-os/react-yjs`'s `useVaultEntities` (which owns the change
		 *  subscription), then filtered to `File/v1` rows. Preview holds the
		 *  `entities.read:*` wildcard that `list()` requires. Null on a standalone
		 *  preview build. */
		vaultEntities?: VaultEntitiesService | null;
		files?: SaveFileService | null;
		/** `intents.dispatch:open` — used to hand a PDF link's web URL to the
		 *  browser app (the registered `https` opener). */
		intents?: {
			dispatch: (intent: { verb: string; payload: Record<string, unknown> }) => Promise<unknown>;
		} | null;
	} | null;
};

export function getPreviewRuntime(): PreviewRuntime | undefined {
	return (window as unknown as { brainstorm?: PreviewRuntime }).brainstorm;
}
