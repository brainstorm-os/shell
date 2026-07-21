/**
 * Bridge to the shell's app preload. Mirrors `apps/tasks/src/storage/runtime.ts`
 * — types only the bits of `window.brainstorm` Bookmarks uses today
 * (`services.storage.kv` for owned-entity persistence + lifecycle
 * `on("ready", …)`).
 *
 * `getBrainstorm()` returns null when the renderer boots outside the
 * shell (e.g. `vite preview`), which is exactly when the app falls
 * back to the in-memory demo dataset per [[preview-drop-pattern]].
 */

import type {
	CoversService,
	LinkPreview,
	PropertiesService,
	SerializedBlock,
} from "@brainstorm-os/sdk-types";

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

/** The slice of the shared entities service Bookmarks uses (9.3.5.4).
 *  Bookmarks has no rich text — no Y.Doc methods. `create` takes an
 *  optional caller id so a bookmark keeps its stable id across the
 *  kv→shared transition. Mirrors `apps/tasks/src/storage/runtime.ts`. */
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
	 *  resolver behind `useYDoc(bookmark.id)`. Since 9.18.7 a bookmark carries a
	 *  `brainstorm/UniversalBody/v1` body for the detail view's editable notes;
	 *  this is the same contract Notes / Journal / Tasks use. Optional so the
	 *  property-only repository path (and its test mocks) don't depend on the
	 *  doc surface; the detail resolver checks for it and degrades to a
	 *  seed-only ephemeral body when absent. */
	loadDoc?(entityId: string): Promise<{ snapshotB64?: string | null }>;
	applyDoc?(entityId: string, updateB64: string): Promise<unknown> | undefined;
	closeDoc?(entityId: string): Promise<unknown> | undefined;
};

/** Inbound Y.Doc update bridge — the main process pushes updates that
 *  arrived from another renderer / sync source through this subscription.
 *  Mirrors the Journal / Notes / Tasks `ydoc` bridge; present only with a
 *  live shell runtime. */
export type YDocBridge = {
	onRemote(
		entityId: string,
		listener: (updateB64: string) => void,
	): { unsubscribe?: () => void } | (() => void);
};

/** The vault-entities aggregator slice Bookmarks uses for live-refresh
 *  (the staleness signal fires on every Bookmark or cross-app write).
 *  `list` isn't needed today — the app reads its own type via the
 *  `EntitiesService` proxy. `onChange` is enough to re-trigger the
 *  per-type `listAll` after a reseed / sibling write. */
export type VaultEntitiesService = {
	onChange(listener: () => void): { unsubscribe(): void };
};

type LifecycleEvent =
	| { type: "ready" }
	| { type: "intent"; intent: unknown }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "close" };

type LifecycleHandler = (event: LifecycleEvent) => void;

/** The intent-dispatch slice the object menu's Open action needs. */
export type IntentsService = {
	dispatch?: (i: { verb: string; payload: Record<string, unknown> }) => unknown;
};

/** The dashboard-pin slice the object menu's Pin/Unpin toggle needs. */
export type DashboardService = {
	pin?: (target: { entityId: string }) => Promise<boolean>;
	unpin?: (target: { entityId: string }) => Promise<boolean>;
	isPinned?: (target: { entityId: string }) => Promise<boolean>;
};

/** The link-preview + readable slice of the shell network broker. `preview`
 *  (gated on `network.preview`) scrapes a saved link's favicon + OG image;
 *  `readable` (gated on `network.readable`) additionally returns the cleaned
 *  page body as `SerializedBlock[]` for the detail view. Both reject when the
 *  per-vault privacy policy blocks egress or the fetch fails. */
export type NetworkPreviewService = {
	preview(input: { url: string; locale?: string }): Promise<LinkPreview>;
	readable(input: { url: string; locale?: string }): Promise<{
		preview: LinkPreview;
		blocks: SerializedBlock[] | null;
	}>;
};

export type BookmarksBrainstorm = {
	app?: { id: string; version: string; sdkVersion: string };
	/** Capabilities the shell granted this app instance — read by the
	 *  shared object menu to gate the dashboard-pin toggle. */
	capabilities?: readonly string[];
	services?: {
		storage?: StorageService;
		/** Present once the shell exposes the shared entities service.
		 *  When available Bookmarks reads/writes the shared object space
		 *  (9.3.5.4) instead of its `kv.json` silo. */
		entities?: EntitiesService;
		/** Vault-entities aggregator. We only consume `onChange` — it
		 *  fans on every cross-app write + dev reseed, so we use it to
		 *  re-pull the bookmark list rather than sitting on the boot
		 *  snapshot forever. */
		vaultEntities?: VaultEntitiesService;
		/** Cross-app open/compose/quick-look dispatch (manifest declares
		 *  `intents.dispatch:open|compose|quick-look`). */
		intents?: IntentsService;
		/** Pin-to-dashboard surface (gated on `dashboard.pin`). */
		dashboard?: DashboardService;
		/** Link-preview scrape (gated on `network.preview`) — favicon + OG
		 *  cover for a newly-saved bookmark. */
		network?: NetworkPreviewService;
		/** Vault properties (gated on `properties.read`/`write`) — backs the
		 *  detail view's shared property-value cells. */
		properties?: PropertiesService;
		/** Vault covers (gated on `covers.read`/`write`) — backs the detail
		 *  view's cover picker (upload / library). */
		covers?: CoversService;
	} | null;
	/** Inbound Y.Doc update bridge — feeds the renderer-side resolver behind
	 *  `useYDoc(bookmark.id)` so a body edit from another renderer / sync source
	 *  reaches the open detail. Present only with a live shell runtime. */
	ydoc?: YDocBridge;
	on?(event: LifecycleEvent["type"], handler: LifecycleHandler): { unsubscribe(): void };
};

declare global {
	interface Window {
		brainstorm?: BookmarksBrainstorm | undefined;
	}
}

export function getBrainstorm(): BookmarksBrainstorm | null {
	return window.brainstorm ?? null;
}
