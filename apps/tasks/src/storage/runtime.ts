/**
 * Bridge to the shell's app preload. Mirrors `apps/notes/src/store/runtime.ts`
 * — we type the bits of `window.brainstorm` Tasks actually uses today.
 *
 * `getBrainstorm()` returns null when the renderer boots outside the
 * shell (e.g. `vite preview`, Playwright harness without the preload),
 * which is exactly when the app falls back to the in-memory demo
 * dataset per [[preview-drop-pattern]].
 */

import { type NavigationMode, openEntity as dispatchOpenVerb } from "@brainstorm/sdk";
import type {
	BlocksService,
	BpService,
	ExportTextFormat,
	LaunchContext,
	PropertiesService,
	VaultEntitiesService as SdkVaultEntitiesService,
	SearchService,
	VaultEntity,
} from "@brainstorm/sdk-types";
import type { SaveFileService } from "@brainstorm/sdk/export-file";

export type { SaveFileService };

type StorageValue = unknown;

export type StorageEntry = { key: string; value: StorageValue };

export type StorageService = {
	put(key: string, value: StorageValue): Promise<void>;
	get<T = StorageValue>(key: string): Promise<T | null>;
	list(prefix?: string): Promise<StorageEntry[]>;
	delete(key: string): Promise<boolean>;
	/** Upload a file's bytes and get back a durable `brainstorm://app-file/…`
	 *  URL — backs the shared editor's media blocks (drag-drop / paste /
	 *  `/image`). */
	uploadFile(
		filename: string,
		bytes: Uint8Array,
		mime?: string,
	): Promise<{ url: string; hash: string; ext: string; size: number; mime: string }>;
};

/** The slice of the shared entities service Tasks uses (9.3.5.3). Tasks
 *  has no rich text, so it never touches the Y.Doc methods. `create`
 *  takes an optional caller id so Tasks preserves its stable ids
 *  (iteration ids / `proj-<stage>` — load-bearing for cross-app links). */
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
	/** Per-entity Y.Doc snapshot/persist surface — drives the renderer-side
	 *  resolver behind `useYDoc(taskId)`. Since 9.14.6 a task carries a
	 *  `brainstorm/UniversalBody/v1` body for the inspector's rich-text
	 *  notes; this is the same contract Notes + Journal use. Optional so
	 *  the property-only repository path (and its test mocks) don't depend
	 *  on the doc surface; the inspector resolver checks for it and
	 *  degrades to read-only legacy notes when absent. */
	loadDoc?(entityId: string): Promise<{ snapshotB64?: string | null }>;
	applyDoc?(entityId: string, updateB64: string): Promise<unknown> | undefined;
	closeDoc?(entityId: string): Promise<unknown> | undefined;
};

/** Inbound Y.Doc update bridge — the main process pushes updates that
 *  arrived from another renderer / sync source through this subscription.
 *  Mirrors the Journal / Notes `ydoc` bridge; present only with a live
 *  shell runtime. */
export type YDocBridge = {
	onRemote(
		entityId: string,
		listener: (updateB64: string) => void,
	): { unsubscribe?: () => void } | (() => void);
};

type Intent = {
	verb: string;
	payload: Record<string, unknown>;
	source: string;
};

type LifecycleEvent =
	| { type: "ready" }
	| { type: "intent"; intent: Intent }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "close" };

type LifecycleHandler = (event: LifecycleEvent) => void;

/** Dashboard pin surface — the slice the shared object-menu needs to
 *  label Pin vs. Remove-from-dashboard and to act on it. Present only
 *  when the shell exposes it and `dashboard.pin` is granted. */
export type DashboardService = {
	pin(target: { entityId: string }): Promise<boolean>;
	unpin(target: { entityId: string }): Promise<boolean>;
	isPinned(target: { entityId: string }): Promise<boolean>;
};

/** Cross-app intent dispatch — the object-menu Open item routes through
 *  this (the one open path). `intents.dispatch:open` is default-minimum. */
export type IntentsService = {
	dispatch(intent: { verb: string; payload: Record<string, unknown> }): Promise<unknown>;
};

/** Shell notification surface (`ui.notify`, cap `notifications.post`) —
 *  drives the due/scheduled task alerts (9.14.9). Optional; absent in
 *  preview / standalone, where the alert scheduler silently no-ops. */
export type UiService = {
	notify?(notification: { title: string; body?: string; dedupeKey?: string }): Promise<void>;
};

/** Vault-entities aggregator. `onChange` drives the per-type
 *  `repository.listAll` re-pull (staleness signal on every cross-app
 *  write + dev reseed); `list` feeds the shared editor's entity index so
 *  the task-body `@`-mention / transclusion typeaheads can enumerate the
 *  vault (the shell exposes the same full service every app gets). */
export type VaultEntitiesService = {
	list(): Promise<{ entities: readonly VaultEntity[] }>;
	onChange(listener: () => void): { unsubscribe(): void };
};

/** Generic entity export (IE-8) — serialises an entity's properties to
 *  Markdown / CSV / JSON. Read-only + type-scoped on `entities.read` by the
 *  host handler; absent in preview / older shells (the Export row then
 *  doesn't render). */
export type ExportService = {
	serializeEntities(input: { ids: readonly string[]; format: ExportTextFormat }): Promise<string>;
};

export type TasksBrainstorm = {
	app: { id: string; version: string; sdkVersion: string };
	/** Granted capability ids (bare or scoped). The shared object-menu
	 *  reads this to gate the Pin toggle. */
	capabilities?: readonly string[];
	/** Per-launch context. When the shell opens Tasks via an
	 *  `intents.dispatch("open", { entityId })` from another app, this
	 *  carries `{ reason: "open-entity", entityId }`; the renderer reads
	 *  it once at boot and selects the right surface + highlights the
	 *  row. See `logic/launch-selection.ts`. */
	launch: LaunchContext;
	services: {
		storage: StorageService;
		/** Present once the shell exposes the shared entities service.
		 *  When available Tasks reads/writes the shared object space
		 *  (9.3.5.3) instead of its `kv.json` silo. */
		entities?: EntitiesService;
		/** Vault-wide lexical search (9.22). Default-granted `search.read`,
		 *  so present whenever the shell is. Absent in preview / older
		 *  shells — the search bar falls back to a local title scan. */
		search?: SearchService;
		/** Vault properties (gated on `properties.read`/`write`) — backs the
		 *  detail view's shared property-value cells. Absent in preview /
		 *  older shells; the detail then hides the properties inspector. */
		properties?: PropertiesService;
		/** Cross-app intent dispatch (object-menu Open routes through it). */
		intents?: IntentsService;
		/** Dashboard pin surface (object-menu Pin/Unpin). */
		dashboard?: DashboardService;
		/** Vault-entities aggregator. We consume `onChange` only — fans on
		 *  every cross-app write + dev reseed, used to re-pull `repository.listAll`
		 *  so a freshly-seeded vault appears without manual reload. The dashboard
		 *  widget also reads it through `@brainstorm/react-yjs`'s `useVaultEntities`,
		 *  which wants the full SDK service shape. */
		vaultEntities?: SdkVaultEntitiesService;
		/** Shell notification surface — due/scheduled alerts (9.14.9). */
		ui?: UiService;
		/** Entity → text serializer for the object-menu "Export…" row (IE-8).
		 *  Default-granted via `entities.read`; absent in older shells. */
		export?: ExportService;
		/** Files host — `requestSave` + `write` back the "Export…" save flow
		 *  (cap `files.write`). Absent in preview / older shells. */
		files?: SaveFileService;
		/** BP block registry (`blocks.*`) — resolves which live block renders
		 *  an entity type and serves the bundle source the inline-task embed
		 *  (9.14.3) mounts. Absent in preview / older shells; the embed then
		 *  paints the generic shell entity-card chrome only. */
		blocks?: BlocksService;
		/** Block to host BP dispatch (9.4.5) — forwards an embedded block's
		 *  graph requests (read/toggle the embedded task) to the host router
		 *  under Tasks' own grants. Absent in preview / send-only stubs. */
		bp?: BpService;
	};
	/** Inbound Y.Doc update bridge for the inspector body editor (9.14.6).
	 *  Present only with a live shell runtime; absent in preview. */
	ydoc?: YDocBridge;
	on(event: LifecycleEvent["type"], handler: LifecycleHandler): { unsubscribe(): void };
};

declare global {
	interface Window {
		brainstorm: TasksBrainstorm | undefined;
	}
}

export function getBrainstorm(): TasksBrainstorm | null {
	return window.brainstorm ?? null;
}

/** Dispatch an `open` intent so the shell routes the entity to its
 *  primary opener (Tasks itself for a Task, the right app otherwise).
 *  Mirrors `apps/notes/src/store/runtime.ts` — resolves `false` when there
 *  is no runtime / intents service (standalone / preview drop / widget with
 *  no host) so callers can fall back gracefully. The dashboard widget's row
 *  click goes through this. */
export function openEntityInShell(target: {
	entityId: string;
	entityType?: string;
	mode?: NavigationMode;
	payload?: Record<string, unknown>;
}): Promise<boolean> {
	const intents = getBrainstorm()?.services.intents;
	if (!intents) return Promise.resolve(false);
	const openCapable = {
		services: {
			intents: {
				dispatch: (intent: { verb: string; payload: Record<string, unknown> }) =>
					intents.dispatch(intent as Omit<Intent, "source">),
			},
		},
	};
	return dispatchOpenVerb(openCapable, target);
}
