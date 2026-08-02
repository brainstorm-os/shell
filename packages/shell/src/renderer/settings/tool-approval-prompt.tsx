/**
 * Tool-approval modal (Tool-8, doc 78).
 *
 * `Tool-4` let the CALLER assert that a human had approved a tool call. This
 * is the receiver that makes the shell-owned replacement real: main posts
 * `tools:approval-prompt`, the dashboard renders this, and `respond()` settles
 * the pending call. Without it the approval path is a dead end — every
 * confirm-requiring call would block for two minutes and refuse, which is
 * exactly what the rung's own security review caught.
 *
 * Same fail-safe keyboard contract as `<CapabilityPromptHost />`, for the same
 * reason: this is a SECURITY decision, so there is no global Enter-approves
 * shortcut (a stray Enter must never run someone else's tool), Escape declines
 * via `Popover`'s `onClose`, and initial focus lands on **Decline** so the
 * default action a keyboard or screen-reader user activates is the safe one.
 *
 * Every provider-authored string here (title, description, provider label) has
 * been through Tool-2's screen and is rendered as TEXT — never as markup, and
 * never as instructions.
 */

import { AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { ToolApprovalPromptRequest } from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonVariant } from "../ui/button";
import { Popover } from "../ui/popover";
import { PopoverSize } from "../ui/popover-types";

/** The question is materially different per reason, so the wording is too —
 *  a rug-pull must not read like a routine first approval. */
function titleFor(request: ToolApprovalPromptRequest): string {
	if (request.reason === "declaration-changed") return t("tools.approval.changed.title");
	if (request.agentInitiated) return t("tools.approval.agent.title");
	return t("tools.approval.title");
}

export function ToolApprovalPromptHost() {
	const [request, setRequest] = useState<ToolApprovalPromptRequest | null>(null);
	const declineRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		return window.brainstorm.toolApprovalPrompt.on((req) => {
			setRequest(req);
		});
	}, []);

	const respond = (accept: boolean) => {
		if (!request) return;
		window.brainstorm.toolApprovalPrompt.respond(request.requestId, accept);
		setRequest(null);
	};

	return (
		<AnimatePresence mode="wait">
			{request && (
				<Popover
					key={request.requestId}
					title={titleFor(request)}
					onClose={() => respond(false)}
					size={PopoverSize.Medium}
					initialFocusRef={declineRef}
					testId="tool-approval-prompt"
				>
					<p className="capability-prompt__reason">
						{request.reason === "declaration-changed"
							? t("tools.approval.changed.body", {
									tool: request.toolTitle,
									provider: request.providerLabel,
								})
							: t("tools.approval.body", {
									tool: request.toolTitle,
									provider: request.providerLabel,
									caller: request.callerAppId,
								})}
					</p>
					{/* Provider-authored text, rendered as data. */}
					<p className="capability-prompt__capability">{request.toolDescription}</p>
					<div className="capability-prompt__actions">
						<Button ref={declineRef} onClick={() => respond(false)}>
							{t("tools.approval.decline")}
						</Button>
						<Button variant={ButtonVariant.Primary} onClick={() => respond(true)}>
							{t("tools.approval.approve")}
						</Button>
					</div>
				</Popover>
			)}
		</AnimatePresence>
	);
}
