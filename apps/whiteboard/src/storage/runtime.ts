/**
 * Bridge to the shell's app preload. Mirrors `apps/tasks/src/storage/runtime.ts`
 * + `apps/bookmarks/src/storage/runtime.ts` — types only the slice of
 * `window.brainstorm` Whiteboard uses today (`services.storage.kv` for
 * owned-entity persistence + lifecycle `on("ready", …)`).
 *
 * `getBrainstorm()` returns null when the renderer boots outside the
 * shell (e.g. `vite preview`, isolated dev), which is exactly when the
 * app falls back to the in-memory demo dataset per
 * [[preview-drop-pattern]].
 */

type StorageValue = unknown;

export type StorageEntry = { key: string; value: StorageValue };

export type StorageService = {
	put(key: string, value: StorageValue): Promise<void>;
	get<T = StorageValue>(key: string): Promise<T | null>;
	list(prefix?: string): Promise<StorageEntry[]>;
	delete(key: string): Promise<boolean>;
};

/** The slice of the shared entities service Whiteboard uses (9.3.5.5).
 *  No rich text — no Y.Doc methods. `create` takes an optional caller
 *  id so a board/edge keeps its stable id across the kv→shared
 *  transition. Mirrors `apps/tasks` / `apps/bookmarks`. */
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

type LifecycleEvent =
	| { type: "ready" }
	| { type: "intent"; intent: unknown }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "close" };

type LifecycleHandler = (event: LifecycleEvent) => void;

/** A live vault entity as the aggregator returns it. Narrowed to the fields
 *  the embed picker (9.17.4) reads; mirrors `@brainstorm-os/sdk-types::VaultEntity`. */
export type VaultEntitySummary = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	ownerAppId: string;
};

/** Vault-entities aggregator slice. `onChange` fans on every cross-app write +
 *  `dev:reseed-vault` (board-list refresh); `list` (9.17.4) enumerates the live
 *  object space for the Embed-entity picker. */
export type VaultEntitiesService = {
	onChange(listener: () => void): { unsubscribe(): void };
	list(): Promise<{ entities: VaultEntitySummary[]; links: unknown[] }>;
};

/** Block-registry slice (9.17.4) — resolve which app renders an entity type +
 *  fetch the providing app's block bundle source. Mirrors
 *  `@brainstorm-os/sdk-types::BlocksService`. */
export type BlocksService = {
	source(blockId: string): Promise<string | null>;
	forType(entityType: string): Promise<string | null>;
};

/** BP host-router slice (9.17.4) — forwards a block's graph-module message to
 *  the host and returns the response. Mirrors `@brainstorm-os/sdk-types::BpService`. */
export type BpService = {
	dispatch(entityId: string, message: unknown): Promise<unknown>;
};

/** Intent-dispatch slice (9.17.4) — opening an embedded entity in its app via
 *  the shared `openEntity` helper. */
export type IntentsService = {
	dispatch(intent: { verb: string; payload: Record<string, unknown> }): Promise<unknown>;
};

/** Files-host save surface (Stage 9.10) — only the slice the 9.17.8b
 *  Save-as-file flow consumes. The full surface lives in
 *  `@brainstorm-os/sdk-types::FilesService`; this narrowed type mirrors the
 *  Graph app's `9.13.13b` pattern so Whiteboard doesn't pull in the
 *  full `EntitiesService` etc. just to wire one menu row. */
export type FilesService = {
	requestSave(opts?: {
		readonly title?: string;
		readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
		readonly suggestedName?: string;
	}): Promise<{ readonly handleId: string; readonly displayName: string } | null>;
	write(
		handle: { readonly handleId: string; readonly displayName: string },
		data: Uint8Array | ArrayBuffer,
	): Promise<void>;
	/** Open-file picker + read (Stage 9.10) — the slice the 9.17.11 image
	 *  insertion flow consumes. Present when `files.read` is granted. */
	requestOpen(opts?: {
		readonly title?: string;
		readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
		readonly multi?: boolean;
	}): Promise<readonly { readonly handleId: string; readonly displayName: string }[]>;
	read(handle: { readonly handleId: string; readonly displayName: string }): Promise<Uint8Array>;
};

export type WhiteboardBrainstorm = {
	app?: { id: string; version: string; sdkVersion: string };
	services?: {
		storage?: StorageService;
		/** Present once the shell exposes the shared entities service.
		 *  When available Whiteboard reads/writes the shared object space
		 *  (9.3.5.5) instead of its `kv.json` silo. */
		entities?: EntitiesService;
		/** Vault-entities aggregator (subscribe-only — see type above). */
		vaultEntities?: VaultEntitiesService;
		/** Files-host service. Present when `files.write` is granted; the
		 *  Save-as-file menu rows hide when this is absent (preview /
		 *  standalone-dev / future non-Electron host). */
		files?: FilesService;
		/** Block registry (9.17.4) — resolves + fetches the BP block to host in
		 *  an Embedded node. */
		blocks?: BlocksService;
		/** BP host router (9.17.4) — forwards an embedded block's graph traffic. */
		bp?: BpService;
		/** Intent dispatch (9.17.4) — opens an embedded entity in its app. */
		intents?: IntentsService;
		/** Live presence (PRES-2b) — publish/clear this device's cursor+selection
		 *  for a board, gated on `entities.read:<type>`. Absent ⇒ presence stays
		 *  single-device (standalone / preview). */
		presence?: {
			publish(input: {
				entityId: string;
				type: string;
				state: Record<string, unknown> | null;
			}): Promise<void>;
			untrack(input: { entityId: string }): Promise<void>;
		};
	};
	on?(event: LifecycleEvent["type"], handler: LifecycleHandler): { unsubscribe(): void };
	/** Live-presence peer push (PRES-2b) — the merged peer set for a board the
	 *  app published presence for. Separate from `services.presence` (the calls);
	 *  mirrors `ydoc.onRemote`. */
	presence?: {
		onPeers(
			entityId: string,
			handler: (peers: { clientId: number; state: Record<string, unknown> }[]) => void,
		): () => void;
	};
};

declare global {
	interface Window {
		brainstorm?: WhiteboardBrainstorm | undefined;
	}
}

export function getBrainstorm(): WhiteboardBrainstorm | null {
	return window.brainstorm ?? null;
}
