/**
 * Bridge to the shell's app preload. Mirrors `apps/bookmarks/src/storage/
 * runtime.ts` — types only the slice of `window.brainstorm` the
 * theme-editor uses today: `services.entities` (read/write Theme +
 * TokenSet entities + enumerate installed components) and the lifecycle
 * `on("ready", …)` handshake.
 *
 * `getBrainstorm()` returns null when the renderer boots outside the
 * shell (e.g. `vite preview`), which is exactly when the app falls back
 * to the in-memory `DEFAULT_THEME_COMPOSITE` per [[preview-drop-pattern]].
 */

import type { TokenSetAppearance, VaultEntitiesService } from "@brainstorm-os/sdk-types";

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

/** The slice of the intents service used to hand a saved StylePack's CSS
 *  off to the code-editor app (the cross-app edit loop, 9.9.4). */
export type IntentsService = {
	dispatch(intent: { verb: string; payload: Record<string, unknown> }): Promise<unknown>;
};

/** Transient cross-surface theme preview (9.9.6; cap `theme.preview`). */
export type ThemePreviewService = {
	preview(spec: {
		vars: Record<string, string>;
		appearance?: TokenSetAppearance;
		durationMs?: number;
	}): Promise<void>;
	clearPreview(): Promise<void>;
};

type LifecycleEvent =
	| { type: "ready" }
	| { type: "intent"; intent: unknown }
	| { type: "suspend" }
	| { type: "resume" }
	| { type: "close" };

type LifecycleHandler = (event: LifecycleEvent) => void;

export type ThemeEditorBrainstorm = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	services?: {
		entities?: EntitiesService;
		intents?: IntentsService;
		theme?: ThemePreviewService;
		/** Coarse vault-change signal — the sanctioned reactivity source
		 *  (`@brainstorm-os/react-yjs` `useLiveEntities`) used to keep the saved-
		 *  theme + installed-icon-pack lists live across other-device writes. */
		vaultEntities?: VaultEntitiesService;
	} | null;
	on?(event: LifecycleEvent["type"], handler: LifecycleHandler): { unsubscribe(): void };
};

declare global {
	interface Window {
		brainstorm?: ThemeEditorBrainstorm | undefined;
	}
}

export function getBrainstorm(): ThemeEditorBrainstorm | null {
	return window.brainstorm ?? null;
}
