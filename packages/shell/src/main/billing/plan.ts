/**
 * The billing domain model moved to `shared/billing-types.ts` in 14.6 so the
 * Settings → Billing renderer can share the enums (renderer-safe, zero
 * imports). This module keeps the historical main-side path alive for the
 * repos / service / broker handler — one source of truth, one shim.
 */

export * from "../../shared/billing-types";
