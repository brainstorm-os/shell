/**
 * Capability-prompt host service per
 * §Granting:
 *
 *   - Two ways to grant: at install OR at runtime via
 *     `capabilities.request(cap, reason)`.
 *   - Runtime prompts trigger a modal with the reason text.
 *
 * Main process owns the prompt registry: when a request comes in (typed
 * `capabilities:request` envelope or programmatic call), it generates an id,
 * holds a deferred promise, posts a `capabilities:prompt` IPC to the
 * dashboard, and waits for the renderer to reply on
 * `capabilities:prompt-reply`. On reply, the grant is applied (or denied)
 * and the deferred resolves.
 *
 * `CapabilityPromptHost` itself is **pure** — no Electron imports — so it's
 * fully unit-testable. The ipcMain.on wiring lives in `wireIpc()` below,
 * which is called only from `main/index.ts`.
 */

import { applyDefaultAppGrants } from "@brainstorm-os/capabilities/default-grants";
import { GrantedVia, parseCapability } from "@brainstorm-os/capabilities/ledger";
import { ulid } from "ulid";
import { getActiveVaultSession } from "../vault/session";

export const CAPABILITY_PROMPT_CHANNEL = "capabilities:prompt" as const;
export const CAPABILITY_PROMPT_REPLY_CHANNEL = "capabilities:prompt-reply" as const;

export type CapabilityPromptRequest = {
	requestId: string;
	appId: string;
	capability: string;
	reason: string;
};

/** Minimal `WebContents` duck shape — `send(channel, payload)` is all we use. */
export type PromptSender = {
	send(channel: string, payload: CapabilityPromptRequest): void;
};

type Pending = {
	resolve: (granted: boolean) => void;
};

export class CapabilityPromptHost {
	private readonly pending = new Map<string, Pending>();
	private dashboard: PromptSender | null = null;

	setDashboard(target: PromptSender | null): void {
		this.dashboard = target;
		if (target === null && this.pending.size > 0) {
			const drained = Array.from(this.pending.values());
			this.pending.clear();
			for (const p of drained) p.resolve(false);
		}
	}

	/** Apply a reply from the dashboard renderer. Wired by `wireIpc()` in
	 *  production; called directly by tests. Unknown ids are silently
	 *  dropped (e.g. duplicate replies). */
	handleReply(reply: { requestId: string; accept: boolean }): void {
		const pending = this.pending.get(reply.requestId);
		if (!pending) return;
		this.pending.delete(reply.requestId);
		pending.resolve(reply.accept);
	}

	/**
	 * Programmatic entry: trigger a prompt and apply the grant if the user
	 * accepts. Returns true iff the grant is live afterward.
	 *
	 * - If the cap is already a live grant for `appId`, resolves true without
	 *   prompting.
	 * - If there's no dashboard to prompt or no active session, resolves false
	 *   (fail-safe: cannot grant without consent).
	 */
	async request(appId: string, capability: string, reason: string): Promise<boolean> {
		const session = getActiveVaultSession();
		if (!session) return false;
		const ledger = await session.capabilityLedger();

		// Default-minimum caps are auto-approved (no prompt needed).
		if (ledger.has(appId, capability)) {
			return true;
		}

		// Ensure default-minimum grants exist before runtime requests pile on.
		applyDefaultAppGrants(ledger, appId, GrantedVia.Install);
		if (ledger.has(appId, capability)) {
			return true;
		}

		const dashboard = this.dashboard;
		if (!dashboard) {
			console.warn("[brainstorm] capability prompt requested but no dashboard renderer is available");
			return false;
		}

		const requestId = `cpr_${ulid()}`;
		const promise = new Promise<boolean>((resolve) => {
			this.pending.set(requestId, { resolve });
		});
		dashboard.send(CAPABILITY_PROMPT_CHANNEL, {
			requestId,
			appId,
			capability,
			reason,
		});
		const accepted = await promise;
		if (!accepted) return false;

		const { capability: name, scope } = parseCapability(capability);
		ledger.grant({
			appId,
			capability: name,
			scope,
			grantedVia: GrantedVia.Runtime,
		});
		return true;
	}
}

// ─── Module singleton ──────────────────────────────────────────────────────

let host: CapabilityPromptHost | null = null;

export function getCapabilityPromptHost(): CapabilityPromptHost {
	if (!host) host = new CapabilityPromptHost();
	return host;
}

export function resetCapabilityPromptHost(): void {
	host = null;
}
