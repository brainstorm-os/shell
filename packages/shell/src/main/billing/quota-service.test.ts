/**
 * 14.7 — `QuotaService`: the product-side quota gate + panel state.
 *
 * Pins the enforcement posture: fully inert when unlinked / unmetered /
 * against an ungated (open/self-hosted) relay; fail-closed for paid writes
 * when a metered, gated account's usage can't be read; strict would-exceed
 * math otherwise. Plus the pause signal + usage-cache mechanics.
 */

import { describe, expect, it, vi } from "vitest";
import { EntitlementStatus, PlanTier, freeEntitlement } from "../../shared/billing-types";
import {
	AttachmentSyncPauseReason,
	QuotaResource,
	UploadQuotaDecision,
} from "../../shared/quota-types";
import type { Entitlement } from "./plan";
import { QuotaService, type QuotaServiceDeps } from "./quota-service";

const GIB = 1024 * 1024 * 1024;

function entitled(plan: PlanTier, accountId: string | null = "acct_1"): Entitlement {
	return { plan, features: [], status: EntitlementStatus.Active, accountId };
}

function makeService(overrides: Partial<QuotaServiceDeps> = {}): QuotaService {
	return new QuotaService({
		getEntitlement: async () => entitled(PlanTier.Plus),
		getStorageBytes: async () => 0,
		isGatedRelay: () => true,
		...overrides,
	});
}

describe("QuotaService.decideUpload", () => {
	it("is fully inert with no vault session (null entitlement)", async () => {
		const service = makeService({ getEntitlement: async () => null });
		expect(await service.decideUpload(1)).toBe(UploadQuotaDecision.Allowed);
	});

	it("is fully inert when no account is linked — the free-local default", async () => {
		const getStorageBytes = vi.fn(async () => 50 * GIB);
		const service = makeService({
			getEntitlement: async () => freeEntitlement(),
			getStorageBytes,
		});
		expect(await service.decideUpload(10 * GIB)).toBe(UploadQuotaDecision.Allowed);
		// Inert mode never even reads usage.
		expect(getStorageBytes).not.toHaveBeenCalled();
	});

	it("is inert for an unmetered plan (enterprise)", async () => {
		const service = makeService({
			getEntitlement: async () => entitled(PlanTier.Enterprise),
			getStorageBytes: async () => Number.MAX_SAFE_INTEGER,
		});
		expect(await service.decideUpload(1)).toBe(UploadQuotaDecision.Allowed);
	});

	it("never gates uploads to an ungated (open / self-hosted) relay", async () => {
		const service = makeService({
			getEntitlement: async () => entitled(PlanTier.Free),
			getStorageBytes: async () => 5 * GIB,
			isGatedRelay: () => false,
		});
		expect(await service.decideUpload(1)).toBe(UploadQuotaDecision.Allowed);
	});

	it("allows a push that fits under the ceiling", async () => {
		const service = makeService({ getStorageBytes: async () => 19 * GIB });
		expect(await service.decideUpload(GIB)).toBe(UploadQuotaDecision.Allowed);
	});

	it("blocks a push that would exceed the ceiling (would-exceed, not already-over)", async () => {
		const service = makeService({ getStorageBytes: async () => 19 * GIB });
		expect(await service.decideUpload(GIB + 1)).toBe(UploadQuotaDecision.OverQuota);
	});

	it("blocks everything on the free tier against a gated node (zero allowance)", async () => {
		const service = makeService({
			getEntitlement: async () => entitled(PlanTier.Free),
			getStorageBytes: async () => 0,
		});
		expect(await service.decideUpload(1)).toBe(UploadQuotaDecision.OverQuota);
	});

	it("fails closed for paid writes when usage can't be read", async () => {
		const service = makeService({ getStorageBytes: async () => null });
		expect(await service.decideUpload(1)).toBe(UploadQuotaDecision.UsageUnknown);
		const throwing = makeService({
			getStorageBytes: async () => {
				throw new Error("asset store unavailable");
			},
		});
		expect(await throwing.decideUpload(1)).toBe(UploadQuotaDecision.UsageUnknown);
	});

	it("treats an entitlement read failure as inert (never blocks the unlinked default)", async () => {
		const service = makeService({
			getEntitlement: async () => {
				throw new Error("account.db unavailable");
			},
		});
		expect(await service.decideUpload(1)).toBe(UploadQuotaDecision.Allowed);
	});

	it("caches the usage read within the TTL and re-reads after it", async () => {
		let nowMs = 0;
		const getStorageBytes = vi.fn(async () => 0);
		const service = makeService({
			getStorageBytes,
			now: () => nowMs,
			usageCacheTtlMs: 1_000,
		});
		await service.decideUpload(1);
		await service.decideUpload(1);
		expect(getStorageBytes).toHaveBeenCalledTimes(1);
		nowMs = 1_000;
		await service.decideUpload(1);
		expect(getStorageBytes).toHaveBeenCalledTimes(2);
	});
});

describe("QuotaService pause signal", () => {
	it("flips to StorageQuota on a blocked decision and back on an allowed one", async () => {
		let used = 25 * GIB;
		const changes: Array<AttachmentSyncPauseReason | null> = [];
		const service = makeService({
			getStorageBytes: async () => used,
			usageCacheTtlMs: 0,
		});
		service.onChange(() => changes.push(service.attachmentSyncPausedReason()));
		expect(service.attachmentSyncPausedReason()).toBe(null);
		await service.decideUpload(1);
		expect(service.attachmentSyncPausedReason()).toBe(AttachmentSyncPauseReason.StorageQuota);
		used = 0;
		await service.decideUpload(1);
		expect(service.attachmentSyncPausedReason()).toBe(null);
		expect(changes).toEqual([AttachmentSyncPauseReason.StorageQuota, null]);
	});

	it("does not re-fire onChange when the signal doesn't flip", async () => {
		const listener = vi.fn();
		const service = makeService({
			getStorageBytes: async () => 25 * GIB,
			usageCacheTtlMs: 0,
		});
		service.onChange(listener);
		await service.decideUpload(1);
		await service.decideUpload(1);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("reset clears the pause signal + usage cache (vault switch)", async () => {
		const getStorageBytes = vi.fn(async () => 25 * GIB);
		const service = makeService({ getStorageBytes });
		await service.decideUpload(1);
		expect(service.attachmentSyncPausedReason()).toBe(AttachmentSyncPauseReason.StorageQuota);
		service.reset();
		expect(service.attachmentSyncPausedReason()).toBe(null);
		await service.decideUpload(1);
		expect(getStorageBytes).toHaveBeenCalledTimes(2);
	});
});

describe("QuotaService.state", () => {
	it("is null with no vault session", async () => {
		const service = makeService({ getEntitlement: async () => null });
		expect(await service.state()).toBe(null);
	});

	it("returns the inert shape (no ceilings) when unlinked", async () => {
		const service = makeService({
			getEntitlement: async () => freeEntitlement(),
			getStorageBytes: async () => 5 * GIB,
		});
		const state = await service.state();
		expect(state).toEqual({
			enforced: false,
			storage: {
				resource: QuotaResource.AttachmentStorage,
				usedBytes: null,
				limitBytes: null,
				over: false,
			},
			egress: {
				resource: QuotaResource.SyncEgress,
				usedBytes: null,
				limitBytes: null,
				over: false,
			},
		});
	});

	it("carries used vs ceiling for a linked metered plan; egress used stays unknown", async () => {
		const service = makeService({ getStorageBytes: async () => 21 * GIB });
		const state = await service.state();
		expect(state?.enforced).toBe(true);
		expect(state?.storage).toEqual({
			resource: QuotaResource.AttachmentStorage,
			usedBytes: 21 * GIB,
			limitBytes: 20 * GIB,
			over: true,
		});
		expect(state?.egress).toEqual({
			resource: QuotaResource.SyncEgress,
			usedBytes: null,
			limitBytes: 10 * GIB,
			over: false,
		});
	});

	it("is not enforced for a linked unmetered plan", async () => {
		const service = makeService({
			getEntitlement: async () => entitled(PlanTier.Enterprise),
		});
		const state = await service.state();
		expect(state?.enforced).toBe(false);
		expect(state?.storage.limitBytes).toBe(null);
	});
});
