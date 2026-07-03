import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BillingCheckoutCycle,
	BillingCheckoutPlan,
	BillingSettingsFailure,
} from "../../shared/billing-settings-types";
import { DataStores } from "../storage/data-stores";
import { AccountRepository } from "./account-repo";
import { type BillingAccountDeps, BillingAccountService } from "./billing-account";
import { BillingEdgeClient } from "./billing-edge-client";
import { EntitlementRepository } from "./entitlement-repo";
import { EntitlementStatus, FeatureFlag, PlanTier, freeEntitlement } from "./plan";

const SUMMARY_BODY = {
	sub: "acct_1",
	plan: "plus",
	features: ["sync.hosted"],
	email: "razor@example.com",
	billingStatus: "active",
};

type Env = {
	vaultDir: string;
	stores: DataStores;
	accounts: AccountRepository;
	entitlements: EntitlementRepository;
	credential: { value: string | null };
	requests: Array<{ path: string; body: Record<string, unknown> }>;
	service: BillingAccountService;
};

async function setup(
	respond: (path: string) => { status: number; json: unknown } | null = () => ({
		status: 200,
		json: SUMMARY_BODY,
	}),
	overrides: Partial<BillingAccountDeps> = {},
): Promise<Env> {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-billing-account-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("account");
	const accounts = new AccountRepository(db);
	const entitlements = new EntitlementRepository(db);
	const credential: { value: string | null } = { value: null };
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const client = new BillingEdgeClient(async (path, body) => {
		requests.push({ path, body });
		return respond(path);
	});
	const service = new BillingAccountService({
		client,
		portalUrl: "https://account.example.test",
		readCredential: async () => credential.value,
		writeCredential: async (value) => {
			credential.value = value;
		},
		deleteCredential: async () => {
			const had = credential.value !== null;
			credential.value = null;
			return had;
		},
		getRepos: async () => ({ accounts, entitlements }),
		getEntitlement: async () => freeEntitlement(accounts.getLinked()?.id ?? null),
		getStorageBytes: async () => 4096,
		now: () => 1_000_000,
		...overrides,
	});
	return { vaultDir, stores, accounts, entitlements, credential, requests, service };
}

describe("BillingAccountService", () => {
	let env: Env;
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	describe("overview", () => {
		beforeEach(async () => {
			env = await setup();
		});

		it("reports the signed-out state without touching the network", async () => {
			const overview = await env.service.overview();
			expect(overview).toEqual({
				account: null,
				entitlement: freeEntitlement(),
				storageBytesUsed: 4096,
				portalUrl: "https://account.example.test",
			});
			expect(env.requests).toEqual([]);
		});

		it("returns null when no vault session is open", async () => {
			const gone = await setup(undefined, { getRepos: async () => null });
			try {
				expect(await gone.service.overview()).toBe(null);
			} finally {
				gone.stores.close();
				await rm(gone.vaultDir, { recursive: true, force: true });
			}
		});

		it("carries the account link once linked", async () => {
			await env.service.link("cred-1");
			const overview = await env.service.overview();
			expect(overview?.account).toEqual({
				id: "acct_1",
				email: "razor@example.com",
				plan: PlanTier.Plus,
				linkedAt: 1_000_000,
			});
		});

		it("degrades storage bytes to null when the inventory read throws", async () => {
			const broken = await setup(undefined, {
				getStorageBytes: async () => {
					throw new Error("no asset store");
				},
			});
			try {
				expect((await broken.service.overview())?.storageBytesUsed).toBe(null);
			} finally {
				broken.stores.close();
				await rm(broken.vaultDir, { recursive: true, force: true });
			}
		});
	});

	describe("link", () => {
		it("validates against /v1/account/summary, then stores credential + account row", async () => {
			env = await setup();
			const result = await env.service.link("  cred-1  ");
			expect(result.ok).toBe(true);
			expect(env.credential.value).toBe("cred-1");
			expect(env.accounts.getLinked()).toMatchObject({
				id: "acct_1",
				email: "razor@example.com",
				plan: PlanTier.Plus,
			});
			expect(env.requests[0]?.body).toEqual({ refreshCredential: "cred-1" });
		});

		it("stores NOTHING when billing-edge rejects the credential", async () => {
			env = await setup(() => ({ status: 401, json: { error: "unknown" } }));
			const result = await env.service.link("bad-cred");
			expect(result).toEqual({ ok: false, reason: BillingSettingsFailure.Unauthorized });
			expect(env.credential.value).toBe(null);
			expect(env.accounts.getLinked()).toBe(null);
		});

		it("rejects an empty / non-string credential without a network call", async () => {
			env = await setup();
			expect(await env.service.link("   ")).toEqual({
				ok: false,
				reason: BillingSettingsFailure.Invalid,
			});
			expect(await env.service.link(42)).toEqual({
				ok: false,
				reason: BillingSettingsFailure.Invalid,
			});
			expect(env.requests).toEqual([]);
		});
	});

	describe("refreshSummary", () => {
		it("is NotLinked before any credential is stored", async () => {
			env = await setup();
			expect(await env.service.refreshSummary()).toEqual({
				ok: false,
				reason: BillingSettingsFailure.NotLinked,
			});
		});

		it("updates the cached account row (plan drift after a portal upgrade)", async () => {
			let plan = "plus";
			env = await setup(() => ({ status: 200, json: { ...SUMMARY_BODY, plan } }));
			await env.service.link("cred-1");
			plan = "pro";
			const refreshed = await env.service.refreshSummary();
			expect(refreshed.ok && refreshed.value.plan).toBe(PlanTier.Pro);
			expect(env.accounts.getLinked()?.plan).toBe(PlanTier.Pro);
			// linkedAt survives the refresh — only updatedAt moves.
			expect(env.accounts.getLinked()?.linkedAt).toBe(1_000_000);
		});

		it("passes an offline failure through and keeps the cached row", async () => {
			let offline = false;
			env = await setup(() => (offline ? null : { status: 200, json: SUMMARY_BODY }));
			await env.service.link("cred-1");
			offline = true;
			expect(await env.service.refreshSummary()).toEqual({
				ok: false,
				reason: BillingSettingsFailure.Offline,
			});
			expect(env.accounts.getLinked()?.id).toBe("acct_1");
		});
	});

	describe("unlink", () => {
		it("removes credential, account row, and cached entitlement", async () => {
			env = await setup();
			await env.service.link("cred-1");
			env.entitlements.save({
				accountId: "acct_1",
				token: "h.c.s",
				plan: PlanTier.Plus,
				features: [FeatureFlag.HostedRelay],
				issuedAt: 1,
				softExp: 2,
				hardExp: 3,
				cachedAt: 1,
			});
			expect(await env.service.unlink()).toBe(true);
			expect(env.credential.value).toBe(null);
			expect(env.accounts.getLinked()).toBe(null);
			expect(env.entitlements.get("acct_1")).toBe(null);
		});

		it("returns false when nothing was linked", async () => {
			env = await setup();
			expect(await env.service.unlink()).toBe(false);
		});
	});

	describe("invoices", () => {
		it("requires a linked account", async () => {
			env = await setup();
			expect(await env.service.invoices()).toEqual({
				ok: false,
				reason: BillingSettingsFailure.NotLinked,
			});
		});

		it("fetches with the stored credential", async () => {
			env = await setup((path) =>
				path === "/v1/account/invoices"
					? { status: 200, json: { invoices: [] } }
					: { status: 200, json: SUMMARY_BODY },
			);
			await env.service.link("cred-1");
			expect(await env.service.invoices()).toEqual({ ok: true, value: [] });
			expect(env.requests.at(-1)).toEqual({
				path: "/v1/account/invoices",
				body: { refreshCredential: "cred-1" },
			});
		});
	});

	describe("checkout", () => {
		it("rejects an unknown plan / cycle without a network call", async () => {
			env = await setup();
			await env.service.link("cred-1");
			const before = env.requests.length;
			expect(await env.service.checkout("free", "monthly")).toEqual({
				ok: false,
				reason: BillingSettingsFailure.Invalid,
			});
			expect(await env.service.checkout("plus", "weekly")).toEqual({
				ok: false,
				reason: BillingSettingsFailure.Invalid,
			});
			expect(env.requests.length).toBe(before);
		});

		it("returns the hosted Checkout URL for a valid tier", async () => {
			env = await setup((path) =>
				path === "/v1/checkout/session"
					? { status: 200, json: { url: "https://checkout.stripe.com/c/1" } }
					: { status: 200, json: SUMMARY_BODY },
			);
			await env.service.link("cred-1");
			expect(await env.service.checkout(BillingCheckoutPlan.Pro, BillingCheckoutCycle.Yearly)).toEqual(
				{ ok: true, value: "https://checkout.stripe.com/c/1" },
			);
			expect(env.requests.at(-1)?.body).toEqual({
				refreshCredential: "cred-1",
				plan: "pro",
				cycle: "yearly",
			});
		});
	});

	it("entitlement status enums stay aligned with the effective entitlement", async () => {
		env = await setup();
		const overview = await env.service.overview();
		expect(overview?.entitlement.status).toBe(EntitlementStatus.Active);
	});
});
