/**
 * Bridge to the shell app preload — types only the slice of
 * `window.brainstorm` Books uses: the launch handshake, the `app:intent`
 * push channel, the live vault snapshot (`vaultEntities`, subscribed
 * through `@brainstorm-os/react-yjs`'s `useVaultEntities` — never `onChange`
 * directly), and the capability-gated `entities` service (resolve a Book +
 * its backing File row; persist reading state; remove a book). Null outside
 * the shell (the standalone preview keeps the sample book).
 */

import type {
	CoversService,
	Entity,
	EntityQuery,
	FilesService,
	SettingsService,
	VaultEntitiesService,
} from "@brainstorm-os/sdk-types";

export type BooksOpenPayload = {
	entityId?: unknown;
};

type IntentEvent = {
	type: string;
	intent?: { verb?: string; payload?: BooksOpenPayload };
};

/** The minted entity from `entities.create` — Books reads only the new id. */
export type CreatedEntity = { id?: unknown };

export type BooksEntitiesService = {
	get?: (id: string) => Promise<unknown>;
	/** Type-scoped live read for the library shelf — `entities.read:<type>`
	 *  gated + server-side filtered (NOT the `entities.read:*` wildcard that
	 *  `vaultEntities.list()` demands), so Books keeps its narrow capability
	 *  set yet still sees its own `Book/v1` rows. */
	query?: (query: EntityQuery) => Promise<Entity[]>;
	create?: (
		type: string,
		properties: Record<string, unknown>,
		id?: string,
	) => Promise<CreatedEntity>;
	update?: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
	delete?: (id: string) => Promise<unknown>;
};

/** The `open` intent the object menu dispatches to route a book through the
 *  registered opener (focus-existing + cross-app nav). Books holds the
 *  `intents.dispatch:open` grant; the menu's Open item is live because of it. */
export type BooksIntentsService = {
	dispatch?: (intent: { verb: string; payload: Record<string, unknown> }) => unknown;
};

export type BooksRuntime = {
	launch?: { reason?: string } & BooksOpenPayload;
	/** Granted capabilities — the shared object menu reads this to gate the
	 *  Open item (`intents.dispatch:open`, a default Books grant). */
	capabilities?: readonly string[];
	on?: (
		event: "intent",
		handler: (e: IntentEvent) => void,
	) => { unsubscribe?: () => void } | unknown;
	services?: {
		vaultEntities?: VaultEntitiesService | null;
		entities?: BooksEntitiesService | null;
		/** Cross-app intent dispatch — the object menu's Open item routes
		 *  through it so opening a book inherits focus-existing + the
		 *  registered opener. Null on a preview build. */
		intents?: BooksIntentsService | null;
		/** The Files host service — picker + encrypted asset-store import for
		 *  bringing an external EPUB / PDF into the library (9.21.2). Null on a
		 *  shell / preview build without `files.read` granted. */
		files?: FilesService | null;
		/** The covers host service — stores a rendered page-one image into the
		 *  vault cover store so a freshly-imported book gets a real cover
		 *  (`covers.write` is a default app grant). Null on a preview build. */
		covers?: CoversService | null;
		/** Per-device, per-vault, app-namespaced settings — backs the
		 *  "reopen the book I was reading" hint via `@brainstorm-os/sdk/last-viewed`.
		 *  Null on a preview build. */
		settings?: SettingsService | null;
	} | null;
};

export function getBooksRuntime(): BooksRuntime | undefined {
	return (window as unknown as { brainstorm?: BooksRuntime }).brainstorm;
}
