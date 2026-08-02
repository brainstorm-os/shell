/**
 * Shell-owned approval for a tool call (Tool-8).
 *
 * `Tool-4` shipped `confirmed: true` as a CALLER ASSERTION that a human had
 * approved a call. That is sound for an app — the assertion is backed by the
 * gesture that reached the app's own code — and unsound for anything else, so
 * two holes were left open and documented rather than fixed:
 *
 *   - an AGENT sending `confirmed: true` would be approving itself, so agents
 *     were refused outright — which meant `Tool-5`'s approval could never be
 *     minted for an agent and agent tool-calling was dead;
 *   - a compromised or sloppy app could send the flag without any human at all,
 *     which `Tool-5` then amplified into a standing approval.
 *
 * This closes both by moving the question where it belongs. The SHELL asks, in
 * the dashboard renderer the user trusts, and the answer never passes through
 * the caller. `confirmed` is gone from the wire.
 *
 * Modelled directly on `CapabilityPromptHost`: a pure class (no Electron
 * imports, so it is unit-testable), a pending map keyed by request id, and the
 * `ipcMain` wiring kept in a separate module. Fail-safe throughout — no
 * dashboard to ask means NOT approved, never "assume yes".
 */

import type { AppToolRecord } from "@brainstorm-os/sdk-types";
import { AppToolApprovalState } from "@brainstorm-os/sdk-types";
import { ulid } from "ulid";

export const TOOL_APPROVAL_PROMPT_CHANNEL = "tools:approval-prompt" as const;
export const TOOL_APPROVAL_REPLY_CHANNEL = "tools:approval-reply" as const;

/** Only a deadline stops a prompt waiting forever; the call's own 30 s
 *  `AppCallHost` deadline does not cover the time a human spends deciding, so
 *  this one is deliberately generous. A prompt that expires is NOT approved. */
export const TOOL_APPROVAL_TIMEOUT_MS = 120_000;

/** What the dashboard renders. Every string here is provider-authored and has
 *  been through Tool-2's screen; the renderer still treats it as data. */
export type ToolApprovalRequest = {
	requestId: string;
	/** Who wants to run it — an app id, or an agent fingerprint. */
	callerAppId: string;
	toolId: string;
	toolTitle: string;
	toolDescription: string;
	providerAppId: string;
	providerLabel: string;
	effect: string;
	/** Why we are asking: a first approval, a re-approval after the declaration
	 *  changed (the rug-pull case), or the effect simply always asking. */
	reason: ToolApprovalReason;
	/** True when the caller is an agent, so the dashboard can say so — "your
	 *  agent wants to…" is a materially different question from "you clicked". */
	agentInitiated: boolean;
};

export enum ToolApprovalReason {
	FirstUse = "first-use",
	DeclarationChanged = "declaration-changed",
	EffectRequiresConfirm = "effect-requires-confirm",
}

export type ToolApprovalSender = {
	send(channel: string, payload: ToolApprovalRequest): void;
};

export function approvalReasonFor(state: AppToolApprovalState): ToolApprovalReason {
	switch (state) {
		case AppToolApprovalState.New:
			return ToolApprovalReason.FirstUse;
		case AppToolApprovalState.Changed:
			return ToolApprovalReason.DeclarationChanged;
		default:
			return ToolApprovalReason.EffectRequiresConfirm;
	}
}

export class ToolApprovalHost {
	private dashboard: ToolApprovalSender | null = null;
	private readonly pending = new Map<string, { resolve: (ok: boolean) => void }>();

	setDashboard(sender: ToolApprovalSender | null): void {
		this.dashboard = sender;
		if (!sender) this.drain();
	}

	/** Ask the user. Resolves false on every path that is not an explicit yes —
	 *  no dashboard, a timeout, a dropped renderer, a malformed reply. */
	async request(input: {
		callerAppId: string;
		tool: AppToolRecord;
		providerLabel: string;
		reason: ToolApprovalReason;
		agentInitiated: boolean;
	}): Promise<boolean> {
		const dashboard = this.dashboard;
		if (!dashboard) return false;

		const requestId = `tap_${ulid()}`;
		let settle: ((ok: boolean) => void) | null = null;
		const promise = new Promise<boolean>((resolve) => {
			settle = resolve;
			this.pending.set(requestId, { resolve });
		});
		const timer = setTimeout(() => {
			if (this.pending.delete(requestId)) settle?.(false);
		}, TOOL_APPROVAL_TIMEOUT_MS);
		// Never keep the process alive for a prompt nobody is looking at.
		timer.unref?.();

		try {
			dashboard.send(TOOL_APPROVAL_PROMPT_CHANNEL, {
				requestId,
				callerAppId: input.callerAppId,
				toolId: input.tool.id,
				toolTitle: input.tool.title,
				toolDescription: input.tool.description,
				providerAppId: input.tool.appId,
				providerLabel: input.providerLabel,
				effect: String(input.tool.effect),
				reason: input.reason,
				agentInitiated: input.agentInitiated,
			});
		} catch {
			// A renderer torn down mid-send is a refusal, not a throw into the
			// caller's dispatch path.
			this.pending.delete(requestId);
			clearTimeout(timer);
			return false;
		}
		const accepted = await promise;
		clearTimeout(timer);
		return accepted;
	}

	/** A reply from the dashboard. Unknown ids drop silently — a duplicate or
	 *  late reply must not resolve some other pending prompt. */
	handleReply(reply: { requestId?: unknown; accept?: unknown }): void {
		if (typeof reply?.requestId !== "string") return;
		const pending = this.pending.get(reply.requestId);
		if (!pending) return;
		this.pending.delete(reply.requestId);
		pending.resolve(reply.accept === true);
	}

	/** Refuse everything in flight — the dashboard went away, so nobody can be
	 *  answering. */
	private drain(): void {
		for (const [, entry] of this.pending) entry.resolve(false);
		this.pending.clear();
	}

	dispose(): void {
		this.drain();
	}

	pendingCount(): number {
		return this.pending.size;
	}
}

let host: ToolApprovalHost | null = null;

export function getToolApprovalHost(): ToolApprovalHost {
	if (!host) host = new ToolApprovalHost();
	return host;
}

export function resetToolApprovalHost(): void {
	host?.dispose();
	host = null;
}
