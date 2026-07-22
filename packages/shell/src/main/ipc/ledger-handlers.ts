/**
 * `ledger:*` IPC handlers — let the dashboard renderer (shell-trusted) read
 * and revoke capability grants from the active vault's ledger.
 *
 * Apps don't use these handlers — they go through the broker, which checks
 * capabilities. The dashboard is the only renderer that's allowed to talk
 * directly to the ledger because it runs the Settings panel.
 */

import { ipcMain } from "electron";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { getActiveVaultSession } from "../vault/session";
import { getCapabilityPromptHost } from "./capability-prompt";

export type SerializedGrant = {
	id: string;
	appId: string;
	capability: string;
	scope: string | null;
	grantedAt: number;
	grantedVia: "install" | "runtime";
};

/**
 * Normalize a user-typed egress host into a canonical `scheme://host[:port]`
 * origin for the `network.egress:<origin>` capability scope (11b.8b). Bare
 * hosts default to https; a wildcard is REFUSED (the `*` scope is exactly the
 * exfiltration surface 11b.8's review removed — the allowlist is per-origin
 * only). Returns null for anything unparseable or a non-http(s) scheme.
 */
export function normalizeEgressOrigin(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.includes("*")) return null;
	let url: URL;
	try {
		url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	return url.origin;
}

export function registerLedgerHandlers(): void {
	ipcMain.handle(
		"ledger:list-grants-by-app",
		async (): Promise<Record<string, SerializedGrant[]>> => {
			const session = getActiveVaultSession();
			if (!session) return {};
			const ledger = await session.capabilityLedger();
			const byApp: Record<string, SerializedGrant[]> = {};
			const shellGrants = ledger.listActive("shell");
			if (shellGrants.length > 0) byApp.shell = shellGrants;
			const registryDb = await session.dataStores.open("registry");
			const appsRepo = new AppsRepository(registryDb);
			for (const record of appsRepo.listActive()) {
				const grants = ledger.listActive(record.id);
				if (grants.length > 0) byApp[record.id] = grants;
			}
			return byApp;
		},
	);

	ipcMain.handle(
		"ledger:revoke",
		async (_event, appId: string, capability: string, scope: string | null): Promise<boolean> => {
			const session = getActiveVaultSession();
			if (!session) return false;
			const ledger = await session.capabilityLedger();
			return ledger.revoke(appId, capability, scope);
		},
	);

	// 11b.8b — request a per-origin `network.egress:<origin>` grant for an app
	// (the Automations HTTP-step allowlist). The grant itself flows through the
	// SANCTIONED fail-safe capability prompt (Deny-default, literal scope shown),
	// never a silent Settings-side grant: this handler only validates the origin
	// and asks. Per-origin only — a wildcard is rejected in the normalizer.
	ipcMain.handle(
		"ledger:request-egress-grant",
		async (
			_event,
			appId: unknown,
			rawOrigin: unknown,
		): Promise<{ granted: boolean; origin: string | null }> => {
			if (typeof appId !== "string" || appId.length === 0) return { granted: false, origin: null };
			const origin = normalizeEgressOrigin(rawOrigin);
			if (!origin) return { granted: false, origin: null };
			const reason = `Let ${appId} send network requests to ${origin}. Automations granted this can transmit vault data to that host — only allow hosts you trust.`;
			const granted = await getCapabilityPromptHost().request(
				appId,
				`network.egress:${origin}`,
				reason,
			);
			return { granted, origin };
		},
	);

	// 11b.8 — request the un-scoped `network.ingress` grant for an app (the
	// Automations webhook-trigger gate). Like the egress grant, the grant flows
	// through the sanctioned Deny-default capability prompt; this handler only
	// mediates it — never a silent Settings-side grant.
	ipcMain.handle(
		"ledger:request-ingress-grant",
		async (_event, appId: unknown): Promise<{ granted: boolean }> => {
			if (typeof appId !== "string" || appId.length === 0) return { granted: false };
			const reason = `Let ${appId} accept inbound web requests that trigger your workflows. A workflow fired this way runs with the automations you already granted it — only allow this if you intend to expose webhook endpoints.`;
			const granted = await getCapabilityPromptHost().request(appId, "network.ingress", reason);
			return { granted };
		},
	);
}
