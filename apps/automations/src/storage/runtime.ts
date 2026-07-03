/**
 * Bridge to the shell's app preload. Mirrors `apps/theme-editor/src/
 * storage/runtime.ts` — types only the slice of `window.brainstorm` the
 * automations scaffold uses today: `services.entities` (read/write the
 * four automations types) and the lifecycle `on("ready", …)` handshake.
 *
 * `getBrainstorm()` returns null when the renderer boots outside the
 * shell (e.g. `vite preview`), which is exactly when the app falls back
 * to its in-memory empty state per [[preview-drop-pattern]].
 */

import type {
	AutomationsService,
	IntentsService,
	VaultEntitiesService,
} from "@brainstorm/sdk-types";

export type EntityRecord = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
};

export type EntitiesService = {
	get(id: string): Promise<EntityRecord | null>;
	query(q: { type?: string | string[] }): Promise<EntityRecord[]>;
	create(type: string, properties: Record<string, unknown>, id?: string): Promise<EntityRecord>;
	update(id: string, patch: Record<string, unknown>): Promise<EntityRecord>;
	delete(id: string): Promise<void>;
};

/** Files-host handle + the slice of the service the bundle import/export
 *  flow needs (Stage 9.10; caps `files.read` / `files.write`). Mirrors
 *  `apps/calendar`'s ICS slice; `requestSave`/`write` overlap the SDK
 *  `export-file` `SaveFileService` so the save path reuses that helper. */
export type AutomationFileHandle = { handleId: string; displayName: string };

export type AutomationFilesFilter = { name: string; extensions: readonly string[] };

export type FilesService = {
	requestOpen(opts?: {
		title?: string;
		filters?: readonly AutomationFilesFilter[];
		multiple?: boolean;
	}): Promise<readonly AutomationFileHandle[]>;
	requestSave(opts?: {
		title?: string;
		suggestedName?: string;
		filters?: readonly AutomationFilesFilter[];
	}): Promise<AutomationFileHandle | null>;
	read(handle: AutomationFileHandle): Promise<Uint8Array>;
	write(handle: AutomationFileHandle, data: Uint8Array | ArrayBuffer): Promise<void>;
};

type LifecycleEvent =
	| { type: "ready" }
	| { type: "intent"; intent: unknown }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "close" };

type LifecycleHandler = (event: LifecycleEvent) => void;

export type AutomationsBrainstorm = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	services?: {
		entities?: EntitiesService;
		/** Live whole-vault snapshot — the reactive lists bind to it. */
		vaultEntities?: VaultEntitiesService;
		/** Files-host service — bundle import/export rides on it (11b.16). */
		files?: FilesService;
		/** Shell-side engine handle — runNow + host designation (11b.6/.15). */
		automations?: AutomationsService;
		/** Intent dispatch — the recent-runs widget's row-click → `intent.open`
		 *  (cap `intents.dispatch:open`). */
		intents?: IntentsService;
	} | null;
	on?(event: LifecycleEvent["type"], handler: LifecycleHandler): { unsubscribe(): void };
};

declare global {
	interface Window {
		brainstorm?: AutomationsBrainstorm | undefined;
	}
}

export function getBrainstorm(): AutomationsBrainstorm | null {
	return window.brainstorm ?? null;
}
