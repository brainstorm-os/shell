/**
 * The `window.brainstorm` runtime surface the Files app reads.
 *
 * Extracted from the former plain-DOM `app.ts` so the React renderer,
 * the store hook and tests share one structural contract. The Files app
 * binds to the EXISTING `vaultEntities.list` / `onChange` preview read
 * path (Stage 9.13.1.8); the real entities-service swap (Stage 9.3)
 * replaces only the broker registration behind it, never this shape.
 */

import type { StoredAsset } from "@brainstorm/sdk-types";

export type VaultEntityShape = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	ownerAppId?: string;
};

export type VaultLinkShape = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	createdAt: number;
	deletedAt: null;
};

export type VaultSnapshot = {
	entities: VaultEntityShape[];
	links: VaultLinkShape[];
};

export type BrainstormSubscription = { unsubscribe(): void };

export type FilesLifecycleEvent = {
	type: string;
	intent?: { verb?: string; payload?: { entityId?: unknown } };
};

export type BrainstormRuntime = {
	app?: { id: string; version: string; sdkVersion: string };
	/** Per-launch context; carries a target `entityId` when this app was
	 *  opened via a cross-app `intent.open`. Read once after the vault
	 *  snapshot resolves: a Folder id navigates to that folder; a file id
	 *  opens its parent folder + selects the file. */
	launch?: { reason: string; entityId?: string };
	on?: {
		(event: "ready", handler: () => void): BrainstormSubscription;
		(event: "intent", handler: (event: FilesLifecycleEvent) => void): BrainstormSubscription;
	};
	capabilities?: readonly string[];
	intents?: {
		dispatch?: (request: {
			verb: string;
			payload: Record<string, unknown>;
		}) => unknown | Promise<unknown>;
	};
	services?: {
		vaultEntities?: {
			list(): Promise<VaultSnapshot>;
			onChange?(listener: () => void): BrainstormSubscription;
		};
		/** Real entities service (Stage 9.3). Only the surface the Files app
		 *  uses is typed here — full surface is in `@brainstorm/sdk-types`.
		 *  Writes are gated by `entities.write:brainstorm/Folder/v1` +
		 *  `entities.write:brainstorm/File/v1` in the manifest. */
		entities?: {
			create?(type: string, properties: Record<string, unknown>, id?: string): Promise<unknown>;
			update(entityId: string, properties: Record<string, unknown>): Promise<unknown>;
			delete?(entityId: string): Promise<unknown>;
		};
		intents?: {
			dispatch?: (request: {
				verb: string;
				payload: Record<string, unknown>;
			}) => unknown | Promise<unknown>;
			/** Read-only "which apps can open this?" — the same registry query the
			 *  shared object menu's "Open with ▸" uses. Files resolves browsability
			 *  per entity type with it: a type with ≥1 opener is shown in the
			 *  browser (and the default opener app names + icons the row). Gated on
			 *  the `intents.dispatch:open` grant the manifest already holds. */
			suggest?: (request: {
				verb: string;
				payload: Record<string, unknown>;
			}) => Promise<ReadonlyArray<{ appId: string; label: string | null }>>;
		};
		dashboard?: {
			pin?: (t: { entityId: string }) => Promise<boolean>;
			unpin?: (t: { entityId: string }) => Promise<boolean>;
			isPinned?: (t: { entityId: string }) => Promise<boolean>;
		};
		/** Shell UI service — only the 9.8.9 search handoff is consumed here.
		 *  Cap `search.open` in the manifest; absent on older shells. */
		ui?: {
			openSearch?(args: { query?: string }): Promise<void>;
		};
		/** Cover-content service consumed by the shared `<CoverPicker>`. */
		covers?: {
			uploadBytes(filename: string, bytes: Uint8Array): Promise<{ url: string; thumbUrl: string }>;
			list(): Promise<ReadonlyArray<{ url: string; thumbUrl: string }>>;
		};
		/** Files host service (9.10) — `requestOpen` + `import` drive the
		 *  9.8.5 create-flow upload (the second, byte-storing half). The
		 *  shape mirrors the subset of `@brainstorm/sdk-types` `FilesService`
		 *  this app consumes; the broker / SDK proxy expose the full surface. */
		files?: {
			requestOpen(opts?: {
				readonly title?: string;
				readonly filters?: ReadonlyArray<{
					readonly name: string;
					readonly extensions: readonly string[];
				}>;
				readonly multi?: boolean;
			}): Promise<ReadonlyArray<{ handleId: string; displayName: string }>>;
			read(handle: { handleId: string }): Promise<Uint8Array>;
			import?(
				input:
					| { handle: { handleId: string; displayName: string } }
					| { name: string; bytes: Uint8Array | ArrayBuffer },
			): Promise<{
				assetId: string;
				contentHash: string;
				size: number;
				mime: string;
				name: string;
			}>;
			/** Storage inventory across every vault store (9.x) — backs the
			 *  "Storage" overlay. `files.read`-gated. */
			listStorageInventory?(): Promise<ReadonlyArray<StoredAsset>>;
		};
		/** Cross-app DnD host (DND-5). Only `exportFile` (drag a file OUT to the
		 *  OS via `webContents.startDrag`) is consumed here. Cap `dnd.exportFile`
		 *  in the manifest; the full surface is in `@brainstorm/sdk-types`. */
		dnd?: {
			exportFile(args: { name: string; bytes: Uint8Array }): Promise<{ started: boolean }>;
		};
	} | null;
};

declare global {
	interface Window {
		brainstorm?: BrainstormRuntime;
	}
}
