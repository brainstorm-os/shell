import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { DataStores } from "../storage/data-stores";
import { AccountRepository } from "./account-repo";
import {
	BILLING_READ_CAPABILITY,
	BillingMethod,
	BillingService,
	makeBillingServiceHandler,
} from "./billing-service";
import { EntitlementRepository } from "./entitlement-repo";
import { EntitlementStatus, FeatureFlag, PlanTier } from "./plan";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-billing-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("account");
	const accounts = new AccountRepository(db);
	const entitlements = new EntitlementRepository(db);
	return { vaultDir, stores, accounts, entitlements };
}

function envelope(method: string, args: unknown[] = [], app = "io.example.app"): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m1",
		app,
		service: "billing",
		method,
		args,
		caps: [],
	};
}

const grantingLedger: CapabilityLedger = {
	has: (_app: string, cap: string) => cap === BILLING_READ_CAPABILITY,
} as unknown as CapabilityLedger;

const denyingLedger: CapabilityLedger = { has: () => false } as unknown as CapabilityLedger;

describe("BillingService", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("reports the hardcoded Free entitlement on a signed-out vault", () => {
		const svc = new BillingService(env.accounts, env.entitlements);
		const ent = svc.getEntitlement();
		expect(ent).toEqual({
			plan: PlanTier.Free,
			features: [],
			status: EntitlementStatus.Active,
			accountId: null,
		});
		expect(svc.getPlan()).toBe(PlanTier.Free);
		expect(svc.hasFeature(FeatureFlag.HostedRelay)).toBe(false);
	});

	it("falls back to Free (with the account id) when linked but no entitlement cached", () => {
		env.accounts.link({ id: "acc_1", email: null, plan: PlanTier.Pro, linkedAt: 1, updatedAt: 1 });
		const svc = new BillingService(env.accounts, env.entitlements);
		expect(svc.getEntitlement()).toMatchObject({ plan: PlanTier.Free, accountId: "acc_1" });
	});

	it("reports a cached entitlement as Active before soft-expiry", () => {
		env.accounts.link({ id: "acc_1", email: null, plan: PlanTier.Pro, linkedAt: 1, updatedAt: 1 });
		env.entitlements.save({
			accountId: "acc_1",
			token: "h.c.s",
			plan: PlanTier.Pro,
			features: [FeatureFlag.BundledAiCredits],
			issuedAt: 1000,
			softExp: 2000,
			hardExp: 3000,
			cachedAt: 1000,
		});
		const svc = new BillingService(env.accounts, env.entitlements, () => 1500);
		const ent = svc.getEntitlement();
		expect(ent.plan).toBe(PlanTier.Pro);
		expect(ent.status).toBe(EntitlementStatus.Active);
		expect(ent.features).toEqual([FeatureFlag.BundledAiCredits]);
		expect(svc.hasFeature(FeatureFlag.BundledAiCredits)).toBe(true);
	});

	it("reports Grace between soft- and hard-expiry", () => {
		env.accounts.link({ id: "acc_1", email: null, plan: PlanTier.Pro, linkedAt: 1, updatedAt: 1 });
		env.entitlements.save({
			accountId: "acc_1",
			token: "h.c.s",
			plan: PlanTier.Pro,
			features: [],
			issuedAt: 1000,
			softExp: 2000,
			hardExp: 3000,
			cachedAt: 1000,
		});
		const svc = new BillingService(env.accounts, env.entitlements, () => 2500);
		expect(svc.getEntitlement().status).toBe(EntitlementStatus.Grace);
	});

	it("falls back to Free once the cached entitlement is hard-expired", () => {
		env.accounts.link({ id: "acc_1", email: null, plan: PlanTier.Pro, linkedAt: 1, updatedAt: 1 });
		env.entitlements.save({
			accountId: "acc_1",
			token: "h.c.s",
			plan: PlanTier.Pro,
			features: [FeatureFlag.HostedRelay],
			issuedAt: 1000,
			softExp: 2000,
			hardExp: 3000,
			cachedAt: 1000,
		});
		const svc = new BillingService(env.accounts, env.entitlements, () => 3000);
		expect(svc.getEntitlement()).toMatchObject({ plan: PlanTier.Free, accountId: "acc_1" });
	});
});

describe("makeBillingServiceHandler", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	function handlerWith(ledger: CapabilityLedger | null) {
		const svc = new BillingService(env.accounts, env.entitlements);
		return makeBillingServiceHandler({
			getService: async () => svc,
			getLedger: async () => ledger,
		});
	}

	it("returns the entitlement when billing.read is held", async () => {
		const handler = handlerWith(grantingLedger);
		await expect(handler(envelope(BillingMethod.GetEntitlement))).resolves.toMatchObject({
			plan: PlanTier.Free,
		});
		await expect(handler(envelope(BillingMethod.GetPlan))).resolves.toBe(PlanTier.Free);
	});

	it("denies when the app lacks billing.read", async () => {
		const handler = handlerWith(denyingLedger);
		await expect(handler(envelope(BillingMethod.GetEntitlement))).rejects.toMatchObject({
			name: "Denied",
		});
	});

	it("is Unavailable when there is no ledger (no vault session)", async () => {
		const handler = handlerWith(null);
		await expect(handler(envelope(BillingMethod.GetEntitlement))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("is Unavailable when the billing service is absent", async () => {
		const handler = makeBillingServiceHandler({
			getService: async () => null,
			getLedger: async () => grantingLedger,
		});
		await expect(handler(envelope(BillingMethod.GetPlan))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("hasFeature resolves a known flag and returns false for an unknown one", async () => {
		const handler = handlerWith(grantingLedger);
		await expect(
			handler(envelope(BillingMethod.HasFeature, [FeatureFlag.HostedRelay])),
		).resolves.toBe(false);
		await expect(handler(envelope(BillingMethod.HasFeature, ["warp-drive"]))).resolves.toBe(false);
	});

	it("rejects hasFeature without a string arg", async () => {
		const handler = handlerWith(grantingLedger);
		await expect(handler(envelope(BillingMethod.HasFeature, [42]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects an unknown method", async () => {
		const handler = handlerWith(grantingLedger);
		await expect(handler(envelope("teleport"))).rejects.toMatchObject({ name: "Invalid" });
	});

	it("skips the cap gate when getLedger is unwired (test-only authorization)", async () => {
		const svc = new BillingService(env.accounts, env.entitlements);
		const handler = makeBillingServiceHandler({ getService: async () => svc });
		await expect(handler(envelope(BillingMethod.GetPlan))).resolves.toBe(PlanTier.Free);
	});
});
