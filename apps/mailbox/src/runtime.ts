/**
 * The slice of `window.brainstorm` Mailbox reads. `vaultEntities` is the live
 * entity-snapshot service (subscribed through `@brainstorm-os/react-yjs`'s
 * `useVaultEntities`, never `onChange` directly) — the app is a viewer over
 * `Email/v1` / `MailFolder/v1` / `MailAccount/v1` rows the shell-side
 * `MailTransport` worker projects. `entities` flips `flags` (the only mutable
 * user state on received mail). Sending is intent-mediated (Mailbox-4):
 * compose/reply/forward arrive as intents (launch context or `app:intent`
 * push) and the composer dispatches the `send` intent through `intents`.
 */

import type {
	EntitiesService,
	Intent,
	IntentsService,
	LaunchContext,
	MailService,
	VaultEntitiesService,
} from "@brainstorm-os/sdk-types";

export type MailboxRuntime = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	/** Why this window opened — `reason: "intent"` carries an inbound
	 *  compose/reply/forward dispatched while Mailbox was closed. */
	launch?: LaunchContext;
	/** Lifecycle subscription — running-window intents arrive here via the
	 *  `app:intent` push channel. */
	on?: (type: "intent", handler: (event: { type: "intent"; intent: Intent }) => void) => unknown;
	services?: {
		vaultEntities?: VaultEntitiesService;
		entities?: EntitiesService;
		/** Mailbox-5 — Gmail connect / sync / disconnect (shell-side OAuth +
		 *  transport; this renderer only ever holds entity refs). */
		mail?: MailService;
		/** Mailbox-4 — the composer dispatches the `send` intent through the
		 *  shared bus (gated on `intents.dispatch:send`). */
		intents?: IntentsService;
	} | null;
};

declare global {
	interface Window {
		brainstorm?: MailboxRuntime | undefined;
	}
}

export function getBrainstorm(): MailboxRuntime | null {
	return typeof window !== "undefined" ? (window.brainstorm ?? null) : null;
}
