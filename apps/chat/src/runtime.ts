/**
 * The slice of `window.brainstorm` this app reads. `vaultEntities` is the live
 * entity-snapshot service (subscribed through `@brainstorm/react-yjs`'s
 * `useVaultEntities`, never `onChange` directly); `entities` persists channels
 * + messages; `roster` resolves the channel's members + the local author's
 * self-asserted display profile (Collab-C6); `storage` holds per-device prefs.
 */

import type {
	EntitiesService,
	RosterService,
	SharingService,
	StorageService,
	VaultEntitiesService,
} from "@brainstorm/sdk-types";

export type ChatAppRuntime = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	services?: {
		vaultEntities?: VaultEntitiesService;
		entities?: EntitiesService;
		storage?: StorageService;
		roster?: RosterService;
		sharing?: SharingService;
	} | null;
};

declare global {
	interface Window {
		brainstorm?: ChatAppRuntime | undefined;
	}
}

export function getBrainstorm(): ChatAppRuntime | null {
	return typeof window !== "undefined" ? (window.brainstorm ?? null) : null;
}
