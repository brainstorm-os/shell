/**
 * Bridge to the shell's app preload. Mirrors `apps/journal/src/runtime.ts`
 * — we type only the surface the Code-Editor renderer uses today:
 * lifecycle `on("ready", …)` and `services.vaultEntities` (`list` +
 * optional `onChange`) for the read half, plus `services.intents` for
 * cross-app navigation.
 *
 * `getCodeEditorRuntime()` returns null when the renderer boots outside
 * the shell (`vite preview`, isolated dev) — exactly when the app falls
 * back to the in-memory demo dataset per [[preview-drop-pattern]].
 */

export type VaultEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	ownerAppId: string;
};

export type VaultLink = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	createdAt: number;
	deletedAt: number | null;
};

export type VaultSnapshot = {
	entities: VaultEntity[];
	links: VaultLink[];
};

type Subscription = { unsubscribe?: () => void } | undefined;

type VaultEntitiesService = {
	list(): Promise<VaultSnapshot>;
	onChange?(listener: () => void): Subscription;
};

export type IntentsService = {
	dispatch(intent: {
		verb: string;
		payload: Record<string, unknown>;
	}): Promise<unknown>;
};

/** Per-device, per-vault, app-namespaced settings — backs the "reopen the
 *  file I was editing" hint via `@brainstorm-os/sdk/last-viewed`. Structurally
 *  matches the SDK `SettingsService`; optional (absent on preview / older
 *  shells, where the hint is a no-op). */
export type SettingsService = {
	get<T = unknown>(key: string): Promise<T | null>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
};

/** The dashboard pin surface the shared object-menu drives. Optional —
 *  a thin/standalone runtime won't expose it and the menu degrades
 *  gracefully (Pin/Unpin simply isn't offered). */
export type DashboardService = {
	pin?(target: { entityId: string }): Promise<boolean>;
	unpin?(target: { entityId: string }): Promise<boolean>;
	isPinned?(target: { entityId: string }): Promise<boolean>;
};

/** Subset of the shell's entities service the Y.Doc resolver needs for
 *  the editor's write-through path. Mirrors the journal/notes mirror
 *  apps' shape so the code-editor uses the same shared resolver core
 *  (`@brainstorm-os/react-yjs`). Optional — older shells / the preview
 *  drop expose neither and the editor degrades to the in-memory
 *  textarea (edits live for the session, no persistence).
 *
 *  `update` is included so the explicit Save chord can denormalise the
 *  Y.Doc body back into the entity property bag (the v1 read path
 *  still sources `content` from properties; the migration that moves
 *  the read path to `loadDoc` follows 9.7.2). */
export type EntitiesDocService = {
	loadDoc(entityId: string): Promise<{ snapshotB64?: string | null }>;
	applyDoc(entityId: string, updateB64: string): Promise<unknown> | undefined;
	closeDoc(entityId: string): Promise<unknown> | undefined;
	update?(entityId: string, patch: Record<string, unknown>): Promise<unknown> | undefined;
	/** Create a `CodeFile/v1` for the in-app New-file action (9.7.5).
	 *  Optional — absent on older shells / the preview drop, where New file
	 *  is hidden. */
	create?(
		type: string,
		properties: Record<string, unknown>,
	): Promise<{ id: string } | null> | undefined;
	/** Soft-delete a `CodeFile/v1` for the in-app Delete action (F-238).
	 *  Idempotent + gated on `entities.write:<type>` host-side. Optional —
	 *  absent on older shells / the preview drop, where Delete is hidden. */
	delete?(entityId: string): Promise<unknown> | undefined;
};

/** Inbound update bridge — the main process pushes Y.Doc updates that
 *  arrived from another renderer / sync source. Same shape as the
 *  journal / notes mirror. */
export type YDocBridge = {
	onRemote(
		entityId: string,
		listener: (updateB64: string) => void,
	): { unsubscribe?: () => void } | (() => void);
};

/** A live `app:intent` push — emitted when a sibling app dispatches an
 *  intent at an already-open Code Editor window (the launcher focuses the
 *  existing window, so `launch` doesn't change; this re-delivers the verb). */
export type CodeEditorIntentEvent = {
	type: "intent";
	intent: { verb: string; payload?: Record<string, unknown> };
};

export type CodeEditorRuntime = {
	on(event: "ready", handler: () => void): void;
	on(event: "intent", handler: (event: CodeEditorIntentEvent) => void): { unsubscribe(): void };
	/** What the shell launched this window for. `reason === "open-entity"`
	 *  + `entityId` is how a cross-app `open` (e.g. the theme-editor's
	 *  "Edit in Code Editor") tells us which object to surface — including a
	 *  non-`CodeFile` object the editor adapts (a `StylePack/v1`'s CSS). */
	launch?: { reason?: string; entityId?: string } | undefined;
	/** Capability grants the shell stamped for this app; the shared
	 *  object-menu reads this to decide whether to offer Pin
	 *  (`dashboard.pin`). */
	capabilities?: readonly string[];
	services?: {
		vaultEntities?: VaultEntitiesService;
		intents?: IntentsService;
		dashboard?: DashboardService;
		entities?: EntitiesDocService;
		settings?: SettingsService;
	};
	ydoc?: YDocBridge;
};

declare global {
	interface Window {
		brainstorm?: CodeEditorRuntime | undefined;
	}
}

export function getCodeEditorRuntime(): CodeEditorRuntime | null {
	return (window as Window).brainstorm ?? null;
}

/** Canonical `CodeFile/v1` entity-type id — matches the manifest's
 *  `registrations.entityTypes[0].id` and the per-type capability scope.
 *  Centralised so the literal isn't re-typed across the projection +
 *  the future entities-repo. */
export const CODE_FILE_ENTITY_TYPE = "brainstorm/CodeFile/v1";
