/**
 * "Open with…" multi-candidate picker host — OpenRes-1c slice 6.
 *
 * The companion to `OsHandoffPromptHost` for the `decideOpen` ladder's
 * **rung 3 (InVaultOpeners)** branch when more than one in-vault opener
 * claims the same scheme / extension. Without this host the bus silently
 * picks the primary or first-registered opener; the user has no choice
 * and no visibility into who got the open. This host raises a modal,
 * lets the user pick which app handles the open, and (optionally)
 * remembers the choice as a `(open, signature)` default so the next
 * attempt skips the picker.
 *
 * Pure: no Electron imports. `wireOpenWithPromptIpc` (a separate file)
 * does the `ipcMain.on` wiring. Public surface mirrors
 * `OsHandoffPromptHost` verbatim so the testing pattern is identical:
 *
 *   - `setDashboard(target | null)` — attach / detach the renderer.
 *     On `null` every in-flight request resolves to a Cancel decision
 *     (the doc-57 invariant — no path silently grants).
 *   - `handleReply({ requestId, decision })` — apply a renderer reply.
 *     Unknown ids are silently dropped (duplicate replies, late
 *     wakeups).
 *   - `request(signature, uri, candidates)` — raise the modal. Resolves
 *     to the user's `OpenWithDecision`. Per-signature dedup, 60 s
 *     timeout, and a `MAX_PENDING` cap (newest rejected on overflow)
 *     are identical to the os-handoff host (OQ-227).
 *
 * Why dedup is per-signature, not per-(signature, candidate-set):
 * back-to-back link clicks to two `https://…` URLs should not stack
 * two modals; the first prompt's decision (or "Remember" pin) covers
 * the second. If the candidate set legitimately differs (an extension
 * just installed / uninstalled), a fresh request after the first
 * resolves mints a new prompt — same as the os-handoff host.
 */

import {
	type OpenWithCandidate,
	type OpenWithDecision,
	OpenWithDecisionKind,
} from "@brainstorm-os/sdk-types";
import { ulid } from "ulid";

export { OpenWithDecisionKind };

export const OPEN_WITH_PROMPT_CHANNEL = "open-with:prompt" as const;
export const OPEN_WITH_PROMPT_REPLY_CHANNEL = "open-with:prompt-reply" as const;

/** Per-prompt timeout — a hung dashboard renderer must not leak resolve
 *  closures forever. 60 s matches the os-handoff host (OQ-227). Timeout
 *  = `Cancel` so a wedged modal stays first-use (next attempt re-prompts)
 *  and never silently picks an app the user didn't pick. */
export const PROMPT_TIMEOUT_MS = 60_000;

/** Hard ceiling on concurrent in-flight prompts. Same 16 as os-handoff
 *  (OQ-227). Overflow rejects the **newest** request with Cancel so the
 *  in-flight modal the user is actually looking at survives. */
export const MAX_PENDING = 16;

/** What the dashboard renders. `candidates` is the ordered list of
 *  apps that match the signature (primary openers first, then
 *  secondaries, then the OS-handoff option when permitted). `uri` is
 *  shown verbatim in the modal so the user can see exactly what is
 *  about to be opened. */
export type OpenWithPromptRequest = {
	requestId: string;
	signature: string;
	uri: string;
	candidates: readonly OpenWithCandidate[];
};

/** Minimal `WebContents` duck shape — `send(channel, payload)` is all
 *  we use. Mirrors `OsHandoffPromptHost`'s `PromptSender`. */
export type PromptSender = {
	send(channel: string, payload: OpenWithPromptRequest): void;
};

type Pending = {
	signature: string;
	requestId: string;
	/** Every caller that requested this signature while it was in flight.
	 *  A single dashboard reply (or timeout / setDashboard(null) drain)
	 *  resolves them all with the same decision. */
	resolvers: Array<(decision: OpenWithDecision) => void>;
	timeout: ReturnType<typeof setTimeout>;
};

const CANCEL: OpenWithDecision = { kind: OpenWithDecisionKind.Cancel };

export class OpenWithPromptHost {
	private readonly bySignature = new Map<string, Pending>();
	private readonly byRequestId = new Map<string, Pending>();
	private dashboard: PromptSender | null = null;

	setDashboard(target: PromptSender | null): void {
		this.dashboard = target;
		if (target === null && this.bySignature.size > 0) {
			const drained = Array.from(this.bySignature.values());
			this.bySignature.clear();
			this.byRequestId.clear();
			for (const p of drained) this.settle(p, CANCEL);
		}
	}

	/** Apply a reply from the dashboard renderer. Unknown ids are
	 *  silently dropped (duplicate replies, late wakeups). */
	handleReply(reply: { requestId: string; decision: OpenWithDecision }): void {
		const pending = this.byRequestId.get(reply.requestId);
		if (!pending) return;
		this.byRequestId.delete(reply.requestId);
		this.bySignature.delete(pending.signature);
		this.settle(pending, reply.decision);
	}

	/**
	 * Raise the picker for one signature + uri + candidate set. Resolves
	 * to the user's decision. Without a dashboard renderer attached the
	 * prompt fails closed (`Cancel`) — there is no path that picks an
	 * app the user didn't see.
	 *
	 * Per-signature dedup: a second `request` for a signature already in
	 * flight returns a promise that resolves to the same decision as
	 * the first call (back-to-back clicks resolve identically; the
	 * dashboard never sees two modals for one signature). A 60 s
	 * timeout caps every pending request (timeout = Cancel — non-sticky,
	 * the next attempt re-prompts). On overflow past `MAX_PENDING` the
	 * incoming (newest) request resolves Cancel immediately so the
	 * in-flight modal the user is looking at survives.
	 */
	async request(
		signature: string,
		uri: string,
		candidates: readonly OpenWithCandidate[],
	): Promise<OpenWithDecision> {
		const dashboard = this.dashboard;
		if (!dashboard) {
			console.warn("[brainstorm] Open-with prompt requested but no dashboard renderer is available");
			return CANCEL;
		}
		const inFlight = this.bySignature.get(signature);
		if (inFlight) {
			return new Promise<OpenWithDecision>((resolve) => {
				inFlight.resolvers.push(resolve);
			});
		}
		if (this.bySignature.size >= MAX_PENDING) {
			return CANCEL;
		}
		const requestId = `opw_${ulid()}`;
		const promise = new Promise<OpenWithDecision>((resolve) => {
			const pending: Pending = {
				signature,
				requestId,
				resolvers: [resolve],
				timeout: setTimeout(() => {
					if (this.byRequestId.get(requestId) !== pending) return;
					this.byRequestId.delete(requestId);
					this.bySignature.delete(signature);
					this.settle(pending, CANCEL);
				}, PROMPT_TIMEOUT_MS),
			};
			this.bySignature.set(signature, pending);
			this.byRequestId.set(requestId, pending);
		});
		dashboard.send(OPEN_WITH_PROMPT_CHANNEL, { requestId, signature, uri, candidates });
		return await promise;
	}

	private settle(pending: Pending, decision: OpenWithDecision): void {
		clearTimeout(pending.timeout);
		for (const r of pending.resolvers) r(decision);
	}
}

// ─── Module singleton (mirrors getOsHandoffPromptHost) ─────────────────────

let host: OpenWithPromptHost | null = null;

export function getOpenWithPromptHost(): OpenWithPromptHost {
	if (!host) host = new OpenWithPromptHost();
	return host;
}

export function resetOpenWithPromptHost(): void {
	host = null;
}
