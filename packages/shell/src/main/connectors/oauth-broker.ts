/**
 * Connector-2 — the shell OAuth broker.
 *
 * Runs the Authorization-Code-with-PKCE flow on behalf of a connector,
 * owns the redirect (OQ-CN-2: loopback primary), exchanges the code for
 * tokens, and stores those tokens in the Tier-2 credential store keyed by
 * the `ConnectorAccount` entity id. The connector app and renderer NEVER
 * receive the client secret or the tokens (doc 56 §The custody
 * invariant) — only the token-free `ConnectorAccount` entity is visible.
 *
 * All IO is injected (egress, token store, account entity port, notifier,
 * open-external, clock) so the broker is unit-tested without Electron.
 * The production wiring in `index.ts` binds egress to Net-1's
 * `executeNetworkFetch` (scoped to the connector's frozen origins), the
 * token store to `CredentialStore`, and the account port to the in-process
 * entities service.
 *
 * OQ-CN-4 (resolved): a failed refresh flips the account `authState` to
 * `expired`, notifies once, and throws — it does not loop or spam.
 *
 * Connector-SEC1 (token-endpoint egress hardening, Mailbox-5 pentest
 * 2026-06-11): when a provider config is built from a `Connector/v1`
 * ENTITY (`wiring.ts providerFromConnectorProps`), `tokenUrl` and
 * `egressOrigins` both come from that entity — so the origin-scope check
 * alone validates against caller-controllable data, and an app holding
 * `entities.write:Connector/v1` could repoint a connector's token endpoint
 * and exfiltrate the refresh token + client secret on the next refresh.
 * Every token-endpoint egress (`exchangeCode` / `refresh`) therefore also
 * requires the token URL's origin to be REGISTERED via
 * `registerTokenEndpoint` from a static source (shell code for built-in
 * providers, the signed manifest at install for marketplace connectors) —
 * never from entity properties. Fail-closed: nothing is registered by
 * default.
 */

import {
	AuthState,
	type ConnectorAccountDef,
	validateConnectorRequest,
} from "@brainstorm-os/sdk-types";
import { type ConnectorEgress, decodeJsonResponse, encodeForm } from "./egress";
import {
	buildAuthorizationUrl,
	computeCodeChallenge,
	generateCodeVerifier,
	generateState,
} from "./oauth-pkce";
import type { RedirectProvider } from "./oauth-redirect";

/** The non-secret bookkeeping persisted on the `ConnectorAccount` entity. */
export type StoredToken = {
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms when the access token expires (absent = never / unknown). */
	expiresAt?: number;
	scopes?: string[];
	/** Some providers (Google Desktop clients) require the installed-app
	 *  client secret at token exchange/refresh even with PKCE. It is sealed
	 *  here in Tier 2 alongside the tokens — never on an entity, never
	 *  toward a renderer — so the shell-side refresh can replay it. */
	clientSecret?: string;
};

/** The provider endpoints + client id a flow needs. The client SECRET is
 *  not here — PKCE public-client flows don't require one, and a connector
 *  manifest never ships a secret (doc 56). */
export type ProviderConfig = {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: readonly string[];
	/** The connector's frozen egress origins — token exchange is scoped to
	 *  them, the same set `connectors.request` enforces. */
	egressOrigins: readonly string[];
	extraAuthParams?: Readonly<Record<string, string>>;
};

/** Persists/loads tokens in Tier 2, keyed by (connectorAppId, accountId). */
export type TokenStore = {
	set(connectorAppId: string, accountId: string, token: StoredToken): Promise<void>;
	get(connectorAppId: string, accountId: string): Promise<StoredToken | null>;
	delete(connectorAppId: string, accountId: string): Promise<void>;
};

/** Minimal `ConnectorAccount` entity surface the broker drives. Writes are
 *  scoped to the connector's app identity so the entities-service cap check
 *  resolves against the connector's grants (`entities.write:ConnectorAccount`). */
export type ConnectorAccountPort = {
	create(connectorAppId: string, def: ConnectorAccountDef): Promise<{ id: string }>;
	update(
		connectorAppId: string,
		accountId: string,
		patch: Partial<ConnectorAccountDef>,
	): Promise<void>;
};

export type Notifier = (n: { title: string; body: string }) => void;

export type OAuthBrokerPorts = {
	egress: ConnectorEgress;
	tokens: TokenStore;
	accounts: ConnectorAccountPort;
	openExternal: (url: string) => Promise<void>;
	notify: Notifier;
	now?: () => number;
};

export type AuthorizeInput = {
	connectorAppId: string;
	connectorRef: string;
	externalAccountLabel: string;
	provider: ProviderConfig;
	redirectProvider: RedirectProvider;
	redirectTimeoutMs?: number;
	/** Installed-app client secret for providers whose token endpoint
	 *  requires one despite PKCE (Google Desktop clients). Supplied by the
	 *  user at connect time and sealed into the `StoredToken` (Tier 2). */
	clientSecret?: string;
};

type TokenEndpointResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
};

/** Fallback lifetime for a refreshable token the provider issued without an
 *  explicit `expires_in` (so the refresh engages before an opaque expiry). */
const OPAQUE_TOKEN_TTL_MS = 3_600_000;

export class OAuthBroker {
	private readonly ports: OAuthBrokerPorts;
	private readonly now: () => number;
	/** SEC1 — trusted token-endpoint origins. Empty by default (fail-closed);
	 *  populated only via `registerTokenEndpoint` from static sources. */
	private readonly tokenEndpointOrigins = new Set<string>();

	constructor(ports: OAuthBrokerPorts) {
		this.ports = ports;
		this.now = ports.now ?? (() => Date.now());
	}

	/**
	 * SEC1 — allow token-endpoint egress to this URL's origin. Call ONLY
	 * with a statically-known endpoint (shell code / a signed manifest at
	 * install) — never with a value read off an entity, or the gate would
	 * validate against the very data an `entities.write:Connector/v1` holder
	 * controls.
	 */
	registerTokenEndpoint(url: string): void {
		const origin = parseTokenEndpointOrigin(url);
		if (!origin) throw new Error(`oauth: cannot register unparseable token endpoint "${url}"`);
		this.tokenEndpointOrigins.add(origin);
	}

	/**
	 * Run the full authorize flow. Returns only `{ accountId }` — the token
	 * is sealed in Tier 2 and never returned. Throws if either provider
	 * endpoint is outside the connector's frozen egress origins.
	 */
	async authorize(input: AuthorizeInput): Promise<{ accountId: string }> {
		const { provider } = input;
		this.assertInScope(provider.egressOrigins, provider.authorizeUrl, "authorize endpoint");
		this.assertInScope(provider.egressOrigins, provider.tokenUrl, "token endpoint");
		this.assertTokenEndpointRegistered(provider.tokenUrl);

		const capture = await input.redirectProvider.start(
			input.redirectTimeoutMs !== undefined ? { timeoutMs: input.redirectTimeoutMs } : {},
		);
		let token: StoredToken;
		try {
			const codeVerifier = generateCodeVerifier();
			const state = generateState();
			const authUrl = buildAuthorizationUrl({
				authorizeUrl: provider.authorizeUrl,
				clientId: provider.clientId,
				redirectUri: capture.redirectUri,
				scopes: provider.scopes,
				state,
				codeChallenge: computeCodeChallenge(codeVerifier),
				...(provider.extraAuthParams ? { extraParams: provider.extraAuthParams } : {}),
			});
			await this.ports.openExternal(authUrl);
			const code = await capture.waitForCode(state);
			token = await this.exchangeCode(
				provider,
				code,
				codeVerifier,
				capture.redirectUri,
				input.clientSecret,
			);
			if (input.clientSecret) token.clientSecret = input.clientSecret;
		} finally {
			capture.close();
		}

		const created = await this.ports.accounts.create(input.connectorAppId, {
			connectorRef: input.connectorRef,
			externalAccountLabel: input.externalAccountLabel,
			scopesGranted: token.scopes ?? [...provider.scopes],
			authState: AuthState.Active,
			lastAuthAt: new Date(this.now()).toISOString(),
		});
		await this.ports.tokens.set(input.connectorAppId, created.id, token);
		return { accountId: created.id };
	}

	/**
	 * Connect with a user-supplied long-lived token (e.g. a GitHub Personal
	 * Access Token) instead of the OAuth flow. Same custody discipline: the
	 * token is sealed in Tier 2 keyed by the new account id and the entity
	 * holds no secret. The demonstrable path for connectors whose provider
	 * supports PATs without registering an OAuth client.
	 */
	async connectWithToken(input: {
		connectorAppId: string;
		connectorRef: string;
		externalAccountLabel: string;
		accessToken: string;
		scopes?: readonly string[];
	}): Promise<{ accountId: string }> {
		if (input.accessToken.trim().length === 0) {
			throw new Error("oauth: empty access token");
		}
		const token: StoredToken = { accessToken: input.accessToken.trim() };
		if (input.scopes && input.scopes.length > 0) token.scopes = [...input.scopes];
		const created = await this.ports.accounts.create(input.connectorAppId, {
			connectorRef: input.connectorRef,
			externalAccountLabel: input.externalAccountLabel,
			scopesGranted: input.scopes ? [...input.scopes] : [],
			authState: AuthState.Active,
			lastAuthAt: new Date(this.now()).toISOString(),
		});
		await this.ports.tokens.set(input.connectorAppId, created.id, token);
		return { accountId: created.id };
	}

	/**
	 * Return a currently-valid access token for `accountId`, refreshing
	 * shell-side if it is within the skew window of expiry. Internal — used
	 * by `connectors.request` (Connector-3); never an app-facing surface.
	 */
	async getValidAccessToken(input: {
		connectorAppId: string;
		accountId: string;
		provider: ProviderConfig;
		skewMs?: number;
	}): Promise<string> {
		const skew = input.skewMs ?? 60_000;
		const existing = await this.ports.tokens.get(input.connectorAppId, input.accountId);
		if (!existing) {
			throw new Error(`oauth: no token for account ${input.accountId}`);
		}
		const fresh = existing.expiresAt === undefined || existing.expiresAt - this.now() > skew;
		if (fresh) return existing.accessToken;
		return await this.refresh(input);
	}

	/**
	 * Force a shell-side refresh. On failure (no refresh token, provider
	 * error) flips the account to `expired`, notifies once, and throws
	 * (OQ-CN-4) — the caller's sync simply stops firing until reauth.
	 */
	async refresh(input: {
		connectorAppId: string;
		accountId: string;
		provider: ProviderConfig;
	}): Promise<string> {
		const { provider } = input;
		this.assertInScope(provider.egressOrigins, provider.tokenUrl, "token endpoint");
		this.assertTokenEndpointRegistered(provider.tokenUrl);
		const existing = await this.ports.tokens.get(input.connectorAppId, input.accountId);
		const refreshToken = existing?.refreshToken;
		if (!refreshToken) {
			await this.disableAccount(input.connectorAppId, input.accountId);
			throw new Error(`oauth: account ${input.accountId} has no refresh token`);
		}
		let token: StoredToken;
		try {
			const response = await this.ports.egress({
				url: provider.tokenUrl,
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
				body: encodeForm({
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					client_id: provider.clientId,
					...(existing?.clientSecret ? { client_secret: existing.clientSecret } : {}),
				}),
			});
			token = this.tokenFromResponse(
				decodeJsonResponse<TokenEndpointResponse>(response, "oauth refresh"),
				existing,
			);
		} catch (error) {
			await this.disableAccount(input.connectorAppId, input.accountId);
			throw error instanceof Error ? error : new Error(String(error));
		}
		await this.ports.tokens.set(input.connectorAppId, input.accountId, token);
		return token.accessToken;
	}

	/** Disconnect: delete the Tier-2 token and flip `authState` to revoked.
	 *  Idempotent — never leaves a half-state (doc 56). */
	async revoke(input: { connectorAppId: string; accountId: string }): Promise<void> {
		await this.ports.tokens.delete(input.connectorAppId, input.accountId);
		await this.ports.accounts.update(input.connectorAppId, input.accountId, {
			authState: AuthState.Revoked,
		});
	}

	private async exchangeCode(
		provider: ProviderConfig,
		code: string,
		codeVerifier: string,
		redirectUri: string,
		clientSecret?: string,
	): Promise<StoredToken> {
		this.assertTokenEndpointRegistered(provider.tokenUrl);
		const response = await this.ports.egress({
			url: provider.tokenUrl,
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: encodeForm({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: provider.clientId,
				code_verifier: codeVerifier,
				...(clientSecret ? { client_secret: clientSecret } : {}),
			}),
		});
		return this.tokenFromResponse(
			decodeJsonResponse<TokenEndpointResponse>(response, "oauth token exchange"),
			null,
		);
	}

	private tokenFromResponse(body: TokenEndpointResponse, previous: StoredToken | null): StoredToken {
		if (!body.access_token) {
			throw new Error("oauth: token response missing access_token");
		}
		const token: StoredToken = { accessToken: body.access_token };
		// A refresh response may omit the refresh token — keep the prior one.
		const refresh = body.refresh_token ?? previous?.refreshToken;
		if (refresh) token.refreshToken = refresh;
		if (typeof body.expires_in === "number") {
			token.expiresAt = this.now() + body.expires_in * 1000;
		} else if (token.refreshToken) {
			// The provider issued a refresh token but no explicit lifetime. Without
			// a recorded expiry `getValidAccessToken` would treat it as fresh
			// forever and never engage the refresh, so an opaque server-side expiry
			// 401s indefinitely. Assume a conservative TTL so the refresh fires.
			// PATs (no refresh token) intentionally stay non-expiring.
			token.expiresAt = this.now() + OPAQUE_TOKEN_TTL_MS;
		}
		if (body.scope) token.scopes = body.scope.split(/\s+/).filter(Boolean);
		else if (previous?.scopes) token.scopes = previous.scopes;
		// The client secret never comes back from the provider — carry it
		// across refreshes so the next refresh can replay it.
		if (previous?.clientSecret) token.clientSecret = previous.clientSecret;
		return token;
	}

	private async disableAccount(connectorAppId: string, accountId: string): Promise<void> {
		await this.ports.accounts.update(connectorAppId, accountId, { authState: AuthState.Expired });
		this.ports.notify({
			title: "Connector needs to reconnect",
			body: "A connector's authorization expired. Reconnect it in Settings to resume sync.",
		});
	}

	private assertInScope(origins: readonly string[], url: string, label: string): void {
		const decision = validateConnectorRequest(origins, url);
		if (!decision.allowed) {
			throw new Error(
				`oauth: ${label} ${url} is outside the connector's egress origins (${decision.reason})`,
			);
		}
	}

	/** SEC1 — refuse token-endpoint egress to any origin that was not
	 *  statically registered, regardless of the (possibly entity-derived)
	 *  `egressOrigins` scope. Runs before the refresh-token / client-secret
	 *  ever leave the credential store. */
	private assertTokenEndpointRegistered(url: string): void {
		const origin = parseTokenEndpointOrigin(url);
		if (!origin || !this.tokenEndpointOrigins.has(origin)) {
			throw new Error(`oauth: token endpoint ${url} is not a registered provider token endpoint`);
		}
	}
}

/** The normalized https origin of a token-endpoint URL, or null. Non-https
 *  schemes are refused outright — an OAuth token endpoint is never plain
 *  http, and a registered file/custom scheme would be a downgrade hole. */
function parseTokenEndpointOrigin(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	return parsed.origin.toLowerCase();
}
