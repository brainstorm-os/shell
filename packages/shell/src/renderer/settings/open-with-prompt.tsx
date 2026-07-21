/**
 * "Open with…" multi-candidate picker (OpenRes-1c slice 6).
 *
 * Main posts `open-with:prompt` carrying `{requestId, signature, uri,
 * candidates}`; the dashboard surfaces this modal so the user picks
 * which app handles the open. The picker is only raised when the
 * `decideOpen` ladder lands on `InVaultOpeners` with 2+ candidates;
 * single-candidate / no-picker paths keep the legacy silent auto-pick.
 *
 * "Remember my choice" persists the pick as the `(open, signature)`
 * default (the bus calls `recordDefaultHandler` for the renderer);
 * unchecked leaves the dispatch session-scoped — the next attempt
 * raises the picker again.
 *
 * Chrome (backdrop / panel / Escape) comes from the shared <Popover>
 * per CLAUDE.md. `Enter` confirms the highlighted row via
 * `shell/popover.confirm` so the binding stays user-rebindable and
 * cheatsheet-listed. Arrow-keys move the radio selection.
 */

import {
	type OpenWithCandidate,
	type OpenWithDecision,
	OpenWithDecisionKind,
	OsHandoffSignatureKind,
	parseOsHandoffSignature,
} from "@brainstorm-os/sdk-types";
import {
	type CompositeItemProps,
	Orientation,
	SelectionAttribute,
	useCompositeKeyboard,
} from "@brainstorm-os/sdk/a11y";
import { AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import type { OpenWithPromptRequest } from "../../preload";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { Button, ButtonVariant } from "../ui/button";
import { Popover } from "../ui/popover";
import { PopoverSize } from "../ui/popover-types";
import "./capability-prompt.css";
import "./open-with-prompt.css";

/** Stable empty list so the composite hook's `count`/`activeIndex` stay
 *  referentially clean while no prompt is raised. */
const NO_CANDIDATES: readonly OpenWithCandidate[] = [];

export function OpenWithPromptHost() {
	const [request, setRequest] = useState<OpenWithPromptRequest | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [remember, setRemember] = useState(false);

	useEffect(() => {
		// Defensive guard against a stale preload bundle (the dev shell's
		// renderer HMRs but the preload bundle only refreshes on a full
		// shell restart). Mirrors the os-handoff-prompt host's guard.
		const bridge = window.brainstorm.openWithPrompt;
		if (!bridge) {
			console.warn(
				"[brainstorm] Open-with prompt bridge not exposed by preload — restart the shell to pick up the new preload bundle.",
			);
			return;
		}
		return bridge.on((req) => {
			setRequest(req);
			setSelected(req.candidates[0]?.appId ?? null);
			setRemember(false);
		});
	}, []);

	const respond = (decision: OpenWithDecision) => {
		if (!request) return;
		const bridge = window.brainstorm.openWithPrompt;
		if (!bridge) {
			setRequest(null);
			return;
		}
		bridge.respond(request.requestId, decision);
		setRequest(null);
	};

	const pickSelected = () => {
		if (!request || !selected) return;
		respond({ kind: OpenWithDecisionKind.Pick, appId: selected, remember });
	};

	// Enter confirms the highlighted row. The Popover primitive owns
	// `shell/popover.close` → routes to Cancel via `onClose`. The composite
	// hook also `preventDefault`s Enter while focus is on the radiogroup, so
	// this rebindable chord only fires when focus is elsewhere (the dispatcher
	// skips `defaultPrevented` events) — no double-confirm.
	useShortcut("shell/popover.confirm", pickSelected, { enabled: request !== null });

	const candidates = request?.candidates ?? NO_CANDIDATES;
	const activeIndex = Math.max(
		0,
		candidates.findIndex((c) => c.appId === selected),
	);
	const confirmByIndex = (i: number) => {
		const c = candidates[i];
		if (c) respond({ kind: OpenWithDecisionKind.Pick, appId: c.appId, remember });
	};
	const { containerProps: listProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: candidates.length,
		activeIndex,
		onActiveIndexChange: (i) => {
			const c = candidates[i];
			if (c) setSelected(c.appId);
		},
		onActivate: confirmByIndex,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.AriaChecked,
	});

	if (!request) {
		return <AnimatePresence mode="wait" />;
	}

	return (
		<AnimatePresence mode="wait">
			<Popover
				key={request.requestId}
				title={t("shell.openWith.prompt.title")}
				onClose={() => respond({ kind: OpenWithDecisionKind.Cancel })}
				size={PopoverSize.Medium}
				testId="open-with-prompt"
			>
				<p className="capability-prompt__app">
					{t("shell.openWith.prompt.intro", { signature: signatureLabel(request.signature) })}
				</p>
				<p className="capability-prompt__capability">
					<code>{request.uri}</code>
				</p>
				<div
					{...listProps}
					aria-label={t("shell.openWith.prompt.listAria")}
					className="open-with-prompt__list"
				>
					{request.candidates.map((candidate, index) => (
						<CandidateRow
							key={candidate.appId}
							candidate={candidate}
							selected={selected === candidate.appId}
							itemProps={getItemProps(index)}
							onSelect={() => setSelected(candidate.appId)}
							onConfirm={() => confirmByIndex(index)}
						/>
					))}
				</div>
				<label className="open-with-prompt__remember">
					<input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
					{t("shell.openWith.prompt.remember", { signature: signatureLabel(request.signature) })}
				</label>
				<div className="capability-prompt__actions">
					<Button
						variant={ButtonVariant.Neutral}
						onClick={() => respond({ kind: OpenWithDecisionKind.Cancel })}
					>
						{t("shell.openWith.prompt.cancel")}
					</Button>
					<Button variant={ButtonVariant.Primary} onClick={pickSelected} disabled={selected === null}>
						{t("shell.openWith.prompt.open")}
					</Button>
				</div>
			</Popover>
		</AnimatePresence>
	);
}

function CandidateRow({
	candidate,
	selected,
	itemProps,
	onSelect,
	onConfirm,
}: {
	candidate: OpenWithCandidate;
	selected: boolean;
	itemProps: CompositeItemProps;
	onSelect: () => void;
	onConfirm: () => void;
}) {
	const className = selected
		? "open-with-prompt__row open-with-prompt__row--selected"
		: "open-with-prompt__row";
	// The OS-handoff candidate (slice 7) carries the English label
	// `OS_HANDOFF_APP_LABEL` from sdk-types so the bus stays free of
	// renderer concerns; the renderer maps it to the localized copy
	// here so the modal honours [[feedback_keyboard_and_i18n]].
	const label =
		candidate.kind === "os-handoff" ? t("shell.openWith.prompt.osHandoffLabel") : candidate.label;
	const hintKey =
		candidate.kind === "primary"
			? "shell.openWith.prompt.defaultHint"
			: candidate.kind === "os-handoff"
				? "shell.openWith.prompt.osHandoffHint"
				: null;
	return (
		<button
			type="button"
			{...itemProps}
			className={className}
			onClick={onSelect}
			onDoubleClick={onConfirm}
		>
			<span className="open-with-prompt__row-label">{label}</span>
			{hintKey !== null ? <span className="open-with-prompt__row-hint">{t(hintKey)}</span> : null}
		</button>
	);
}

/** Render the per-vault signature as a user-friendly fragment. Same
 *  helper-style as `os-handoff-prompt.tsx`. */
function signatureLabel(signature: string): string {
	const parsed = parseOsHandoffSignature(signature);
	if (!parsed) return signature;
	return parsed.kind === OsHandoffSignatureKind.Scheme ? `${parsed.value}:` : `.${parsed.value}`;
}
