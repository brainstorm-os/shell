/**
 * Renderer-safe wire-shape types for the Net-1 network broker surface.
 *
 * Both `preload/index.ts` and renderer code (`settings/network-egress-panel.tsx`,
 * `feedback/feedback-dialog.tsx`, their tests) import from here, so the
 * renderer's value-import of `NetworkPrivacyMode` / `NetworkProxyMode` /
 * `EffectiveProxyKind` / `NetworkAuditOutcome` does NOT drag preload's
 * `import { contextBridge, ipcRenderer } from "electron"` into the renderer
 * bundle (the canonical trap warned about in CLAUDE.md; same precedent as
 * `sync-status-types.ts`).
 *
 * Main-process internals keep their own typed shapes in
 * `main/network/{privacy-config,proxy-config,audit-log,...}.ts`; this module
 * is the wire-shape only.
 */

export enum NetworkPrivacyMode {
	Off = "off",
	On = "on",
	Allowlist = "allowlist",
	Manual = "manual",
}

export type NetworkPrivacyConfig =
	| { mode: NetworkPrivacyMode.Off }
	| { mode: NetworkPrivacyMode.On }
	| { mode: NetworkPrivacyMode.Manual }
	| { mode: NetworkPrivacyMode.Allowlist; hosts: readonly string[] };

export enum NetworkProxyMode {
	Direct = "direct",
	System = "system",
	Manual = "manual",
	Pac = "pac",
}

export type NetworkProxyEndpoint = {
	host: string;
	port: number;
	authKey?: string;
};

export type NetworkProxyConfig =
	| { mode: NetworkProxyMode.Direct }
	| { mode: NetworkProxyMode.System }
	| {
			mode: NetworkProxyMode.Manual;
			httpProxy?: NetworkProxyEndpoint;
			httpsProxy?: NetworkProxyEndpoint;
			socks5Proxy?: NetworkProxyEndpoint;
			noProxy: readonly string[];
	  }
	| { mode: NetworkProxyMode.Pac; pacUrl: string };

export type VaultNetworkSettings = {
	privacy: NetworkPrivacyConfig;
	proxyOverride: NetworkProxyConfig | null;
};

export enum EffectiveProxyKind {
	Direct = "direct",
	Http = "http",
	Https = "https",
	Socks5 = "socks5",
	Deferred = "deferred",
}

export enum NetworkAuditOutcome {
	Completed = "completed",
	Refused = "refused",
	Aborted = "aborted",
	Errored = "errored",
}

export type NetworkAuditRecord = {
	ts: number;
	appId: string;
	method: string;
	host: string;
	path: string;
	status: number;
	bytes: number;
	durationMs: number;
	outcome: NetworkAuditOutcome;
	reason: string;
};

export type NetworkPerAppHostSummary = {
	host: string;
	count: number;
};

export type NetworkPerAppSummary = {
	appId: string;
	lastSeenMs: number;
	requestCount: number;
	sentBytes: number;
	receivedBytes: number;
	topHosts: readonly NetworkPerAppHostSummary[];
};

export type NetworkCacheStats = {
	entryCount: number;
	oldestMs: number | null;
	newestMs: number | null;
};

export type NetworkBrokerState = {
	proxy: NetworkProxyConfig;
	resolvedProxyKind: EffectiveProxyKind;
	privacy: NetworkPrivacyConfig;
	previewCacheStats: NetworkCacheStats;
};

export type NetworkAuditRequest = {
	fromMs?: number;
	toMs?: number;
	limit?: number;
};
