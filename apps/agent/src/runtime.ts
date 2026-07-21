/**
 * The slice of `window.brainstorm` this app reads. `vaultEntities` is the
 * live entity-snapshot service (subscribed through `@brainstorm-os/react-yjs`'s
 * `useVaultEntities`, never `onChange` directly); `entities` persists the
 * transcript; `ai` is the broker surface that routes to the local model;
 * `intents` is the cap-checked bus the agent loop dispatches tools through
 * (Agent-3 — intents-as-tools); `search` is the capability-gated, broker-
 * assembled retrieval surface the turn grounds + cites against (Agent-4 — the
 * app holds no `entities.read:*`, so all vault access rides this service).
 */

import type {
	AiService,
	EntitiesService,
	Intent,
	IntentsService,
	LaunchContext,
	PlatformService,
	SearchService,
	StorageService,
	Subscription,
	VaultEntitiesService,
} from "@brainstorm-os/sdk-types";

export type AgentRuntime = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	/** Why this window opened — `reason: "intent"` carries an inbound `process`
	 *  contribution (doc 63 / AS-3) dispatched from another app's menu. */
	launch?: LaunchContext;
	/** Lifecycle subscription — a `process` intent dispatched to an
	 *  already-running Agent window arrives here via the `app:intent` push. */
	on?: (
		type: "intent",
		handler: (event: { type: "intent"; intent: Intent }) => void,
	) => Subscription;
	services?: {
		vaultEntities?: VaultEntitiesService;
		entities?: EntitiesService;
		ai?: AiService;
		intents?: IntentsService;
		search?: SearchService;
		/** doc 63 — the read-only platform catalog the Agent reads to learn what
		 *  apps exist, the object types they produce, and their action vocabulary
		 *  (its capabilities/tools context). Gated by `platform.read`. */
		platform?: PlatformService;
		/** Agent-7 — the per-vault, app-private kv store holding the opt-in
		 *  long-term-memory flag (`agent:memory-enabled`, OFF by default). */
		storage?: StorageService;
	} | null;
};

declare global {
	interface Window {
		brainstorm?: AgentRuntime | undefined;
	}
}

export function getBrainstorm(): AgentRuntime | null {
	return typeof window !== "undefined" ? (window.brainstorm ?? null) : null;
}
