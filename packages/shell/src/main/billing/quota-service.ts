/**
 * 14.7 — product-side quota enforcement (attachment storage + sync egress).
 *
 * Holds the current quota verdict per metered resource and decides whether an
 * attachment upload may leave the device. Sources: (a) the effective
 * entitlement (`BillingService` — plan → ceiling via the shared
 * `planQuotaLimitBytes` mirror of billing-edge `quota_for`), and (b) the LOCAL
 * ingest-side usage estimate (bound bytes in the vault's asset store).
 * billing-edge exposes no usage-read endpoint and `/v1/usage/ingest` is
 * service-token-authed (hosted infra only), so the shell cannot query the
 * authoritative counters — the hosted node's metering stays authoritative and
 * this gate is a product-side courtesy.
 *
 * Enforcement posture (test-pinned):
 *   - INERT unless a billing account is linked AND the plan is metered — the
 *     no-account / free-local default uploads freely (local-first is sacred).
 *   - Only arms against an entitlement-GATED relay (`isGatedRelay` — the
 *     SYNC-4b admission handshake completed). An open / self-hosted node is
 *     never quota-gated: those bytes aren't hosted storage.
 *   - Fail-closed for paid writes: a metered, gated account whose local usage
 *     can't be read skips the upload (bytes stay local; the next drain
 *     retries). Never fails the local write/bind itself.
 *   - Reads (serve-on-miss, restore, downloads) are NEVER gated — no read
 *     path takes a dependency on this service.
 *
 * Egress is surfaced only (plan ceiling; used unknown product-side — the
 * node meters served bytes server-side, and its cap is soft/throttled per the
 * pricing doc), never enforced here: enforcing it would gate reads.
 */

import {
	AttachmentSyncPauseReason,
	QuotaResource,
	type QuotaStateView,
	UploadQuotaDecision,
	inertQuotaVerdict,
	planQuotaLimitBytes,
	quotaVerdict,
} from "../../shared/quota-types";
import type { Entitlement } from "./plan";

export type QuotaServiceDeps = {
	/** The active vault's effective entitlement, or null (no session). */
	readonly getEntitlement: () => Promise<Entitlement | null>;
	/** Local ingest-side usage estimate: bound bytes in the vault's asset
	 *  store; null = unknown. */
	readonly getStorageBytes: () => Promise<number | null>;
	/** True when the live relay connection was admitted via the SYNC-4b
	 *  entitlement handshake — i.e. a hosted/metered node. */
	readonly isGatedRelay: () => boolean | Promise<boolean>;
	/** Injectable for tests — defaults to `Date.now`. */
	readonly now?: () => number;
	/** How long one usage read stays fresh (a connect-time drain decides per
	 *  asset; the sum is O(bound assets) SQL per read). */
	readonly usageCacheTtlMs?: number;
};

const DEFAULT_USAGE_CACHE_TTL_MS = 10_000;

export class QuotaService {
	readonly #deps: QuotaServiceDeps;
	readonly #now: () => number;
	readonly #usageCacheTtlMs: number;
	readonly #listeners = new Set<() => void>();
	#usageCache: { readAtMs: number; bytes: number | null } | null = null;
	#pauseReason: AttachmentSyncPauseReason | null = null;

	constructor(deps: QuotaServiceDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#usageCacheTtlMs = deps.usageCacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS;
	}

	/** The aggregate quota state the Settings → Billing panel renders. Null
	 *  when no vault session is open. Unlinked accounts get the inert shape
	 *  (no ceilings — plan tables don't apply without a billing account). */
	async state(): Promise<QuotaStateView | null> {
		const entitlement = await this.#entitlementSafe();
		if (!entitlement) return null;
		if (entitlement.accountId === null) {
			return {
				enforced: false,
				storage: inertQuotaVerdict(QuotaResource.AttachmentStorage),
				egress: inertQuotaVerdict(QuotaResource.SyncEgress),
			};
		}
		const usedBytes = await this.#usageBytes();
		const storage = quotaVerdict(entitlement.plan, QuotaResource.AttachmentStorage, usedBytes);
		// Egress used is unknown product-side — only the hosted node meters it.
		const egress = quotaVerdict(entitlement.plan, QuotaResource.SyncEgress, null);
		return { enforced: storage.limitBytes !== null, storage, egress };
	}

	/** Gate ONE attachment upload of `pendingBytes`. Never called by (and
	 *  never gating) any read path. Updates the pause signal as a side effect
	 *  so the sync-status surface tracks the latest decision. */
	async decideUpload(pendingBytes: number): Promise<UploadQuotaDecision> {
		const decision = await this.#decide(pendingBytes);
		this.#setPauseReason(
			decision === UploadQuotaDecision.Allowed ? null : AttachmentSyncPauseReason.StorageQuota,
		);
		return decision;
	}

	/** The sync-status snapshot's signal: why attachment uploads are paused,
	 *  or null. Derived from the latest `decideUpload` outcome. */
	attachmentSyncPausedReason(): AttachmentSyncPauseReason | null {
		return this.#pauseReason;
	}

	/** Fires when the pause signal flips (for the sync-status broadcast). */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Vault session changed — drop the usage cache + pause signal. */
	reset(): void {
		this.#usageCache = null;
		this.#setPauseReason(null);
	}

	async #decide(pendingBytes: number): Promise<UploadQuotaDecision> {
		const entitlement = await this.#entitlementSafe();
		// No session / unlinked → fully inert (the local-first default).
		if (!entitlement || entitlement.accountId === null) return UploadQuotaDecision.Allowed;
		const limitBytes = planQuotaLimitBytes(entitlement.plan, QuotaResource.AttachmentStorage);
		if (limitBytes === null) return UploadQuotaDecision.Allowed;
		// An open / self-hosted node is never quota-gated — only bytes bound
		// for a hosted (entitlement-gated) node count against the plan.
		if (!(await this.#gatedSafe())) return UploadQuotaDecision.Allowed;
		const usedBytes = await this.#usageBytes();
		if (usedBytes === null) return UploadQuotaDecision.UsageUnknown;
		return usedBytes + pendingBytes > limitBytes
			? UploadQuotaDecision.OverQuota
			: UploadQuotaDecision.Allowed;
	}

	async #usageBytes(): Promise<number | null> {
		const now = this.#now();
		const cached = this.#usageCache;
		if (cached && now - cached.readAtMs < this.#usageCacheTtlMs) return cached.bytes;
		let bytes: number | null;
		try {
			bytes = await this.#deps.getStorageBytes();
		} catch {
			bytes = null;
		}
		this.#usageCache = { readAtMs: now, bytes };
		return bytes;
	}

	async #entitlementSafe(): Promise<Entitlement | null> {
		try {
			return await this.#deps.getEntitlement();
		} catch {
			return null;
		}
	}

	async #gatedSafe(): Promise<boolean> {
		try {
			return await this.#deps.isGatedRelay();
		} catch {
			return false;
		}
	}

	#setPauseReason(reason: AttachmentSyncPauseReason | null): void {
		if (this.#pauseReason === reason) return;
		this.#pauseReason = reason;
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				console.warn("[brainstorm] quota onChange listener threw:", error);
			}
		}
	}
}
