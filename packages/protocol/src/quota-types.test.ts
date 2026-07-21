/**
 * 14.7 — the product-side quota model. The ceiling table + verdict math are
 * pinned to the billing-edge contract (`services/billing-edge/src/metering.rs`
 * `quota_for` / `quota_status`): wire values, per-plan bytes, and the strict
 * `used > limit` over-rule (exactly-at-limit is NOT over).
 */

import { describe, expect, it } from "vitest";
import { PlanTier } from "./billing-types";
import { QuotaResource, inertQuotaVerdict, planQuotaLimitBytes, quotaVerdict } from "./quota-types";

const GIB = 1024 * 1024 * 1024;

describe("QuotaResource", () => {
	it("wire values stay in lockstep with billing-edge MeterKind", () => {
		expect(QuotaResource.AttachmentStorage).toBe("storage.bytes");
		expect(QuotaResource.SyncEgress).toBe("sync.egress.bytes");
	});
});

describe("planQuotaLimitBytes", () => {
	it("mirrors billing-edge quota_for exactly", () => {
		expect(planQuotaLimitBytes(PlanTier.Free, QuotaResource.AttachmentStorage)).toBe(0);
		expect(planQuotaLimitBytes(PlanTier.Plus, QuotaResource.AttachmentStorage)).toBe(20 * GIB);
		expect(planQuotaLimitBytes(PlanTier.Pro, QuotaResource.AttachmentStorage)).toBe(200 * GIB);
		expect(planQuotaLimitBytes(PlanTier.Team, QuotaResource.AttachmentStorage)).toBe(1024 * GIB);
		expect(planQuotaLimitBytes(PlanTier.Free, QuotaResource.SyncEgress)).toBe(0);
		expect(planQuotaLimitBytes(PlanTier.Plus, QuotaResource.SyncEgress)).toBe(10 * GIB);
		expect(planQuotaLimitBytes(PlanTier.Pro, QuotaResource.SyncEgress)).toBe(100 * GIB);
		expect(planQuotaLimitBytes(PlanTier.Team, QuotaResource.SyncEgress)).toBe(1024 * GIB);
	});

	it("enterprise is unmetered (null) for both resources", () => {
		expect(planQuotaLimitBytes(PlanTier.Enterprise, QuotaResource.AttachmentStorage)).toBe(null);
		expect(planQuotaLimitBytes(PlanTier.Enterprise, QuotaResource.SyncEgress)).toBe(null);
	});
});

describe("quotaVerdict", () => {
	it("flags over only strictly past the limit (billing-edge quota_status)", () => {
		const under = quotaVerdict(PlanTier.Plus, QuotaResource.AttachmentStorage, 20 * GIB - 1);
		expect(under.over).toBe(false);
		const at = quotaVerdict(PlanTier.Plus, QuotaResource.AttachmentStorage, 20 * GIB);
		expect(at.over).toBe(false);
		const over = quotaVerdict(PlanTier.Plus, QuotaResource.AttachmentStorage, 20 * GIB + 1);
		expect(over.over).toBe(true);
		expect(over.limitBytes).toBe(20 * GIB);
		expect(over.usedBytes).toBe(20 * GIB + 1);
	});

	it("free has zero hosted allowance — any usage is over", () => {
		expect(quotaVerdict(PlanTier.Free, QuotaResource.AttachmentStorage, 1).over).toBe(true);
		expect(quotaVerdict(PlanTier.Free, QuotaResource.AttachmentStorage, 0).over).toBe(false);
	});

	it("never over when usage or limit is unknown", () => {
		expect(quotaVerdict(PlanTier.Plus, QuotaResource.SyncEgress, null).over).toBe(false);
		expect(
			quotaVerdict(PlanTier.Enterprise, QuotaResource.AttachmentStorage, Number.MAX_SAFE_INTEGER).over,
		).toBe(false);
	});

	it("inertQuotaVerdict carries no ceiling and is never over", () => {
		const inert = inertQuotaVerdict(QuotaResource.AttachmentStorage);
		expect(inert).toEqual({
			resource: QuotaResource.AttachmentStorage,
			usedBytes: null,
			limitBytes: null,
			over: false,
		});
	});
});
