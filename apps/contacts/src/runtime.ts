/**
 * The slice of `window.brainstorm` this app reads. `vaultEntities` is the
 * live entity-snapshot service (subscribed through `@brainstorm/react-yjs`'s
 * `useVaultEntities`, never `onChange` directly); `entities` creates / edits
 * the `Person/v1` rows; `properties` backs the shared property-value cells;
 * `intents` routes an `open` to a linked company / person.
 */

import type {
	DashboardService,
	EntitiesService,
	IntentsService,
	PropertiesService,
	SettingsService,
	VaultEntitiesService,
} from "@brainstorm/sdk-types";

/** Files-host handle + the slice of the service the vCard import / export flow
 *  needs (Stage 9.10; caps `files.read` / `files.write`). Mirrors Calendar's
 *  ICS surface. */
export type ContactsFileHandle = { handleId: string; displayName: string };

export type ContactsFilesFilter = { name: string; extensions: readonly string[] };

/** Shell notification surface (Stage 7.7 `ui.notify`, cap `notifications.post`).
 *  Optional — a shell without it (or a denied capability) simply means the vCard
 *  import / export flow runs without a success / failure toast. Mirrors
 *  Calendar's `UiService`. */
export type UiService = {
	notify?(notification: { title: string; body?: string; kind?: string }): Promise<void> | void;
};

export type ContactsFilesService = {
	requestOpen(opts?: {
		title?: string;
		filters?: readonly ContactsFilesFilter[];
		multiple?: boolean;
	}): Promise<readonly ContactsFileHandle[]>;
	requestSave(opts?: {
		title?: string;
		suggestedName?: string;
		filters?: readonly ContactsFilesFilter[];
	}): Promise<ContactsFileHandle | null>;
	read(handle: ContactsFileHandle): Promise<Uint8Array>;
	write(handle: ContactsFileHandle, data: Uint8Array | ArrayBuffer): Promise<void>;
};

/** The lifecycle events the shell pushes to a running app window. Contacts
 *  only acts on `intent` (a sibling app — or Contacts itself — dispatching an
 *  `open` while this window is already focused), but the union mirrors the SDK
 *  runtime so the `on` signature stays honest. */
type ContactsLifecycleEvent =
	| { type: "ready" }
	| { type: "intent"; intent: { verb: string; payload?: Record<string, unknown> } }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "close" };

type ContactsLifecycleHandler = (event: ContactsLifecycleEvent) => void;

export type ContactsRuntime = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	/** Launch handshake — `reason: "open-entity"` carries the `entityId` the
	 *  shell asked us to open (a Company link routes here, since Contacts owns
	 *  the `Company/v1` opener). */
	launch?: { reason: string; entityId?: string };
	/** Subscribe to a shell lifecycle event. The `intent` event is the
	 *  running-window twin of `launch`: when Contacts is already open, the
	 *  launcher focuses the existing window and re-emits the `open` here
	 *  (`launch` does not update), so the company / person still resolves. */
	on?(
		event: ContactsLifecycleEvent["type"],
		handler: ContactsLifecycleHandler,
	): { unsubscribe: () => void };
	services?: {
		vaultEntities?: VaultEntitiesService;
		entities?: EntitiesService;
		properties?: PropertiesService;
		intents?: IntentsService;
		/** Pin-any-object-to-dashboard (7.13). Present whenever the shell
		 *  exposes it; the shared object menu reads it for Pin / Unpin. */
		dashboard?: DashboardService;
		/** Files-host service — vCard import / export saves / opens through it. */
		files?: ContactsFilesService;
		/** Shell notification surface — fires the vCard success / failure /
		 *  empty toasts (cap `notifications.post`). */
		ui?: UiService;
		/** Per-device, per-vault settings — backs "reopen the last contact I was
		 *  viewing" via `@brainstorm/sdk/last-viewed`. */
		settings?: SettingsService;
	} | null;
	/** Inbound Y.Doc update bridge — feeds the renderer-side resolver behind
	 *  `useYDoc(person.id)` so a body edit from another renderer / sync source
	 *  reaches the open contact. Present only with a live shell runtime.
	 *  Mirrors the Notes / Journal / Tasks / Bookmarks `ydoc` bridge. */
	ydoc?: {
		onRemote(
			entityId: string,
			listener: (updateB64: string) => void,
		): { unsubscribe?: () => void } | (() => void);
	};
};

declare global {
	interface Window {
		brainstorm?: ContactsRuntime | undefined;
	}
}

export function getBrainstorm(): ContactsRuntime | null {
	return typeof window !== "undefined" ? (window.brainstorm ?? null) : null;
}
