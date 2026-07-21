import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { describe, expect, it, vi } from "vitest";
import {
	type ConnectorRequestDeps,
	type ResolvedAccount,
	makeConnectorRequest,
} from "./connectors-request";
import type { ConnectorEgress, ConnectorEgressResponse } from "./egress";
import type { OAuthBroker } from "./oauth-broker";

function response(body: string, headers: Record<string, string> = {}): ConnectorEgressResponse {
	return {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
		body: new TextEncoder().encode(body),
		finalUrl: "https://api.github.com/x",
	};
}

const account: ResolvedAccount = {
	accountId: "account-1",
	connectorRef: "connector-1",
	connectorAppId: "io.brainstorm.github-issues",
	apiBaseUrl: "https://api.github.com",
	provider: {
		authorizeUrl: "https://github.com/login/oauth/authorize",
		tokenUrl: "https://github.com/login/oauth/access_token",
		clientId: "abc",
		scopes: ["repo"],
		egressOrigins: ["https://api.github.com"],
	},
};

function fakeBroker(token = "AT"): OAuthBroker {
	return {
		getValidAccessToken: vi.fn().mockResolvedValue(token),
	} as unknown as OAuthBroker;
}

function allowLedger(): () => Promise<CapabilityLedger> {
	return () => Promise.resolve({ has: () => true } as unknown as CapabilityLedger);
}

describe("connectors.request — auth injection + egress scoping", () => {
	it("injects Authorization and never echoes it back", async () => {
		const captured: { url?: string; headers?: Record<string, string> } = {};
		const egress: ConnectorEgress = (req) => {
			captured.url = req.url;
			captured.headers = { ...req.headers };
			return Promise.resolve(response("[]", { authorization: "Bearer AT" }));
		};
		const deps: ConnectorRequestDeps = { egress, broker: fakeBroker(), getLedger: allowLedger() };
		const result = await makeConnectorRequest(deps)({
			envelopeApp: "io.brainstorm.github-issues",
			account,
			method: "GET",
			path: "/repos/o/r/issues",
		});
		expect(captured.url).toBe("https://api.github.com/repos/o/r/issues");
		expect(captured.headers?.authorization).toBe("Bearer AT");
		// The token is never in the response handed back to the connector.
		expect(result.headers.authorization).toBeUndefined();
		expect(JSON.stringify(result.headers)).not.toContain("AT");
	});

	it("refuses an out-of-scope absolute URL (Denied + logged)", async () => {
		const onRefused = vi.fn();
		const deps: ConnectorRequestDeps = {
			egress: () => Promise.reject(new Error("should not egress")),
			broker: fakeBroker(),
			getLedger: allowLedger(),
			onRefused,
		};
		await expect(
			makeConnectorRequest(deps)({
				envelopeApp: "io.brainstorm.github-issues",
				account,
				method: "GET",
				path: "https://evil.example.com/steal",
			}),
		).rejects.toMatchObject({ name: "Denied" });
		expect(onRefused).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://evil.example.com/steal" }),
		);
	});

	it("enforces the derived network.connect:<origin> cap server-side", async () => {
		const deps: ConnectorRequestDeps = {
			egress: () => Promise.resolve(response("[]")),
			broker: fakeBroker(),
			getLedger: () =>
				Promise.resolve({
					has: (_app: string, cap: string) => cap !== "network.connect:https://api.github.com",
				} as unknown as CapabilityLedger),
		};
		await expect(
			makeConnectorRequest(deps)({
				envelopeApp: "io.brainstorm.github-issues",
				account,
				method: "GET",
				path: "/issues",
			}),
		).rejects.toMatchObject({ name: "Denied" });
	});
});
