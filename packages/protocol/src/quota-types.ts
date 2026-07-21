/**
 * 14.7 — product-side quota model (renderer-safe, zero imports beyond the
 * billing enums).
 *
 * Mirrors the `brainstorm-cloud` billing-edge metering contract
 * (`services/billing-edge/src/metering.rs`): `QuotaResource` values are the
 * cross-plane `MeterKind` wire strings, `planQuotaLimitBytes` is the
 * product-side copy of `quota_for`, and `quotaVerdict` mirrors `quota_status`
 * (`over` = strictly `used > limit`, exactly-at-limit is not over).
 *
 * The data plane never imports control-plane code — it agrees on these wire
 * values, nothing more (same posture as `billing-types.ts`).
 *
 * Usage numbers here are LOCAL ingest-side estimates (bound bytes in the
 * vault's asset store): billing-edge exposes no usage-read endpoint and
 * `/v1/usage/ingest` is service-token-authed (hosted infra only), so the
 * shell cannot query the authoritative counters. The hosted node's own
 * metering stays authoritative; the product-side verdict is a courtesy gate.
 */

import { PlanTier } from "./billing-types";

/** Metered resources. Values are the billing-edge `MeterKind` wire strings —
 *  keep in lockstep with `services/billing-edge/src/metering.rs`. */
export enum QuotaResource {
	/** Hosted attachment storage (a gauge: bytes resident now). */
	AttachmentStorage = "storage.bytes",
	/** Hosted sync egress (a counter: bytes served per calendar month). */
	SyncEgress = "sync.egress.bytes",
}

/** Why an attachment upload was (or wasn't) admitted by the product-side
 *  quota gate. Reads are NEVER quota-gated — this only shapes uploads. */
export enum UploadQuotaDecision {
	Allowed = "allowed",
	/** The upload would push hosted storage past the plan ceiling. */
	OverQuota = "over-quota",
	/** Metered account but local usage couldn't be read — fail-closed for
	 *  paid writes (bytes stay local; the next drain retries). */
	UsageUnknown = "usage-unknown",
}

/** Why attachment sync is paused (the sync-status surface's signal). */
export enum AttachmentSyncPauseReason {
	StorageQuota = "storage-quota",
}

const GIB = 1024 * 1024 * 1024;

/** Product-side mirror of billing-edge `quota_for(plan, meter)`, in bytes;
 *  null = unmetered (enterprise). Free is 0 for both: no hosted allowance
 *  (local-first only). `Record<PlanTier, …>` pins exhaustiveness — a new
 *  tier fails to compile until both tables name it. */
const PLAN_LIMIT_BYTES: Record<QuotaResource, Record<PlanTier, number | null>> = {
	[QuotaResource.AttachmentStorage]: {
		[PlanTier.Free]: 0,
		[PlanTier.Plus]: 20 * GIB,
		[PlanTier.Pro]: 200 * GIB,
		[PlanTier.Team]: 1024 * GIB,
		[PlanTier.Enterprise]: null,
	},
	[QuotaResource.SyncEgress]: {
		[PlanTier.Free]: 0,
		[PlanTier.Plus]: 10 * GIB,
		[PlanTier.Pro]: 100 * GIB,
		[PlanTier.Team]: 1024 * GIB,
		[PlanTier.Enterprise]: null,
	},
};

export function planQuotaLimitBytes(plan: PlanTier, resource: QuotaResource): number | null {
	return PLAN_LIMIT_BYTES[resource][plan];
}

/** One resource's quota reading. `usedBytes` null = unknown product-side
 *  (egress is always unknown — only the node meters it); `limitBytes` null =
 *  unmetered. */
export type QuotaVerdict = {
	readonly resource: QuotaResource;
	readonly usedBytes: number | null;
	readonly limitBytes: number | null;
	/** Mirrors billing-edge `quota_status`: `used > limit`, never true when
	 *  either side is unknown. */
	readonly over: boolean;
};

export function quotaVerdict(
	plan: PlanTier,
	resource: QuotaResource,
	usedBytes: number | null,
): QuotaVerdict {
	const limitBytes = planQuotaLimitBytes(plan, resource);
	const over = limitBytes !== null && usedBytes !== null && usedBytes > limitBytes;
	return { resource, usedBytes, limitBytes, over };
}

/** A verdict with no ceiling attached — the inert (unlinked / free-local)
 *  shape: plan tables don't apply without a billing account. */
export function inertQuotaVerdict(resource: QuotaResource): QuotaVerdict {
	return { resource, usedBytes: null, limitBytes: null, over: false };
}

/** The aggregate quota state the Settings → Billing panel renders. */
export type QuotaStateView = {
	/** False ⇒ enforcement fully inert: no linked account, or the plan is
	 *  unmetered. The local-first default. */
	readonly enforced: boolean;
	readonly storage: QuotaVerdict;
	readonly egress: QuotaVerdict;
};
