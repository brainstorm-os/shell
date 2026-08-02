/**
 * The `proposes-write` proposal tray (Tool-8b, doc 78).
 *
 * A `proposes-write` tool RETURNS a proposal; nothing has been written when
 * the result arrives. This tray renders it in the CALLER's context — each
 * change as before → after — and the Apply button is the human gesture that
 * lets the caller persist it. The apply itself is the caller's `onApply`,
 * which MUST write every change of the proposal inside ONE transaction of its
 * own document (a single `doc.transact(...)`), so the whole proposal is one
 * undo step: a user who approves and regrets undoes it with one gesture, not
 * one per field.
 *
 * Trust boundaries, restated where they are enforced:
 *   - the card title / provider attribution come from the already-screened
 *     declaration fields (`tool.title`, `tools.list`-stamped `appLabel`),
 *     never from the result payload;
 *   - the proposal body went through `parseToolProposal` (capped, sanitized,
 *     copied) before it could reach this component — `offer` refuses anything
 *     that does not parse, and the caller reports THAT as a refusal chip;
 *   - `before`/`after` render as React text nodes only — provider data stays
 *     inert however injection-shaped it is;
 *   - a failed apply renders OUR message (`tool.proposal.applyFailed`), never
 *     an error string, mirroring the refusal chips' rule.
 */

import { sanitizeAppLabel } from "@brainstorm-os/sdk-types";
import { useCallback, useState } from "react";
import { humanizeKey } from "../humanize-key";
import { ProposalTraySection } from "./proposal-chrome";
import {
	type AppToolProposal,
	type AppToolProposalChange,
	parseToolProposal,
} from "./tool-proposal";

/** The screened declaration slice the tray renders. Structural, so callers
 *  pass their `AppToolRecord` without this module importing the whole type. */
export type ToolProposalSource = {
	id: string;
	title: string;
	appId: string;
	appLabel?: string;
};

export type ToolProposalEntry = {
	/** Tray-local id — one tool can propose more than once. */
	id: string;
	toolId: string;
	title: string;
	providerLabel: string;
	proposal: AppToolProposal;
};

let seq = 0;

/** Collect proposals for rendering. `offer` parses the raw tool result and
 *  returns whether it was a well-formed proposal — `false` means the caller
 *  should report a `ProviderError` refusal instead (a malformed proposal is a
 *  failed call, not a silently absent card). */
export function useToolProposals(): {
	proposals: readonly ToolProposalEntry[];
	offer: (tool: ToolProposalSource, value: unknown) => boolean;
	dismiss: (id: string) => void;
} {
	const [proposals, setProposals] = useState<readonly ToolProposalEntry[]>([]);

	const offer = useCallback((tool: ToolProposalSource, value: unknown): boolean => {
		const proposal = parseToolProposal(value);
		if (proposal === null) return false;
		seq += 1;
		setProposals((prev) => [
			...prev,
			{
				id: `tool-proposal-${seq}`,
				toolId: tool.id,
				title: tool.title,
				// `tools.list` stamps a sanitized label; re-screening here is
				// defense in depth for a record that arrived any other way.
				providerLabel: sanitizeAppLabel(tool.appLabel) ?? tool.appId,
				proposal,
			},
		]);
		return true;
	}, []);

	const dismiss = useCallback((id: string) => {
		setProposals((prev) => prev.filter((p) => p.id !== id));
	}, []);

	return { proposals, offer, dismiss };
}

export type ToolProposalTrayProps = {
	proposals: readonly ToolProposalEntry[];
	/**
	 * Persist an approved proposal. THE ONE-UNDO-STEP CONTRACT LIVES HERE: the
	 * caller applies every change inside ONE transaction of its own document
	 * (one `doc.transact(() => { ...all changes })`), never one transact per
	 * change. A throw/rejection keeps the card with a failure line; a resolve
	 * dismisses it.
	 */
	onApply: (entry: ToolProposalEntry) => Promise<void> | void;
	onDismiss: (id: string) => void;
	/** Translate a key. Apps pass their own `t`; the SDK never ships copy. */
	t: (key: string, params?: Record<string, string | number>) => string;
};

function ChangeRow({
	change,
	t,
}: {
	change: AppToolProposalChange;
	t: ToolProposalTrayProps["t"];
}) {
	return (
		<div className="bs-proposal__field" data-testid="tool-proposal-change">
			<span className="bs-proposal__field-label">{change.label ?? humanizeKey(change.key)}</span>
			{change.before !== undefined ? (
				<del className="bs-proposal__before" aria-label={t("tool.proposal.before")}>
					{change.before}
				</del>
			) : null}
			<ins className="bs-proposal__after" aria-label={t("tool.proposal.after")}>
				{change.after}
			</ins>
		</div>
	);
}

function ProposalCard({
	entry,
	onApply,
	onDismiss,
	t,
}: {
	entry: ToolProposalEntry;
	onApply: ToolProposalTrayProps["onApply"];
	onDismiss: ToolProposalTrayProps["onDismiss"];
	t: ToolProposalTrayProps["t"];
}) {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	const apply = async () => {
		if (busy) return;
		setFailed(false);
		setBusy(true);
		try {
			await onApply(entry);
			onDismiss(entry.id);
		} catch {
			// The caller's own write failed. Render OUR line — an exception
			// message is not user copy — and keep the card so the user can retry
			// or dismiss.
			setFailed(true);
			setBusy(false);
		}
	};

	return (
		<div
			className="bs-proposal"
			role="group"
			aria-label={t("tool.proposal.aria", { title: entry.title })}
			data-testid="tool-proposal"
		>
			<div className="bs-proposal__head">
				<span className="bs-proposal__kind">{entry.title}</span>
				<span className="bs-proposal__meta">{entry.providerLabel}</span>
			</div>
			{entry.proposal.summary !== undefined ? (
				<p className="bs-proposal__summary">{entry.proposal.summary}</p>
			) : null}
			<div className="bs-proposal__fields">
				{entry.proposal.changes.map((change, index) => (
					// Positional keys are correct here: a proposal is immutable once
					// offered, and two changes may legally share a `key`.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					<ChangeRow key={index} change={change} t={t} />
				))}
			</div>
			{failed ? (
				<p className="bs-proposal__error" role="alert" data-testid="tool-proposal-error">
					{t("tool.proposal.applyFailed")}
				</p>
			) : null}
			<div className="bs-proposal__actions">
				<button
					type="button"
					className="bs-btn"
					data-bs-primary=""
					disabled={busy}
					onClick={() => void apply()}
					data-testid="tool-proposal-apply"
				>
					{t("tool.proposal.apply")}
				</button>
				<button
					type="button"
					className="bs-btn"
					disabled={busy}
					onClick={() => onDismiss(entry.id)}
					data-testid="tool-proposal-dismiss"
				>
					{t("tool.proposal.dismiss")}
				</button>
			</div>
		</div>
	);
}

export function ToolProposalTray({ proposals, onApply, onDismiss, t }: ToolProposalTrayProps) {
	if (proposals.length === 0) return null;
	return (
		<ProposalTraySection
			title={t("tool.proposal.title")}
			subtitle={t("tool.proposal.subtitle")}
			testId="tool-proposal-tray"
		>
			{proposals.map((entry) => (
				<ProposalCard key={entry.id} entry={entry} onApply={onApply} onDismiss={onDismiss} t={t} />
			))}
		</ProposalTraySection>
	);
}
