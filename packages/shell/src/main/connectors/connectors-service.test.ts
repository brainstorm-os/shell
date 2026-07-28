import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAccount, ResolvedConnector } from "./connectors-request";
import { type ConnectorsServiceDeps, makeConnectorsServiceHandler } from "./connectors-service";
import type { OAuthBroker } from "./oauth-broker";

const provider = {
	authorizeUrl: "https://github.com/login/oauth/authorize",
	tokenUrl: "https://github.com/login/oauth/access_token",
	clientId: "abc",
	scopes: ["repo"],
	egressOrigins: ["https://api.github.com"],
};

const resolvedConnector: ResolvedConnector = {
	connectorAppId: "io.brainstorm.github-issues",
	provider,
	apiBaseUrl: "https://api.github.com",
};

const resolvedAccount: ResolvedAccount = {
	...resolvedConnector,
	accountId: "account-1",
	connectorRef: "connector-1",
};

function envelope(method: string, arg: unknown, app = "io.brainstorm.github-issues") {
	return { v: 1 as const, msg: "m", app, service: "connectors", method, args: [arg], caps: [] };
}

function makeDeps(
	overrides: Partial<ConnectorsServiceDeps> = {},
	opts: { withSync?: boolean } = {},
): {
	deps: ConnectorsServiceDeps;
	authorize: ReturnType<typeof vi.fn>;
	connectWithToken: ReturnType<typeof vi.fn>;
	revoke: ReturnType<typeof vi.fn>;
	request: ReturnType<typeof vi.fn>;
	sync: ReturnType<typeof vi.fn>;
} {
	const authorize = vi.fn().mockResolvedValue({ accountId: "account-1" });
	const connectWithToken = vi.fn().mockResolvedValue({ accountId: "account-2" });
	const revoke = vi.fn().mockResolvedValue(undefined);
	const request = vi
		.fn()
		.mockResolvedValue({ status: 200, headers: {}, body: new Uint8Array(), finalUrl: "x" });
	const sync = vi.fn().mockResolvedValue({ status: "succeeded", pulled: 4 });
	const deps: ConnectorsServiceDeps = {
		broker: { authorize, connectWithToken, revoke } as unknown as OAuthBroker,
		redirectProvider: { start: () => Promise.reject(new Error("unused")) },
		resolveConnector: () => Promise.resolve(resolvedConnector),
		resolveAccount: () => Promise.resolve(resolvedAccount),
		request,
		getLedger: () => Promise.resolve({ has: () => true } as unknown as CapabilityLedger),
		...(opts.withSync === false ? {} : { sync }),
		...overrides,
	};
	return { deps, authorize, connectWithToken, revoke, request, sync };
}

describe("connectors service handler", () => {
	it("authorize routes to the broker and returns only an accountId", async () => {
		const { deps, authorize } = makeDeps();
		const handler = makeConnectorsServiceHandler(deps);
		const result = await handler(
			envelope("authorize", { connectorRef: "connector-1", externalAccountLabel: "octocat" }),
		);
		expect(result).toEqual({ accountId: "account-1" });
		expect(authorize).toHaveBeenCalledOnce();
	});

	it("denies authorize when the app lacks connectors.oauth", async () => {
		const { deps } = makeDeps({
			getLedger: () => Promise.resolve({ has: () => false } as unknown as CapabilityLedger),
		});
		const handler = makeConnectorsServiceHandler(deps);
		await expect(
			handler(envelope("authorize", { connectorRef: "c", externalAccountLabel: "x" })),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("connectToken seals a user token via the broker and returns only an accountId", async () => {
		const { deps, connectWithToken } = makeDeps();
		const handler = makeConnectorsServiceHandler(deps);
		const result = await handler(
			envelope("connectToken", {
				connectorRef: "connector-1",
				externalAccountLabel: "GitHub",
				token: "ghp_secret",
			}),
		);
		expect(result).toEqual({ accountId: "account-2" });
		expect(connectWithToken).toHaveBeenCalledWith(
			expect.objectContaining({ accessToken: "ghp_secret", connectorRef: "connector-1" }),
		);
	});

	it("sync routes to the sync engine", async () => {
		const { deps, sync } = makeDeps();
		const handler = makeConnectorsServiceHandler(deps);
		const result = await handler(envelope("sync", { mappingRef: "mapping-1" }));
		expect(result).toMatchObject({ pulled: 4 });
		expect(sync).toHaveBeenCalledWith("mapping-1");
	});

	it("sync returns Unavailable when the engine is not wired", async () => {
		const { deps } = makeDeps({}, { withSync: false });
		const handler = makeConnectorsServiceHandler(deps);
		await expect(handler(envelope("sync", { mappingRef: "m" }))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("revoke routes to the broker", async () => {
		const { deps, revoke } = makeDeps();
		const handler = makeConnectorsServiceHandler(deps);
		await expect(handler(envelope("revoke", { accountId: "account-1" }))).resolves.toEqual({
			ok: true,
		});
		expect(revoke).toHaveBeenCalledOnce();
	});

	it("request routes to the proxy with the resolved account", async () => {
		const { deps, request } = makeDeps();
		const handler = makeConnectorsServiceHandler(deps);
		await handler(envelope("request", { accountRef: "account-1", method: "GET", path: "/issues" }));
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ account: resolvedAccount, path: "/issues", method: "GET" }),
		);
	});

	it("rejects an unknown method and a non-object arg", async () => {
		const { deps } = makeDeps();
		const handler = makeConnectorsServiceHandler(deps);
		await expect(handler(envelope("bogus", {}))).rejects.toMatchObject({ name: "Invalid" });
		await expect(handler(envelope("authorize", null))).rejects.toMatchObject({ name: "Invalid" });
	});
});

// ─── Connector-6: webhook endpoint surface ──────────────────────────────────

function ledgerWithCaps(caps: string[]): CapabilityLedger {
	return { has: (_app: string, cap: string) => caps.includes(cap) } as unknown as CapabilityLedger;
}

function makeWebhookDeps(over: Partial<ConnectorsServiceDeps> = {}) {
	const mint = vi.fn(() => ({ routeId: "cw_r1", secret: "plain-secret" }));
	const getByMapping = vi.fn(() => ({ routeId: "cw_r1", createdAt: 1000 }));
	const revokeByMapping = vi.fn(() => true);
	const revokeByAccount = vi.fn(() => 2);
	const store = { mint, getByMapping, revokeByMapping, revokeByAccount };
	const onWebhooksChanged = vi.fn(async () => {});
	const { deps } = makeDeps({
		getLedger: () =>
			Promise.resolve(ledgerWithCaps(["connectors.webhook", "connectors.oauth", "network.ingress"])),
		resolveMappingOwner: async (mappingRef: string) =>
			mappingRef === "map-1"
				? { accountId: "account-1", connectorAppId: "io.brainstorm.github-issues" }
				: null,
		getWebhookStore: async () => store,
		ingressInfo: async () => ({
			loopbackBaseUrl: "http://127.0.0.1:4242",
			relayBaseUrl: null,
		}),
		onWebhooksChanged,
		...over,
	});
	return { deps, mint, getByMapping, revokeByMapping, revokeByAccount, onWebhooksChanged };
}

describe("connectors service — webhook endpoints (Connector-6)", () => {
	it("webhookRegister mints, re-registers routes, and reveals the secret exactly once (in the URL)", async () => {
		const { deps, mint, onWebhooksChanged } = makeWebhookDeps();
		const handler = makeConnectorsServiceHandler(deps);
		const result = (await handler(envelope("webhookRegister", { mappingRef: "map-1" }))) as {
			routeId: string;
			endpointPath: string;
			loopbackUrl: string | null;
			relayUrl: string | null;
		};
		expect(mint).toHaveBeenCalledWith({
			mappingId: "map-1",
			accountId: "account-1",
			connectorAppId: "io.brainstorm.github-issues",
		});
		expect(onWebhooksChanged).toHaveBeenCalledOnce();
		expect(result).toEqual({
			routeId: "cw_r1",
			endpointPath: "/wh/cw_r1/plain-secret",
			loopbackUrl: "http://127.0.0.1:4242/wh/cw_r1/plain-secret",
			relayUrl: null,
		});
	});

	it("denies webhookRegister without connectors.webhook", async () => {
		const { deps } = makeWebhookDeps({
			getLedger: () => Promise.resolve(ledgerWithCaps(["connectors.oauth", "network.ingress"])),
		});
		const handler = makeConnectorsServiceHandler(deps);
		await expect(handler(envelope("webhookRegister", { mappingRef: "map-1" }))).rejects.toMatchObject(
			{ name: "Denied" },
		);
	});

	it("denies webhookRegister without the runtime network.ingress grant (fail-closed)", async () => {
		const { deps, mint } = makeWebhookDeps({
			getLedger: () => Promise.resolve(ledgerWithCaps(["connectors.webhook"])),
		});
		const handler = makeConnectorsServiceHandler(deps);
		await expect(handler(envelope("webhookRegister", { mappingRef: "map-1" }))).rejects.toMatchObject(
			{ name: "Denied" },
		);
		expect(mint).not.toHaveBeenCalled();
	});

	it("denies the webhook surface to an app that does not own the mapping", async () => {
		const { deps, mint, revokeByMapping } = makeWebhookDeps();
		const handler = makeConnectorsServiceHandler(deps);
		for (const method of ["webhookRegister", "webhookStatus", "webhookRevoke"]) {
			await expect(
				handler(envelope(method, { mappingRef: "map-1" }, "io.evil.sibling")),
			).rejects.toMatchObject({ name: "Denied" });
		}
		expect(mint).not.toHaveBeenCalled();
		expect(revokeByMapping).not.toHaveBeenCalled();
	});

	it("webhookRegister rejects an unknown mapping (server-side resolve, never the caller's claim)", async () => {
		const { deps } = makeWebhookDeps();
		const handler = makeConnectorsServiceHandler(deps);
		// `Denied`, not `Invalid` — an unknown mapping and someone else's
		// mapping must be indistinguishable (no cross-app existence oracle).
		await expect(handler(envelope("webhookRegister", { mappingRef: "nope" }))).rejects.toMatchObject({
			name: "Denied",
		});
	});

	it("webhookStatus never returns the secret", async () => {
		const { deps } = makeWebhookDeps();
		const handler = makeConnectorsServiceHandler(deps);
		const result = await handler(envelope("webhookStatus", { mappingRef: "map-1" }));
		expect(result).toEqual({
			registered: true,
			routeId: "cw_r1",
			createdAt: 1000,
			loopbackBaseUrl: "http://127.0.0.1:4242",
			relayBaseUrl: null,
		});
		expect(JSON.stringify(result)).not.toContain("plain-secret");
	});

	it("webhookRevoke kills the endpoint and re-derives the route table", async () => {
		const { deps, revokeByMapping, onWebhooksChanged } = makeWebhookDeps();
		const handler = makeConnectorsServiceHandler(deps);
		await expect(handler(envelope("webhookRevoke", { mappingRef: "map-1" }))).resolves.toEqual({
			ok: true,
			removed: true,
		});
		expect(revokeByMapping).toHaveBeenCalledWith("map-1");
		expect(onWebhooksChanged).toHaveBeenCalledOnce();
	});

	it("account revoke cascades: every endpoint under the account dies with it", async () => {
		const { deps, revokeByAccount, onWebhooksChanged } = makeWebhookDeps();
		const handler = makeConnectorsServiceHandler(deps);
		await handler(envelope("revoke", { accountId: "account-1" }));
		expect(revokeByAccount).toHaveBeenCalledWith("account-1");
		expect(onWebhooksChanged).toHaveBeenCalledOnce();
	});

	it("webhookRegister is Unavailable without a vault session (no store)", async () => {
		const { deps } = makeWebhookDeps({ getWebhookStore: async () => null });
		const handler = makeConnectorsServiceHandler(deps);
		await expect(handler(envelope("webhookRegister", { mappingRef: "map-1" }))).rejects.toMatchObject(
			{ name: "Unavailable" },
		);
	});
});
