/**
 * The slice of `window.brainstorm` this app reads. `vaultEntities` is the live
 * entity-snapshot service (subscribed through `@brainstorm-os/react-yjs`'s
 * `useVaultEntities`, never `onChange` directly); `entities` persists channels
 * + messages; `roster` resolves the channel's members + the local author's
 * self-asserted display profile (Collab-C6); `storage` holds per-device prefs.
 */

import type {
	EntitiesService,
	IntentsService,
	RosterService,
	SharingService,
	StorageService,
	UiService,
	VaultEntitiesService,
} from "@brainstorm-os/sdk-types";

/**
 * Agent-Teams-3 — deciding an agent's staged channel proposal (cap
 * `agents.approve`, declared in `manifest.json`). Typed HERE rather than in
 * `@brainstorm-os/sdk` on purpose: the app owns the shape it depends on, and
 * the SDK's service map is not this app's to extend.
 *
 * The replies are `unknown` because the app must PARSE them
 * (`readDecisionResult`) rather than trust a cast — an approval it cannot
 * confirm must never be reported to the user as one.
 */
export type AgentProposalsService = {
	approve(input: { messageId: string }): Promise<unknown>;
	discard(input: { messageId: string }): Promise<unknown>;
};

export type ChatAppRuntime = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	services?: {
		vaultEntities?: VaultEntitiesService;
		entities?: EntitiesService;
		storage?: StorageService;
		roster?: RosterService;
		sharing?: SharingService;
		/** Routes the widget's row-click / CTA `open` back to a channel, and the
		 *  approved-proposal card's "open it" back-link (cap
		 *  `intents.dispatch:open`). */
		intents?: IntentsService;
		/** Agent-Teams-3 — approve / discard an agent's proposal card. Optional
		 *  like every other slice here: a host that doesn't offer it leaves the
		 *  card's buttons disabled with a visible explanation, never dead. */
		agentProposals?: AgentProposalsService;
		/** 7.14 — mirror the unread count onto the dashboard app icon (cap
		 *  `ui.badge`). Only `badge` is used; typed as the full service so the
		 *  proxy shape stays honest. */
		ui?: UiService;
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
