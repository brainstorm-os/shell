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

/** Mirrors main's `TOOL_APPROVAL_LABEL_MAX`. Main already clamps; this is the
 *  renderer refusing to trust that it did, on a surface where a long name
 *  would push the app id out of sight. */
const PARTY_NAME_MAX = 48;

function clampName(name: string): string {
	const points = Array.from(name);
	if (points.length <= PARTY_NAME_MAX) return name;
	return `${points.slice(0, PARTY_NAME_MAX).join("").trimEnd()}…`;
}

/** One party to the call: its name, and — always — its registry app id.
 *
 * A manifest `name` is free text, so any app may call itself "Notes". The id
 * is minted by the registry and cannot be chosen to collide with an installed
 * app's, which makes it the half of this row that identifies anything. It is
 * quieter than the name, not hidden: the name is what a person reads first,
 * the id is what tells two same-named apps apart. Both are text nodes. */
function Party({ role, name, appId, testId }: PartyProps) {
	const shown = clampName(name);
	return (
		<div className="tool-approval__party" data-testid={testId}>
			<dt className="tool-approval__party-role">{role}</dt>
			<dd className="tool-approval__party-who">
				{shown !== appId && <span className="tool-approval__party-name">{shown}</span>}
				<span className="tool-approval__party-id">{appId}</span>
			</dd>
		</div>
	);
}

type PartyProps = { role: string; name: string; appId: string; testId: string };

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
									provider: clampName(request.providerLabel),
								})
							: t("tools.approval.body", {
									tool: request.toolTitle,
									provider: clampName(request.providerLabel),
									caller: clampName(request.callerLabel),
								})}
					</p>
					<dl className="tool-approval__parties">
						<Party
							role={t("tools.approval.party.caller")}
							name={request.callerLabel}
							appId={request.callerAppId}
							testId="tool-approval-caller"
						/>
						<Party
							role={t("tools.approval.party.provider")}
							name={request.providerLabel}
							appId={request.providerAppId}
							testId="tool-approval-provider"
						/>
					</dl>
					{/* Provider-authored text, rendered as data. */}
					<p className="capability-prompt__capability">{request.toolDescription}</p>
					<div className="capability-prompt__actions">
						<Button ref={declineRef} variant={ButtonVariant.Neutral} onClick={() => respond(false)}>
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
