/**
 * Widget bridge handlers (Stage 7.3b → OQ-6 reversal). Dashboard widgets render
 * in sandboxed `<iframe>`s (DOM) instead of native `WebContentsView` overlays.
 * A sandboxed iframe has no preload, so its `window.brainstorm` is built in the
 * renderer over `postMessage` (see `@brainstorm-os/sdk/widget` iframe-bridge); the
 * DASHBOARD renderer proxies each call here, tagging it with the widget's appId.
 *
 * SECURITY (gated on a `/security-review`): this is a new privileged surface —
 * the dashboard can ask the main process to act as ANY app. The dashboard is
 * trusted (it derives the appId from the iframe element it created, which the
 * sandboxed iframe cannot forge), and every proxied call is still checked against
 * THAT app's capability grants via the same `CapabilityLedger.has` the broker
 * uses — so a widget never gains more than its app was granted. The surface is
 * deliberately tiny: resolve the iframe entry URL, list vault entities (read),
 * and dispatch an `open` intent. No general broker proxy.
 */

import { ipcMain } from "electron";
import { widgetFrameUrl } from "../dashboard/widget-frame-protocol";
import { listVaultEntities } from "../entities/vault-entities-service";
import type { IntentsBus } from "../intents/intents-bus";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { getActiveVaultSession } from "../vault/session";
import {
	filterWidgetSnapshot,
	parseWidgetListQuery,
	resolveWidgetListAccess,
} from "./widget-list-query";

/** The `open` intent is the only verb a widget may dispatch. */
const WIDGET_INTENT_VERB = "open";
/** Capability a widget app must hold to read the vault entity index. */
const ENTITIES_READ = "entities.read:*";
/** Capability a widget app must hold to dispatch the open intent. */
const INTENTS_OPEN = "intents.dispatch:open";

export type WidgetBridgeDeps = {
	getIntents: () => Promise<IntentsBus | null>;
};

export function registerWidgetBridgeHandlers(deps: WidgetBridgeDeps): void {
	// Resolve the `bswidget://<appId>/?v=<sha>` URL the dashboard sets as the widget
	// iframe's `src` (it appends the `?bs-widget=…` launch query). A custom scheme,
	// not file://, so it loads from a dev (http) AND prod (file) renderer and is a
	// distinct origin (see widget-frame-protocol). Null when the app is gone.
	ipcMain.handle(
		"widget-bridge:resolve-entry",
		async (_event, appId: unknown, _widgetId: unknown): Promise<string | null> => {
			if (typeof appId !== "string") return null;
			try {
				const session = getActiveVaultSession();
				if (!session) return null;
				const record = new AppsRepository(await session.dataStores.open("registry")).getActive(appId);
				return record ? widgetFrameUrl(appId, record.bundleSha256) : null;
			} catch (error) {
				console.warn(`[widget-bridge] resolve-entry ${appId} failed:`, error);
				return null;
			}
		},
	);

	// Proxy `vaultEntities.list()`, capability-scoped to the widget's app.
	// The optional query narrows the payload (F-384). A wildcard-read app may
	// list everything (the query is a pure narrowing); a scoped-read app is
	// admitted ONLY through a typed query covering its granted types — there
	// the filter is enforcement (see resolveWidgetListAccess).
	ipcMain.handle(
		"widget-bridge:list-entities",
		async (_event, appId: unknown, rawQuery?: unknown): Promise<unknown> => {
			if (typeof appId !== "string") return null;
			const session = getActiveVaultSession();
			if (!session) return null;
			const ledger = await session.capabilityLedger();
			const query = parseWidgetListQuery(rawQuery);
			const access = resolveWidgetListAccess((cap) => ledger.has(appId, cap), query);
			if (!access.allowed) {
				console.warn(`[widget-bridge] ${appId} denied: lacks ${ENTITIES_READ} or typed grants`);
				return { error: "capability-denied" };
			}
			const snapshot = await listVaultEntities(
				session.vaultPath,
				async () => new EntitiesRepository(await session.dataStores.open("entities")),
			);
			return access.enforced ? filterWidgetSnapshot(snapshot, access.enforced) : snapshot;
		},
	);

	// Proxy an `open` intent, scoped + capability-checked to the widget's app.
	ipcMain.handle(
		"widget-bridge:open-intent",
		async (_event, appId: unknown, payload: unknown): Promise<{ handled: boolean }> => {
			if (typeof appId !== "string" || !payload || typeof payload !== "object") {
				return { handled: false };
			}
			const session = getActiveVaultSession();
			if (!session) return { handled: false };
			const ledger = await session.capabilityLedger();
			if (!ledger.has(appId, INTENTS_OPEN)) {
				console.warn(`[widget-bridge] ${appId} denied: lacks ${INTENTS_OPEN}`);
				return { handled: false };
			}
			const bus = await deps.getIntents();
			if (!bus) return { handled: false };
			try {
				const result = await bus.dispatch(
					{ verb: WIDGET_INTENT_VERB, payload: payload as Record<string, unknown> },
					{ app: appId },
				);
				return { handled: result.handled };
			} catch (error) {
				console.warn(`[widget-bridge] open-intent ${appId} failed:`, error);
				return { handled: false };
			}
		},
	);
}
