import { AuthState, type ConnectorAccountDef } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorEgress, ConnectorEgressResponse } from "./egress";
import {
	OAuthBroker,
	type OAuthBrokerPorts,
	type ProviderConfig,
	type StoredToken,
} from "./oauth-broker";
import type { RedirectProvider } from "./oauth-redirect";

function jsonResponse(obj: unknown, status = 200): ConnectorEgressResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(JSON.stringify(obj)),
		finalUrl: "https://github.com/login/oauth/access_token",
	};
}

const provider: ProviderConfig = {
	authorizeUrl: "https://github.com/login/oauth/authorize",
	tokenUrl: "https://github.com/login/oauth/access_token",
	clientId: "client-abc",
	scopes: ["repo"],
	egressOrigins: ["https://github.com"],
};

const fakeRedirect: RedirectProvider = {
	start: () =>
		Promise.resolve({
			redirectUri: "http://127.0.0.1:50000/callback",
			waitForCode: () => Promise.resolve("auth-code-123"),
			close: () => {},
		}),
};

function makePorts(overrides: Partial<OAuthBrokerPorts> = {}): {
	ports: OAuthBrokerPorts;
	tokenStore: Map<string, StoredToken>;
	accounts: ConnectorAccountDef[];
	notify: ReturnType<typeof vi.fn>;
} {
	const tokenStore = new Map<string, StoredToken>();
	const accounts: ConnectorAccountDef[] = [];
	const notify = vi.fn();
	const ports: OAuthBrokerPorts = {
		egress: (() =>
			Promise.resolve(
				jsonResponse({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "repo" }),
			)) as ConnectorEgress,
		tokens: {
			set: (appId, accountId, token) => {
				tokenStore.set(`${appId}:${accountId}`, token);
				return Promise.resolve();
			},
			get: (appId, accountId) => Promise.resolve(tokenStore.get(`${appId}:${accountId}`) ?? null),
			delete: (appId, accountId) => {
				tokenStore.delete(`${appId}:${accountId}`);
				return Promise.resolve();
			},
		},
		accounts: {
			create: (_connectorAppId, def) => {
				accounts.push(def);
				return Promise.resolve({ id: `account-${accounts.length}` });
			},
			update: (_connectorAppId, id, patch) => {
				const idx = Number(id.split("-")[1]) - 1;
				if (accounts[idx]) Object.assign(accounts[idx], patch);
				return Promise.resolve();
			},
		},
		openExternal: () => Promise.resolve(),
		notify,
		now: () => 1_000_000,
		...overrides,
	};
	return { ports, tokenStore, accounts, notify };
}

/** A broker with the test provider's token endpoint statically registered
 *  (Connector-SEC1) — the posture production wiring sets up for known
 *  providers. */
function makeBroker(ports: OAuthBrokerPorts): OAuthBroker {
	const broker = new OAuthBroker(ports);
	broker.registerTokenEndpoint(provider.tokenUrl);
	return broker;
}

describe("OAuthBroker.authorize", () => {
	it("runs PKCE, exchanges the code, seals the token, returns only an accountId", async () => {
		const { ports, tokenStore, accounts } = makePorts();
		const broker = makeBroker(ports);
		const result = await broker.authorize({
			connectorAppId: "io.brainstorm.github-issues",
			connectorRef: "connector-1",
			externalAccountLabel: "octocat",
			provider,
			redirectProvider: fakeRedirect,
		});
		expect(result).toEqual({ accountId: "account-1" });
		// Token is sealed in the store, never on the returned value.
		expect(JSON.stringify(result)).not.toContain("AT");
		expect(tokenStore.get("io.brainstorm.github-issues:account-1")?.accessToken).toBe("AT");
		// The account entity holds no secret.
		expect(accounts[0]?.authState).toBe(AuthState.Active);
		expect(JSON.stringify(accounts[0])).not.toContain("AT");
	});

	it("replays an installed-app client secret at exchange, seals it in Tier 2, never on the entity", async () => {
		const egress = vi
			.fn()
			.mockResolvedValue(jsonResponse({ access_token: "AT", refresh_token: "RT", expires_in: 60 }));
		const { ports, tokenStore, accounts } = makePorts({
			egress: egress as unknown as ConnectorEgress,
		});
		const broker = makeBroker(ports);
		await broker.authorize({
			connectorAppId: "io.brainstorm.mailbox",
			connectorRef: "connector-1",
			externalAccountLabel: "me@example.com",
			provider,
			redirectProvider: fakeRedirect,
			clientSecret: "GOCSPX-installed-app",
		});
		const exchangeBody = new TextDecoder().decode(egress.mock.calls[0]?.[0]?.body as Uint8Array);
		expect(exchangeBody).toContain("client_secret=GOCSPX-installed-app");
		expect(tokenStore.get("io.brainstorm.mailbox:account-1")?.clientSecret).toBe(
			"GOCSPX-installed-app",
		);
		expect(JSON.stringify(accounts[0])).not.toContain("GOCSPX");
	});

	it("rejects when the token endpoint is outside the frozen egress origins", async () => {
		const { ports } = makePorts();
		const broker = makeBroker(ports);
		await expect(
			broker.authorize({
				connectorAppId: "io.brainstorm.github-issues",
				connectorRef: "connector-1",
				externalAccountLabel: "octocat",
				provider: { ...provider, tokenUrl: "https://evil.example.com/token" },
				redirectProvider: fakeRedirect,
			}),
		).rejects.toThrow(/egress origins/);
	});
});

describe("OAuthBroker.connectWithToken", () => {
	it("seals a user-supplied token + creates a token-free account (no OAuth flow)", async () => {
		const { ports, tokenStore, accounts } = makePorts();
		const broker = makeBroker(ports);
		const result = await broker.connectWithToken({
			connectorAppId: "io.brainstorm.github-issues",
			connectorRef: "connector-1",
			externalAccountLabel: "GitHub",
			accessToken: "ghp_pat",
			scopes: ["repo"],
		});
		expect(result).toEqual({ accountId: "account-1" });
		expect(tokenStore.get("io.brainstorm.github-issues:account-1")?.accessToken).toBe("ghp_pat");
		expect(accounts[0]?.authState).toBe(AuthState.Active);
		expect(JSON.stringify(accounts[0])).not.toContain("ghp_pat");
	});

	it("rejects an empty token", async () => {
		const { ports } = makePorts();
		const broker = makeBroker(ports);
		await expect(
			broker.connectWithToken({
				connectorAppId: "app",
				connectorRef: "c",
				externalAccountLabel: "x",
				accessToken: "   ",
			}),
		).rejects.toThrow(/empty access token/);
	});
});

describe("OAuthBroker.getValidAccessToken", () => {
	it("returns a fresh token without refreshing", async () => {
		const { ports, tokenStore } = makePorts();
		tokenStore.set("app:acc", { accessToken: "fresh", expiresAt: 2_000_000 });
		const broker = makeBroker(ports);
		const token = await broker.getValidAccessToken({
			connectorAppId: "app",
			accountId: "acc",
			provider,
		});
		expect(token).toBe("fresh");
	});

	it("refreshes a near-expired token shell-side", async () => {
		const egress = vi
			.fn()
			.mockResolvedValue(jsonResponse({ access_token: "refreshed", expires_in: 3600 }));
		const { ports, tokenStore } = makePorts({ egress: egress as unknown as ConnectorEgress });
		tokenStore.set("app:acc", { accessToken: "stale", refreshToken: "RT", expiresAt: 1_000_500 });
		const broker = makeBroker(ports);
		const token = await broker.getValidAccessToken({
			connectorAppId: "app",
			accountId: "acc",
			provider,
		});
		expect(token).toBe("refreshed");
		expect(egress).toHaveBeenCalledOnce();
	});

	it("replays the sealed client secret on refresh and carries it forward", async () => {
		const egress = vi
			.fn()
			.mockResolvedValue(jsonResponse({ access_token: "refreshed", expires_in: 3600 }));
		const { ports, tokenStore } = makePorts({ egress: egress as unknown as ConnectorEgress });
		tokenStore.set("app:acc", {
			accessToken: "stale",
			refreshToken: "RT",
			expiresAt: 0,
			clientSecret: "GOCSPX-installed-app",
		});
		await makeBroker(ports).refresh({ connectorAppId: "app", accountId: "acc", provider });
		const refreshBody = new TextDecoder().decode(egress.mock.calls[0]?.[0]?.body as Uint8Array);
		expect(refreshBody).toContain("client_secret=GOCSPX-installed-app");
		expect(tokenStore.get("app:acc")?.clientSecret).toBe("GOCSPX-installed-app");
	});

	it("stamps a fallback expiry on a refreshable token issued without expires_in", async () => {
		// A refresh response with a refresh token but no explicit lifetime must
		// not be treated as fresh-forever — otherwise an opaque server-side
		// expiry 401s with no recovery. The broker assigns a conservative TTL.
		const egress = vi
			.fn()
			.mockResolvedValue(jsonResponse({ access_token: "rotated", refresh_token: "RT2" }));
		const { ports, tokenStore } = makePorts({ egress: egress as unknown as ConnectorEgress });
		tokenStore.set("app:acc", { accessToken: "stale", refreshToken: "RT", expiresAt: 1_000_500 });
		await makeBroker(ports).refresh({ connectorAppId: "app", accountId: "acc", provider });
		const stored = tokenStore.get("app:acc");
		expect(stored?.accessToken).toBe("rotated");
		expect(stored?.expiresAt).toBe(1_000_000 + 3_600_000);
	});
});

describe("OAuthBroker.refresh failure (OQ-CN-4)", () => {
	it("disables the account + notifies once when there is no refresh token", async () => {
		const { ports, tokenStore, accounts, notify } = makePorts();
		accounts.push({
			connectorRef: "c1",
			externalAccountLabel: "octocat",
			scopesGranted: [],
			authState: AuthState.Active,
		});
		tokenStore.set("app:account-1", { accessToken: "stale", expiresAt: 0 });
		const broker = makeBroker(ports);
		await expect(
			broker.refresh({ connectorAppId: "app", accountId: "account-1", provider }),
		).rejects.toThrow(/no refresh token/);
		expect(accounts[0]?.authState).toBe(AuthState.Expired);
		expect(notify).toHaveBeenCalledOnce();
	});

	it("disables the account when the provider rejects the refresh", async () => {
		const egress = vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
		const { ports, tokenStore, accounts, notify } = makePorts({
			egress: egress as unknown as ConnectorEgress,
		});
		accounts.push({
			connectorRef: "c1",
			externalAccountLabel: "octocat",
			scopesGranted: [],
			authState: AuthState.Active,
		});
		tokenStore.set("app:account-1", { accessToken: "stale", refreshToken: "RT", expiresAt: 0 });
		const broker = makeBroker(ports);
		await expect(
			broker.refresh({ connectorAppId: "app", accountId: "account-1", provider }),
		).rejects.toThrow(/400/);
		expect(accounts[0]?.authState).toBe(AuthState.Expired);
		expect(notify).toHaveBeenCalledOnce();
	});
});

describe("OAuthBroker.revoke", () => {
	it("deletes the token and flips authState to revoked", async () => {
		const { ports, tokenStore, accounts } = makePorts();
		accounts.push({
			connectorRef: "c1",
			externalAccountLabel: "octocat",
			scopesGranted: [],
			authState: AuthState.Active,
		});
		tokenStore.set("app:account-1", { accessToken: "AT" });
		const broker = makeBroker(ports);
		await broker.revoke({ connectorAppId: "app", accountId: "account-1" });
		expect(tokenStore.has("app:account-1")).toBe(false);
		expect(accounts[0]?.authState).toBe(AuthState.Revoked);
	});
});

describe("OAuthBroker token-endpoint allowlist (Connector-SEC1)", () => {
	// An entity-derived provider controls BOTH `tokenUrl` and
	// `egressOrigins`, so the origin-scope check alone is attacker-
	// satisfiable: widen the origins, repoint the token endpoint, wait for
	// the next refresh. The static registration is the gate that holds.
	const widened: ProviderConfig = {
		...provider,
		tokenUrl: "https://attacker.example/token",
		egressOrigins: ["https://github.com", "https://attacker.example"],
	};

	it("refuses a refresh to an unregistered token endpoint before any secret egresses", async () => {
		const egress = vi.fn();
		const { ports, tokenStore, accounts, notify } = makePorts({
			egress: egress as unknown as ConnectorEgress,
		});
		accounts.push({
			connectorRef: "c1",
			externalAccountLabel: "octocat",
			scopesGranted: [],
			authState: AuthState.Active,
		});
		tokenStore.set("app:account-1", {
			accessToken: "stale",
			refreshToken: "RT",
			clientSecret: "GOCSPX-installed-app",
			expiresAt: 0,
		});
		const broker = new OAuthBroker(ports);
		await expect(
			broker.refresh({ connectorAppId: "app", accountId: "account-1", provider: widened }),
		).rejects.toThrow(/not a registered provider token endpoint/);
		expect(egress).not.toHaveBeenCalled();
		// A config refusal is not an auth expiry — no account flip, no notify.
		expect(accounts[0]?.authState).toBe(AuthState.Active);
		expect(notify).not.toHaveBeenCalled();
	});

	it("refuses authorize to an unregistered token endpoint before the flow opens", async () => {
		const openExternal = vi.fn();
		const { ports } = makePorts({ openExternal });
		const broker = new OAuthBroker(ports);
		await expect(
			broker.authorize({
				connectorAppId: "app",
				connectorRef: "c1",
				externalAccountLabel: "octocat",
				provider: widened,
				redirectProvider: fakeRedirect,
			}),
		).rejects.toThrow(/not a registered provider token endpoint/);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("a registration for one origin does not admit another", async () => {
		const egress = vi.fn();
		const { ports, tokenStore } = makePorts({ egress: egress as unknown as ConnectorEgress });
		tokenStore.set("app:acc", { accessToken: "stale", refreshToken: "RT", expiresAt: 0 });
		const broker = makeBroker(ports); // registers https://github.com only
		await expect(
			broker.refresh({ connectorAppId: "app", accountId: "acc", provider: widened }),
		).rejects.toThrow(/not a registered provider token endpoint/);
		expect(egress).not.toHaveBeenCalled();
	});

	it("registration matches the origin, not the exact path", async () => {
		const { ports, tokenStore } = makePorts();
		tokenStore.set("app:acc", { accessToken: "stale", refreshToken: "RT", expiresAt: 0 });
		const broker = new OAuthBroker(ports);
		broker.registerTokenEndpoint("https://github.com/login/oauth/access_token");
		const token = await broker.refresh({ connectorAppId: "app", accountId: "acc", provider });
		expect(token).toBe("AT");
	});

	it("refuses to register a non-https or unparseable token endpoint", () => {
		const broker = new OAuthBroker(makePorts().ports);
		expect(() => broker.registerTokenEndpoint("http://insecure.example/token")).toThrow(
			/unparseable token endpoint/,
		);
		expect(() => broker.registerTokenEndpoint("not a url")).toThrow(/unparseable token endpoint/);
	});
});
