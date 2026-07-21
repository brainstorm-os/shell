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
