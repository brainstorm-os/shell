/**
 * OS-handoff consent prompt host — Stage OpenRes-1c (consent slice).
 *
 * The companion to `CapabilityPromptHost` for the open-resolution
 * ladder's first-use OS-handoff branch (doc 57 §System default; per-
 * vault first-use-per-protocol consent memory). When `dispatchExternalOpen`
 * reaches the `OsHandoff` rung and `needsConsent` is true (no recorded
 * consent for the target signature `scheme:<scheme>` / `ext:<ext>`),
 * the bus calls `host.request(target)`; the host posts an
 * `os-handoff:prompt` IPC to the dashboard, waits for the user's
 * `allow` / `deny` / `cancel` response, and returns the decision.
 * Persisting the choice (calling `setOsHandoffConsent`) is the caller's
 * job — this host stays pure (no Electron, no dashboard-store imports).
 *
 * Pure: no Electron imports. `wireOsHandoffPromptIpc` (a separate file)
 * does the ipcMain.on wiring. Caller surface mirrors `CapabilityPromptHost`
 * verbatim so the testing pattern is identical.
 *
 * OpenRes-1c slice 4 hardening: per-signature dedup (the same scheme
 * never raises two concurrent modals; a second `request` for an in-
 * flight signature returns the same promise so back-to-back link clicks
 * resolve identically), a `PROMPT_TIMEOUT_MS` ceiling on every request
 * (a hung dashboard renderer can't leak resolve closures forever), and
 * a `MAX_PENDING` cap that rejects the *newest* incoming request when
 * the queue is full so the in-flight modal the user is actually looking
 * at survives. All three pinned by OQ-227 (60 s + 16 pending, 2026-05-23).
 */

import { OsHandoffPromptDecision } from "@brainstorm-os/sdk-types";
import { ulid } from "ulid";

export { OsHandoffPromptDecision };

export const OS_HANDOFF_PROMPT_CHANNEL = "os-handoff:prompt" as const;
export const OS_HANDOFF_PROMPT_REPLY_CHANNEL = "os-handoff:prompt-reply" as const;

/** Per-prompt timeout — a hung dashboard renderer (crash mid-modal,
 *  navigation away, IPC stall) must not leak resolve closures forever.
 *  60 s is long enough that a deliberating user never hits it; short
 *  enough that a wedged request frees memory on the same scale a tab
 *  reload would. OQ-227 (2026-05-23). Timeout = `Cancel` so the
 *  consent state stays first-use (next attempt re-prompts), preserving
 *  slice-1's "Cancel doesn't persist" invariant. */
export const PROMPT_TIMEOUT_MS = 60_000;

/** Hard ceiling on concurrent in-flight prompts. A single-window
 *  dashboard can only show one modal at a time, but the host accepts
 *  per-signature requests from any caller — a runaway loop of `open`s
 *  for distinct schemes could stack arbitrarily. 16 = comfortably
 *  above any realistic concurrent open burst (the launcher rate-limit
 *  is far tighter), bounded so a misbehaving caller can't OOM the
 *  resolver. OQ-227 (2026-05-23). Overflow rejects the **newest**
 *  request with Cancel (preserves the in-flight modal the user is
 *  actually looking at). */
export const MAX_PENDING = 16;

/** What the dashboard renders. The signature (e.g. `scheme:mailto` /
 *  `ext:pdf`) is the load-bearing identity — both the consent memory
 *  and the prompt-once-per-signature semantics key on it. `uri` is the
 *  user-facing target (the actual URL / file path being opened) so the
 *  modal can show "Open `https://example.com/page` in your browser?"
 *  rather than just "Allow scheme:https?". */
export type OsHandoffPromptRequest = {
	requestId: string;
	signature: string;
	uri: string;
};

/** Minimal `WebContents` duck shape — `send(channel, payload)` is all
 *  we use. Mirrors `CapabilityPromptHost`'s `PromptSender`. */
export type PromptSender = {
	send(channel: string, payload: OsHandoffPromptRequest): void;
};

type Pending = {
	signature: string;
	requestId: string;
	/** Every caller that requested this signature while it was in flight.
	 *  A single dashboard reply (or timeout / setDashboard(null) drain)
	 *  resolves them all with the same decision. */
	resolvers: Array<(decision: OsHandoffPromptDecision) => void>;
	timeout: ReturnType<typeof setTimeout>;
};

export class OsHandoffPromptHost {
	private readonly bySignature = new Map<string, Pending>();
	private readonly byRequestId = new Map<string, Pending>();
	private dashboard: PromptSender | null = null;

	setDashboard(target: PromptSender | null): void {
		this.dashboard = target;
		if (target === null && this.bySignature.size > 0) {
			const drained = Array.from(this.bySignature.values());
			this.bySignature.clear();
			this.byRequestId.clear();
			for (const p of drained) this.settle(p, OsHandoffPromptDecision.Cancel);
		}
	}

	/** Apply a reply from the dashboard renderer. Unknown ids are
	 *  silently dropped (duplicate replies, late wakeups). */
	handleReply(reply: { requestId: string; decision: OsHandoffPromptDecision }): void {
		const pending = this.byRequestId.get(reply.requestId);
		if (!pending) return;
		this.byRequestId.delete(reply.requestId);
		this.bySignature.delete(pending.signature);
		this.settle(pending, reply.decision);
	}

	/**
	 * Raise the prompt for one signature + uri pair. Resolves to the
	 * user's decision. Without a dashboard renderer attached the prompt
	 * fails closed (`Cancel`) — there is no path that grants OS handoff
	 * without explicit consent.
	 *
	 * Per-signature dedup: a second `request` for a signature that is
	 * already in flight returns a promise that resolves to the same
	 * decision as the first call (the dashboard never sees two modals
	 * for one scheme; back-to-back link clicks resolve identically). A
	 * 60 s timeout caps every pending request (timeout = Cancel —
	 * non-sticky, the next attempt re-prompts). On overflow past
	 * `MAX_PENDING` the incoming (newest) request resolves Cancel
	 * immediately so the in-flight modal the user is actually looking
	 * at survives.
	 */
	async request(signature: string, uri: string): Promise<OsHandoffPromptDecision> {
		const dashboard = this.dashboard;
		if (!dashboard) {
			console.warn("[brainstorm] OS-handoff prompt requested but no dashboard renderer is available");
			return OsHandoffPromptDecision.Cancel;
		}
		const inFlight = this.bySignature.get(signature);
		if (inFlight) {
			return new Promise<OsHandoffPromptDecision>((resolve) => {
				inFlight.resolvers.push(resolve);
			});
		}
		if (this.bySignature.size >= MAX_PENDING) {
			return OsHandoffPromptDecision.Cancel;
		}
		const requestId = `osh_${ulid()}`;
		const promise = new Promise<OsHandoffPromptDecision>((resolve) => {
			const pending: Pending = {
				signature,
				requestId,
				resolvers: [resolve],
				timeout: setTimeout(() => {
					if (this.byRequestId.get(requestId) !== pending) return;
					this.byRequestId.delete(requestId);
					this.bySignature.delete(signature);
					this.settle(pending, OsHandoffPromptDecision.Cancel);
				}, PROMPT_TIMEOUT_MS),
			};
			this.bySignature.set(signature, pending);
			this.byRequestId.set(requestId, pending);
		});
		dashboard.send(OS_HANDOFF_PROMPT_CHANNEL, { requestId, signature, uri });
		return await promise;
	}

	private settle(pending: Pending, decision: OsHandoffPromptDecision): void {
		clearTimeout(pending.timeout);
		for (const r of pending.resolvers) r(decision);
	}
}

// ─── Module singleton (mirrors getCapabilityPromptHost) ────────────────────

let host: OsHandoffPromptHost | null = null;

export function getOsHandoffPromptHost(): OsHandoffPromptHost {
	if (!host) host = new OsHandoffPromptHost();
	return host;
}

export function resetOsHandoffPromptHost(): void {
	host = null;
}
