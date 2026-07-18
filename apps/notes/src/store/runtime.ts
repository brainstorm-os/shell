// Bridge to the shell's app preload. Available once the runtime fires `ready`.
//
// We type the bits of `window.brainstorm` that Notes uses today. Full SDK
// typing comes from `@brainstorm/sdk-types` once we can import it cleanly
// from the app side (currently the SDK runtime is exposed by the preload,
// not the package — TypeScript only needs the shape).

import { type NavigationMode, openEntity as dispatchOpenVerb } from "@brainstorm/sdk";
import type {
	BlocksService,
	BpService,
	CoversService,
	Intent,
	IntentsService,
	PropertiesService,
	RosterService,
	SearchService,
	SharingService,
	VaultEntitiesService,
} from "@brainstorm/sdk-types";

type StorageValue = unknown;

export type StorageService = {
	put(key: string, value: StorageValue): Promise<void>;
	get<T = StorageValue>(key: string): Promise<T | null>;
	list(prefix?: string): Promise<{ key: string; value: StorageValue }[]>;
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

/** The slice of the shared entities service Notes uses (9.3.5.N-notes.3).
 *  `create` takes an optional caller id so Notes preserves its stable
 *  `n_…` ids (load-bearing for mention edges). Note rich text rides the
 *  property bag here; the body→Y.Doc move is the deliberately-last
 *  9.3.5.N-notes.4 rung. No link API exists — note→note edges are
 *  derived shell-side from the body (9.3.5.N-notes.3a). */
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
	loadDoc(id: string): Promise<{ snapshotB64: string; truncatedTail: boolean }>;
	applyDoc(id: string, updateB64: string): Promise<unknown>;
	closeDoc(id: string): Promise<void>;
};

type LifecycleEvent =
	| { type: "ready" }
	| { type: "intent"; intent: { verb: string; payload?: Record<string, unknown> } }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "close" };

type LifecycleHandler = (event: LifecycleEvent) => void;

/** Pin-any-object-to-dashboard surface (7.13). Drives the shared object
 *  menu's Pin / Unpin toggle. `dashboard.pin` is a default-minimum grant
 *  (no manifest entry needed), so this is normally present; the menu
 *  gates the toggle on its presence + the capability and silently omits
 *  Pin on an older shell. */
export type DashboardService = {
	pin(t: { entityId: string }): Promise<boolean>;
	unpin(t: { entityId: string }): Promise<boolean>;
	isPinned(t: { entityId: string }): Promise<boolean>;
};

export type NotesBrainstorm = {
	app: { id: string; version: string; sdkVersion: string };
	/** `intent` rides a cold-launch dispatch (`reason: "intent"`) — the
	 *  composer/action-surface delivery channel; F-241's `insert` arrives
	 *  this way when Notes wasn't running. */
	launch: {
		reason: string;
		entityId?: string;
		intent?: { verb: string; payload?: Record<string, unknown>; source?: string };
	};
	/** Granted capabilities — the shared object menu reads this to gate
	 *  the Pin toggle on `dashboard.pin` (default-minimum, normally
	 *  present). */
	capabilities?: readonly string[];
	/** Y.Doc remote-update subscription primitive. The Y.Doc replica + the
	 *  refcounted resolver live in the renderer (`store/ydoc-resolver.ts`)
	 *  — `contextBridge` cannot structured-clone a Y.Doc across worlds,
	 *  so the preload only exposes a per-entity subscription that fires
	 *  the renderer's callback with the base64 wire payload. Absent on
	 *  older shells / preview drops — the editor degrades to an offline
	 *  doc in that case. */
	ydoc?: {
		onRemote(entityId: string, callback: (updateB64: string) => void): () => void;
	};
	services: {
		storage: StorageService;
		/** Per-device settings (dictionary sort, view prefs) — non-synced.
		 *  Same get/put/delete/list shape as `storage`; backed by the shell's
		 *  per-device settings.db. */
		settings?: StorageService;
		/** Pin-any-object-to-dashboard (7.13). Present whenever the shell
		 *  exposes it; the shared object menu uses it for Pin / Unpin. */
		dashboard?: DashboardService;
		/** Vault-level property + dictionary catalog (VP-3 / VP-5). Apps
		 *  declare `properties.read` / `properties.write` in their
		 *  manifest; both are default-minimum grants so no prompt fires. */
		properties: PropertiesService;
		/** Collab-C6 — member roster + display profiles; the comment composer's
		 *  @-mention resolves vault members through it. `roster.read` is a
		 *  default-minimum grant. */
		roster?: RosterService;
		/** Collab-C5 — multi-user share/revoke over the Stage-10 spine. Notes
		 *  declares the scarce `sharing.share` cap so its object-menu "Share…"
		 *  opens the shared `<ShareDialog>`. */
		sharing?: SharingService;
		/** Stage 9.3 preview surface — used by the `@`-mention typeahead
		 *  to enumerate vault-wide entities for cross-app linking. Goes
		 *  away when the full entities service lands; the SDK swaps the
		 *  proxy, the manifest's `entities.read:*` declaration stays. */
		vaultEntities: VaultEntitiesService;
		/** Curated-verb intent bus. Used by mentions / link markup to
		 *  dispatch `open` against the picked entity so navigation
		 *  travels through the same path as launcher / right-click. */
		intents: IntentsService;
		/** Present once the shell exposes the real shared entities
		 *  service (9.3.5.N-notes.3). When set, `useNotes` prefers the
		 *  entities-backed repo over the kv silo; absent on older shells
		 *  / the preview drop, where the kv repo is used. */
		entities?: EntitiesService;
		/** Vault-wide lexical search (9.22). Default-granted `search.read`;
		 *  present whenever the shell is. Absent in the preview drop / older
		 *  shells — the notes-list search falls back to a local title scan. */
		search?: SearchService;
		/** Vault-shared cover content store (B7.2c). Default-granted
		 *  `covers.read`/`covers.write`; injected into `<CoverPicker>` so
		 *  its Image tab can upload + list. Absent on older shells. */
		covers?: CoversService;
		/** Block-registry resolver (9.4.3). `blocks.read` is a default
		 *  grant, so present whenever the shell is. The Notes runtime
		 *  builds a {@link BlockRendererRegistry} from it and threads it
		 *  through the {@link BlockRendererRegistryProvider} so the
		 *  `BlockEmbedNode` decorator can ask "which app renders this
		 *  blockId?" without a per-embed broker round-trip. Absent in
		 *  preview / older shells — `useBlockRenderer` falls back to
		 *  `Fallback{NoProvider}` and the existing shell-card path
		 *  paints. */
		blocks?: BlocksService;
		/** Block Protocol dispatch (9.4.5). Forwards an embedded block's BP
		 *  request to the host router; `<BpBlockMount bp={...}>` consumes it
		 *  for the block→host→block round-trip. No-cap structural routing;
		 *  enforcement is per-type on `entities` downstream. Absent on older
		 *  shells / the preview drop — the mount runs send-only (the stub
		 *  iframe emits no requests yet regardless). */
		bp?: BpService;
		/** Files host service (Stage 9.10) — present when `files.write` is
		 *  granted. Only the save half the B11.12 Export… flow needs is typed
		 *  here; the full surface lives in `@brainstorm/sdk-types` as
		 *  `FilesService`. Absent on older shells — Export… no-shows. */
		files?: {
			requestSave(opts?: {
				readonly title?: string;
				readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
				readonly suggestedName?: string;
			}): Promise<{ readonly handleId: string; readonly displayName: string } | null>;
			write(
				handle: { readonly handleId: string; readonly displayName: string },
				data: Uint8Array | ArrayBuffer,
			): Promise<void>;
		};
		/** Render-own-content-to-PDF (B11.12). Default-granted
		 *  `export.printToPdf`; present whenever the shell exposes it. The
		 *  Export… flow serialises the note to HTML and hands it here for a
		 *  sandboxed offscreen render. Absent on older shells — the PDF row
		 *  no-shows (Markdown/HTML still export). */
		export?: {
			printToPdf(input: { readonly html: string }): Promise<Uint8Array>;
		};
		/** Vault image-icon store (B11.14 custom emoji). Default-granted
		 *  `icons.read`/`icons.write`; the icon picker's Upload + Library tabs
		 *  consume it. Absent on older shells — those tabs stay placeholders. */
		icons?: {
			uploadBytes(
				filename: string,
				bytes: Uint8Array,
			): Promise<{ readonly url: string; readonly thumbUrl: string }>;
			list(): Promise<readonly { readonly url: string; readonly thumbUrl: string }[]>;
			delete(url: string): Promise<boolean>;
		};
	};
	on(event: LifecycleEvent["type"], handler: LifecycleHandler): { unsubscribe: () => void };
};

declare global {
	interface Window {
		brainstorm: NotesBrainstorm | undefined;
	}
}

export function getBrainstorm(): NotesBrainstorm | null {
	return window.brainstorm ?? null;
}

/** Dispatch a cross-app `open` through the shell intent bus so the
 *  navigation mode (`new-tab` / `new-window`, else focus-existing /
 *  replace) is honoured by the window manager. Shared by the editor host
 *  (mention / link / transclusion navigation) and the sidebar list
 *  (Cmd/Shift-click). Resolves `false` when there is no runtime / intents
 *  service (standalone / preview drop) so callers can fall back to an
 *  in-place select. */
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
