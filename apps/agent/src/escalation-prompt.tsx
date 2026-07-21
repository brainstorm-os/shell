/**
 * Agent-5 — the inline mid-conversation escalation prompt. When the agent loop
 * REFUSES a tool because it's outside the conversation's current grants (a
 * `tool-refused` step with reason `CapabilityDenied`), the app surfaces this
 * inline affordance offering the user to grant that capability FOR THIS
 * CONVERSATION ONLY. Accept extends `toolGrants`; dismiss does nothing.
 *
 * SECURITY: this is the explicit-consent path. It renders only when the refused
 * cap is one the app HOLDS and the conversation does NOT yet grant (computed by
 * the parent). The accept handler routes through `grantCapability`, which is a
 * no-op for any cap outside the app's manifest — so the prompt can never broaden
 * past app-caps even if the refused cap were tampered with. Nothing here
 * auto-grants.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import { grantLabel } from "./conversation-settings-popover";
import { t } from "./i18n";

export type EscalationPromptProps = {
	/** The capability the loop refused (an `intents.dispatch:<verb>` string). */
	cap: string;
	onAllow: () => void;
	onDismiss: () => void;
};

export function EscalationPrompt({ cap, onAllow, onDismiss }: EscalationPromptProps): ReactElement {
	const tool = grantLabel(cap);
	return (
		<div className="agent__escalation" role="alert" data-testid="agent-escalation">
			<div className="agent__escalation-icon" aria-hidden="true">
				<Icon name={IconName.Lock} size={16} />
			</div>
			<div className="agent__escalation-body">
				<p className="agent__escalation-title">{t("escalation.title", { tool })}</p>
				<p className="agent__escalation-blurb">{t("escalation.blurb")}</p>
				<div className="agent__escalation-actions">
					<button
						type="button"
						className="agent__escalation-allow"
						data-bs-primary=""
						onClick={onAllow}
						data-testid="agent-escalation-allow"
					>
						{t("escalation.allow")}
					</button>
					<button
						type="button"
						className="agent__escalation-dismiss"
						onClick={onDismiss}
						data-testid="agent-escalation-dismiss"
					>
						{t("escalation.dismiss")}
					</button>
				</div>
			</div>
		</div>
	);
}
