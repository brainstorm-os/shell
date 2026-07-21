/**
 * Bridge to the shell's app preload. Mirrors `apps/theme-editor/src/
 * storage/runtime.ts` — types only the slice of `window.brainstorm` the
 * Form Designer uses: `services.entities` (read/create Layout + target
 * entities), `services.properties` (the vault property catalog the field
 * picker + fill cells read), `services.vaultEntities` (the live snapshot
 * the saved-forms sidebar derives from), and the lifecycle `on("ready")`
 * handshake.
 *
 * `getBrainstorm()` returns null when the renderer boots outside the
 * shell (e.g. `vite preview`); the app then runs read-only against an
 * empty catalog.
 */

import type {
	Entity,
	EntityQuery,
	ExportService,
	PropertiesService,
	VaultEntitiesService,
} from "@brainstorm-os/sdk-types";
import type { SaveFileService } from "@brainstorm-os/sdk/export-file";

export type EntitiesService = {
	get(id: string): Promise<Entity | null>;
	create(type: string, properties: Record<string, unknown>, id?: string): Promise<Entity>;
	update(id: string, patch: Record<string, unknown>): Promise<Entity>;
	delete(id: string): Promise<void>;
	query(query: EntityQuery): Promise<Entity[]>;
};

type LifecycleEvent =
	| { type: "ready" }
	| { type: "intent"; intent: unknown }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "close" };

type LifecycleHandler = (event: LifecycleEvent) => void;

export type FormDesignerBrainstorm = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	services?: {
		entities?: EntitiesService;
		properties?: PropertiesService;
		vaultEntities?: VaultEntitiesService;
		/** Renders self-contained HTML to PDF bytes (invoice export). Present
		 *  only when the `export.print-to-pdf` capability is granted. */
		export?: ExportService;
		/** Save-dialog + write for the exported PDF bytes. */
		files?: SaveFileService;
	} | null;
	on?(event: LifecycleEvent["type"], handler: LifecycleHandler): { unsubscribe(): void };
};

declare global {
	interface Window {
		brainstorm?: FormDesignerBrainstorm | undefined;
	}
}

export function getBrainstorm(): FormDesignerBrainstorm | null {
	return window.brainstorm ?? null;
}
