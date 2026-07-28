/**
 * Connector-6 — ADVERSARIAL probes against the `connectors.webhook*` broker
 * surface, kept as regression tests:
 *   - owner pinning across all three methods, including the ordering that
 *     stops a non-owner reaching the store at all,
 *   - the oracle-free denial (an unknown mapping and someone else's mapping
 *     are indistinguishable to the caller),
 *   - fail-closed behaviour when the ledger throws,
 *   - argument shapes (non-object, prototype pollution, non-string ref).
 */

import { LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAccount, ResolvedConnector } from "./connectors-request";
import { type ConnectorsServiceDeps, makeConnectorsServiceHandler } from "./connectors-service";
import type { OAuthBroker } from "./oauth-broker";

const OWNER = "io.brainstorm.github-issues";
const ATTACKER = "io.evil.sibling";

const resolvedConnector: ResolvedConnector = {
	connectorAppId: OWNER,
	provider: {
		authorizeUrl: "https://github.com/login/oauth/authorize",
		tokenUrl: "https://github.com/login/oauth/access_token",
		clientId: "abc",
		scopes: ["repo"],
		egressOrigins: ["https://api.github.com"],
	},
	apiBaseUrl: "https://api.github.com",
};
const resolvedAccount: ResolvedAccount = {
	...resolvedConnector,
	accountId: "account-1",
	connectorRef: "connector-1",
};

const envelope = (method: string, arg: unknown, app = OWNER) => ({
	v: 1 as const,
	msg: "m",
	app,
	service: "connectors",
	method,
	args: [arg],
	caps: [],
});

const allCaps = { has: () => true } as unknown as CapabilityLedger;

function harness(over: Partial<ConnectorsServiceDeps> = {}) {
	const mint = vi.fn(() => ({ routeId: "cw_r1", secret: "plain-secret" }));
	const getByMapping = vi.fn(() => ({ routeId: "cw_r1", createdAt: 1000 }));
	const revokeByMapping = vi.fn(() => true);
	const revokeByAccount = vi.fn(() => 0);
	const store = { mint, getByMapping, revokeByMapping, revokeByAccount };
	const deps: ConnectorsServiceDeps = {
		broker: {
			authorize: vi.fn(),
			connectWithToken: vi.fn(),
			revoke: vi.fn(),
		} as unknown as OAuthBroker,
		redirectProvider: { start: () => Promise.reject(new Error("unused")) },
		resolveConnector: () => Promise.resolve(resolvedConnector),
		resolveAccount: () => Promise.resolve(resolvedAccount),
		request: vi.fn(),
		getLedger: () => Promise.resolve(allCaps),
		resolveMappingOwner: async (ref: string) =>
			ref === "map-1" ? { accountId: "account-1", connectorAppId: OWNER } : null,
		getWebhookStore: async () => store,
		ingressInfo: async () => ({ loopbackBaseUrl: "http://127.0.0.1:4242", relayBaseUrl: null }),
		onWebhooksChanged: vi.fn(async () => {}),
		...over,
	};
	return { handler: makeConnectorsServiceHandler(deps), mint, getByMapping, revokeByMapping };
}

const METHODS = ["webhookRegister", "webhookStatus", "webhookRevoke"] as const;

describe("Connector-6 attack — connectors.webhook* broker surface", () => {
	it("a sibling app holding EVERY capability still cannot touch a mapping it does not own", async () => {
		const { handler, mint, getByMapping, revokeByMapping } = harness();
		for (const method of METHODS) {
			await expect(handler(envelope(method, { mappingRef: "map-1" }, ATTACKER))).rejects.toMatchObject(
				{ name: "Denied" },
			);
		}
		// The store is never reached — not even a read.
		expect(mint).not.toHaveBeenCalled();
		expect(getByMapping).not.toHaveBeenCalled();
		expect(revokeByMapping).not.toHaveBeenCalled();
	});

	it("an unknown mapping and someone else's mapping are indistinguishable (no existence oracle)", async () => {
		const { handler } = harness();
		const failure = async (method: string, ref: string) =>
			await Promise.resolve(handler(envelope(method, { mappingRef: ref }, ATTACKER))).then(
				() => ({ name: "resolved", message: "" }),
				(e: Error) => ({ name: e.name, message: e.message }),
			);
		for (const method of METHODS) {
			const notOwned = await failure(method, "map-1");
			const unknown = await failure(method, "no-such");
			expect(notOwned).toEqual({
				name: "Denied",
				message: `connectors.${method}: ${ATTACKER} has no webhook surface for map-1`,
			});
			// Same name, same sentence — only the echoed ref differs.
			expect(unknown.name).toBe(notOwned.name);
			expect(unknown.message.replace("no-such", "map-1")).toBe(notOwned.message);
		}
	});

	it("fail-closed: a ledger that throws yields Unavailable, never approval", async () => {
		const { handler, mint } = harness({
			getLedger: () => Promise.reject(new LedgerUnavailableError("locked")),
		});
		for (const method of METHODS) {
			await expect(handler(envelope(method, { mappingRef: "map-1" }))).rejects.toMatchObject({
				name: "Unavailable",
			});
		}
		expect(mint).not.toHaveBeenCalled();
	});

	it("fail-closed: `has` throwing mid-check yields Unavailable, never approval", async () => {
		const { handler, mint } = harness({
			getLedger: () =>
				Promise.resolve({
					has: () => {
						throw new LedgerUnavailableError("locked");
					},
				} as unknown as CapabilityLedger),
		});
		await expect(handler(envelope("webhookRegister", { mappingRef: "map-1" }))).rejects.toMatchObject(
			{ name: "Unavailable" },
		);
		expect(mint).not.toHaveBeenCalled();
	});

	it("the runtime network.ingress gate is checked on the RESOLVED owner, not a caller claim", async () => {
		// Owner holds `connectors.webhook` but not `network.ingress`.
		const { handler, mint } = harness({
			getLedger: () =>
				Promise.resolve({
					has: (_app: string, cap: string) => cap === "connectors.webhook",
				} as unknown as CapabilityLedger),
		});
		await expect(handler(envelope("webhookRegister", { mappingRef: "map-1" }))).rejects.toMatchObject(
			{ name: "Denied" },
		);
		expect(mint).not.toHaveBeenCalled();
		// status / revoke deliberately do NOT require the ingress grant — the
		// user must still be able to SEE and KILL an endpoint after revoking it.
		await expect(handler(envelope("webhookStatus", { mappingRef: "map-1" }))).resolves.toMatchObject({
			registered: true,
		});
		await expect(handler(envelope("webhookRevoke", { mappingRef: "map-1" }))).resolves.toMatchObject({
			ok: true,
		});
	});

	it("rejects hostile argument shapes without reaching the store", async () => {
		const { handler, mint, getByMapping, revokeByMapping } = harness();
		const bad: unknown[] = [
			null,
			undefined,
			"map-1",
			42,
			["map-1"],
			{},
			{ mappingRef: "" },
			{ mappingRef: 1 },
			{ mappingRef: { toString: () => "map-1" } },
			JSON.parse('{"__proto__":{"mappingRef":"map-1"}}'),
		];
		for (const method of METHODS) {
			for (const arg of bad) {
				await expect(handler(envelope(method, arg))).rejects.toMatchObject({ name: "Invalid" });
			}
		}
		expect(mint).not.toHaveBeenCalled();
		expect(getByMapping).not.toHaveBeenCalled();
		expect(revokeByMapping).not.toHaveBeenCalled();
		// And nothing polluted Object.prototype along the way.
		expect(({} as { mappingRef?: string }).mappingRef).toBeUndefined();
	});

	it("no response from the surface carries the secret except the one-time register", async () => {
		const { handler } = harness();
		const registered = await handler(envelope("webhookRegister", { mappingRef: "map-1" }));
		expect(JSON.stringify(registered)).toContain("plain-secret");
		for (const method of ["webhookStatus", "webhookRevoke"]) {
			const result = await handler(envelope(method, { mappingRef: "map-1" }));
			expect(JSON.stringify(result)).not.toContain("plain-secret");
		}
	});
});
