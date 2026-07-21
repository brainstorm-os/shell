/**
 * OS-handoff first-use consent prompt (OpenRes-1c).
 *
 * Main posts `os-handoff:prompt` carrying `{requestId, signature, uri}`;
 * the dashboard surfaces this modal so the user can decide whether to
 * leave the vault for that signature (`scheme:mailto`, `ext:pdf`, etc.).
 * Allow / Deny are sticky (the bus persists via `setOsHandoffConsent`,
 * keyed on `signature`); Cancel leaves the consent unset so the next
 * attempt re-prompts.
 *
 * Chrome (backdrop / panel / Escape) comes from the shared `<Popover>`
 * per CLAUDE.md. `Enter` accepts via the shortcut registry
 * (`shell/popover.confirm`) so the binding stays user-rebindable and
 * cheatsheet-listed. The pattern mirrors `CapabilityPromptHost`
 * verbatim — same singleton host, same IPC shape, same chrome.
 */

import {
	OsHandoffPromptDecision,
	OsHandoffSignatureKind,
	parseOsHandoffSignature,
} from "@brainstorm-os/sdk-types";
import { AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import type { OsHandoffPromptRequest } from "../../preload";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { Button, ButtonVariant } from "../ui/button";
import { Popover } from "../ui/popover";
import { PopoverSize } from "../ui/popover-types";
import "./capability-prompt.css";

export function OsHandoffPromptHost() {
	const [request, setRequest] = useState<OsHandoffPromptRequest | null>(null);

	useEffect(() => {
		// Defensive guard against a stale preload bundle (the dev shell's
		// renderer HMRs but the preload bundle only refreshes on a full
		// shell restart). Without this a renderer hot-reload that picks up
		// a new component mounted against a pre-existing preload throws an
		// unmount-crash loop in the error boundary. Per
		// [[feedback_apps_build_separately_from_shell]] the user must still
		// restart the shell to actually receive prompts — this guard just
		// keeps the dashboard rendering until then.
		const bridge = window.brainstorm.osHandoffPrompt;
		if (!bridge) {
			console.warn(
				"[brainstorm] OS-handoff prompt bridge not exposed by preload — restart the shell to pick up the new preload bundle.",
			);
			return;
		}
		return bridge.on((req) => {
			setRequest(req);
		});
	}, []);

	const respond = (decision: OsHandoffPromptDecision) => {
		if (!request) return;
		const bridge = window.brainstorm.osHandoffPrompt;
		if (!bridge) {
			setRequest(null);
			return;
		}
		bridge.respond(request.requestId, decision);
		setRequest(null);
	};

	// Enter accepts (Allow) — the active, remembered choice. Esc fires
	// `shell/popover.close` via the Popover primitive and routes to
	// Cancel (not Deny — closing the modal shouldn't make a denial
	// sticky; the user can re-trigger the same target).
	useShortcut("shell/popover.confirm", () => respond(OsHandoffPromptDecision.Allow), {
		enabled: request !== null,
	});

	return (
		<AnimatePresence mode="wait">
			{request && (
				<Popover
					key={request.requestId}
					title={t("shell.osHandoff.prompt.title")}
					onClose={() => respond(OsHandoffPromptDecision.Cancel)}
					size={PopoverSize.Medium}
					testId="os-handoff-prompt"
				>
					<p className="capability-prompt__app">
						{t("shell.osHandoff.prompt.intro", { signature: signatureLabel(request.signature) })}
					</p>
					<p className="capability-prompt__capability">
						<code>{request.uri}</code>
					</p>
					<p className="capability-prompt__reason">{t("shell.osHandoff.prompt.reason")}</p>
					<div className="capability-prompt__actions">
						<Button
							variant={ButtonVariant.Destructive}
							onClick={() => respond(OsHandoffPromptDecision.Deny)}
							className="capability-prompt__action--destructive"
						>
							{t("shell.osHandoff.prompt.deny")}
						</Button>
						<Button
							variant={ButtonVariant.Neutral}
							onClick={() => respond(OsHandoffPromptDecision.Cancel)}
						>
							{t("shell.osHandoff.prompt.cancel")}
						</Button>
						<Button
							variant={ButtonVariant.Primary}
							onClick={() => respond(OsHandoffPromptDecision.Allow)}
						>
							{t("shell.osHandoff.prompt.allow")}
						</Button>
					</div>
				</Popover>
			)}
		</AnimatePresence>
	);
}

/** Render the per-vault signature as a user-friendly fragment. Wire form
 *  is `scheme:<scheme>` / `ext:<ext>`; the modal copy reads better as
 *  "links of type **mailto**" / "files of type **.pdf**". */
function signatureLabel(signature: string): string {
	const parsed = parseOsHandoffSignature(signature);
	if (!parsed) return signature;
	return parsed.kind === OsHandoffSignatureKind.Scheme ? `${parsed.value}:` : `.${parsed.value}`;
}
