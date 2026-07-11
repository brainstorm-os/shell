/**
 * Browser-7 — the per-vault holder for the two web-privacy stores: the
 * site-permission grants ({@link SitePermissionStore}) and the per-host
 * egress aggregate ({@link WebEgressAudit}).
 *
 * Both are vault-scoped files but the webView service + IPC handlers are
 * wired once at startup, so this runtime re-keys lazily on the active vault
 * path (the `BrokerContext` closure pattern): the first call after a vault
 * switch loads that vault's files; calls with no active vault fail closed
 * (deny / drop / empty).
 *
 * `decision()` is sync (Electron's permission-check handler can't await) —
 * it reads the in-memory cache, returning the deny-default `null` until the
 * vault's grant file finishes loading. Mutations queue behind the load.
 */

import type { SitePermissionKind } from "@brainstorm/sdk-types";
import type {
	SitePermissionGrant,
	SiteTrustGrant,
	WebEgressHostSummary,
} from "../../web-privacy-wire-types";
import {
	SitePermissionStore,
	readSitePermissionGrants,
	writeSitePermissionGrants,
} from "./site-permissions";
import { SiteTrustStore, readSiteTrustGrants, writeSiteTrustGrants } from "./site-trust";
import { WebEgressAudit, readWebEgressRows, writeWebEgressRows } from "./web-egress-audit";

export type WebPrivacyRuntimeOptions = {
	/** Active vault path, or null when no vault is open. */
	getVaultPath: () => string | null;
	now?: () => number;
};

export type WebPrivacyRuntime = {
	permissions: {
		decision(origin: string, permission: SitePermissionKind): boolean | null;
		set(origin: string, permission: SitePermissionKind, allow: boolean): Promise<void>;
		revokeOrigin(origin: string): Promise<boolean>;
		list(): Promise<SitePermissionGrant[]>;
		/** Resolves once the active vault's grant file is loaded (tests). */
		whenLoaded(): Promise<void>;
	};
	egress: {
		record(host: string, blocked: boolean): void;
		summary(limit?: number): Promise<WebEgressHostSummary[]>;
	};
	trust: {
		/** Sync (the webRequest handler can't await) — strict default `false`
		 *  until the vault's trust file finishes loading. */
		isTrusted(origin: string): boolean;
		set(origin: string, trusted: boolean): Promise<void>;
		revokeOrigin(origin: string): Promise<boolean>;
		list(): Promise<SiteTrustGrant[]>;
		whenLoaded(): Promise<void>;
	};
	dispose(): Promise<void>;
};

type VaultState = {
	vaultPath: string;
	store: SitePermissionStore;
	trust: SiteTrustStore;
	audit: WebEgressAudit;
	loaded: Promise<void>;
};

export function createWebPrivacyRuntime(options: WebPrivacyRuntimeOptions): WebPrivacyRuntime {
	const now = options.now ?? Date.now;
	let state: VaultState | null = null;

	const current = (): VaultState | null => {
		const vaultPath = options.getVaultPath();
		// Fail-closed across vault close: no active vault ⇒ no store (deny /
		// drop / empty), never the previous vault's state.
		if (vaultPath === null) return null;
		if (state && state.vaultPath === vaultPath) return state;
		const previous = state;
		if (previous) void previous.audit.dispose();
		const store = new SitePermissionStore();
		const trust = new SiteTrustStore();
		const audit = new WebEgressAudit({
			save: (rows) => writeWebEgressRows(vaultPath, rows),
			now,
		});
		const loaded = (async () => {
			const [grants, trustGrants, rows] = await Promise.all([
				readSitePermissionGrants(vaultPath),
				readSiteTrustGrants(vaultPath),
				readWebEgressRows(vaultPath),
			]);
			for (const grant of grants) {
				store.set(grant.origin, grant.permission, grant.allow, grant.updatedAt);
			}
			for (const grant of trustGrants) trust.set(grant.origin, true, grant.updatedAt);
			// Additive merge — requests recorded during the load window keep
			// their counts.
			audit.mergeSeed(rows);
		})();
		state = { vaultPath, store, trust, audit, loaded };
		return state;
	};

	const persistGrants = async (s: VaultState): Promise<void> => {
		await writeSitePermissionGrants(s.vaultPath, s.store.list());
	};

	const persistTrust = async (s: VaultState): Promise<void> => {
		await writeSiteTrustGrants(s.vaultPath, s.trust.list());
	};

	return {
		permissions: {
			decision(origin, permission) {
				const s = current();
				return s ? s.store.decision(origin, permission) : null;
			},
			async set(origin, permission, allow) {
				const s = current();
				if (!s) return;
				await s.loaded;
				s.store.set(origin, permission, allow, now());
				await persistGrants(s);
			},
			async revokeOrigin(origin) {
				const s = current();
				if (!s) return false;
				await s.loaded;
				const removed = s.store.revokeOrigin(origin);
				if (removed) await persistGrants(s);
				return removed;
			},
			async list() {
				const s = current();
				if (!s) return [];
				await s.loaded;
				return s.store.list();
			},
			async whenLoaded() {
				await current()?.loaded;
			},
		},
		egress: {
			record(host, blocked) {
				current()?.audit.record(host, blocked);
			},
			async summary(limit) {
				const s = current();
				if (!s) return [];
				await s.loaded;
				return s.audit.summary(limit);
			},
		},
		trust: {
			isTrusted(origin) {
				const s = current();
				return s ? s.trust.isTrusted(origin) : false;
			},
			async set(origin, trusted) {
				const s = current();
				if (!s) return;
				await s.loaded;
				if (s.trust.set(origin, trusted, now())) await persistTrust(s);
			},
			async revokeOrigin(origin) {
				const s = current();
				if (!s) return false;
				await s.loaded;
				const removed = s.trust.revokeOrigin(origin);
				if (removed) await persistTrust(s);
				return removed;
			},
			async list() {
				const s = current();
				if (!s) return [];
				await s.loaded;
				return s.trust.list();
			},
			async whenLoaded() {
				await current()?.loaded;
			},
		},
		async dispose() {
			await state?.audit.dispose();
			state = null;
		},
	};
}
