/**
 * BrokerContext — the cross-cutting glue between the broker, the renderer
 * identity registry, the active vault's capability ledger, and the audit
 * log. Closes the Stage 4 wiring inheritance.
 *
 *   - The Broker is constructed once (in `startWorkers`) and never replaced.
 *   - Each opened vault has its own `CapabilityLedger` (lives in that vault's
 *     `ledger.db`); the broker reads it via `getLedger()` which delegates to
 *     the active VaultSession.
 *   - When no vault is open, the ledger is null and every capability check
 *     fails closed (Unavailable).
 *   - Denied calls fire `onDenied(event)`, which routes to the active
 *     vault's audit log if one is open.
 *
 * This file owns NO SQL or IPC mechanics — it's purely the boundary that
 * lets the Broker stay vault-agnostic.
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import type { AppIdentityVerifier, CapabilityChecker, DenialEvent } from "../../ipc/broker";
import { RendererIdentityRegistry } from "../ipc/renderer-identity";
import { appendAuditEvent } from "../vault/audit-log";
import { type VaultSession, getActiveVaultSession } from "../vault/session";

export class BrokerContext {
	readonly identities = new RendererIdentityRegistry();

	/**
	 * Lookup the live CapabilityLedger from the active vault session. Returns
	 * null when no vault is open — in which case `checkCapability` fails closed.
	 */
	private async getLedger(): Promise<CapabilityLedger | null> {
		const session = getActiveVaultSession();
		// A soft-locked session (passphrase backend, key resident) stays `active`
		// but must fail closed like no-vault — app IPC is blocked behind the lock
		// screen. A hard-locked vault has `active === null` already (Stage 13.8).
		if (!session || session.isLocked()) return null;
		try {
			return await session.capabilityLedger();
		} catch (error) {
			console.warn("[brainstorm] failed to open capability ledger:", error);
			return null;
		}
	}

	/**
	 * The `verifyAppIdentity` closure plugged into the Broker. Stable
	 * reference for the broker's lifetime; reads renderer registrations
	 * on every call.
	 */
	readonly verifyAppIdentity: AppIdentityVerifier = (claimedApp, source) =>
		this.identities.verify(claimedApp, source);

	/**
	 * The `checkCapability` closure. Synchronous interface (the broker
	 * doesn't await); we hold the ledger in a stable cache after first
	 * touch so this stays fast. Fail-closed on any ledger error or
	 * mid-IPC vault-close.
	 *
	 * Capability resolution: a call is allowed iff every declared cap in
	 * the envelope is a live grant for the calling app. Methods that
	 * declare no caps are allowed — service handlers enforce method-level
	 * requirements themselves.
	 */
	readonly checkCapability: CapabilityChecker = (app, _service, _method, declaredCaps) => {
		const ledger = this.syncLedger();
		if (!ledger) {
			// Vault not yet open — fail closed; the dashboard is the only
			// renderer that talks to the broker at boot, and the dashboard
			// uses the direct ipcMain handlers (vault-handlers.ts) for its
			// pre-vault calls.
			return false;
		}
		// Any throw here (e.g. the ledger's DB closed mid-IPC) propagates to the
		// broker, which maps it to Unavailable — never approval. Fail-closed.
		return declaredCaps.every((cap) => ledger.has(app, cap));
	};

	/**
	 * Synchronous accessor for the most-recent ledger. We cache the
	 * VaultSession's promise-resolved CapabilityLedger after first async
	 * resolution; callers needing sync access (the broker) call this.
	 */
	private cachedLedger: CapabilityLedger | null = null;
	// Keyed on the VaultSession *instance*, not its vaultId: a hard-lock → unlock
	// cycle disposes the session (closing ledger.db) and re-opens a NEW session
	// with the SAME vaultId. Keying on the id would return the stale ledger
	// wrapping a now-closed DB (`has()` throws "database connection is not
	// open"); keying on identity busts the cache on any dispose→reopen so we fail
	// closed (denial) until the next warmup instead of crashing every app IPC.
	private cachedForSession: VaultSession | null = null;
	private syncLedger(): CapabilityLedger | null {
		const session = getActiveVaultSession();
		if (!session) {
			this.cachedLedger = null;
			this.cachedForSession = null;
			return null;
		}
		// Soft-locked → fail closed, but DON'T evict the cache: it's the same
		// session, so a soft-unlock (which only flips the flag, no re-warm) must
		// leave the warm ledger intact. A hard-lock disposes the session entirely
		// (handled by the `!session` branch above).
		if (session.isLocked()) return null;
		if (this.cachedForSession !== session) {
			this.cachedLedger = null;
			this.cachedForSession = null;
		}
		return this.cachedLedger;
	}

	/**
	 * Open the active vault's ledger (one-shot async warmup). Called by
	 * vault-handlers right after `VaultSession.create/open/activate` so the
	 * broker's first call already has a hot ledger.
	 */
	async warmupLedger(): Promise<void> {
		const ledger = await this.getLedger();
		const session = getActiveVaultSession();
		this.cachedLedger = ledger;
		this.cachedForSession = session;
	}

	/**
	 * The `onDenied` closure plugged into the Broker. Forwards every denial
	 * to the active vault's audit log as `ipc.denied`.
	 */
	readonly onDenied = (event: DenialEvent): void => {
		const session = getActiveVaultSession();
		if (!session) return;
		void appendAuditEvent(session.vaultPath, {
			kind: "ipc.denied",
			vaultId: session.vaultId,
			deniedKind: event.kind,
			app: event.app,
			service: event.service,
			method: event.method,
			reason: event.reason,
		});
	};

	/** Forget the cached ledger — called when a vault closes / switches. */
	invalidate(): void {
		this.cachedLedger = null;
		this.cachedForSession = null;
	}
}
