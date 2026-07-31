/**
 * Agent-Teams-3 — the approve/discard card an agent's staged proposal renders
 * as, inline in the channel transcript.
 *
 * Everyone in the channel sees the same card, so the card is a projection of
 * the message row, not of local state: a PENDING proposal offers the two
 * decisions, a settled one shows the outcome (and, when an approval created
 * something, a back-link that opens it). The decision itself is a privileged
 * main-side write — this component only asks for it and reports honestly what
 * came back.
 *
 * Honesty rules encoded here:
 *   · both buttons disable while a decision is in flight, so one card can never
 *     fire two writes (the host also refuses the second, but a live UI should
 *     not depend on that);
 *   · a failure is rendered, never swallowed — every `{ ok: false, reason }`
 *     the host can return has its own line, and anything unrecognised falls to
 *     a generic one;
 *   · when the host offers no decision surface at all the buttons are DISABLED
 *     with a visible explanation rather than enabled-and-dead.
 */

import { ProposeKind } from "@brainstorm-os/sdk-types";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { type ReactElement, useState } from "react";
import { type ChatMessageId, t } from "./i18n";
import {
	type ChannelProposal,
	type ChannelProposalKind,
	ChannelProposalStatus,
	ProposalDecision,
	ProposalDecisionFailure,
	type ProposalDecisionResult,
	proposalFieldRows,
} from "./logic/proposal";

/** What the card needs from the app around it: whether decisions can be made
 *  at all, how to make one, and how to open what an approval created. */
export type ProposalHost = {
	canDecide: boolean;
	/** Never throws — the app normalises a rejection into `{ ok: false }`. */
	decide: (messageId: string, decision: ProposalDecision) => Promise<ProposalDecisionResult>;
	open: (entityId: string, entityType: string) => void;
};

const KIND_LABEL: Record<ChannelProposalKind, ChatMessageId> = {
	[ProposeKind.Note]: "proposal.kind.note",
	[ProposeKind.Task]: "proposal.kind.task",
	[ProposeKind.Event]: "proposal.kind.event",
	[ProposeKind.Bookmark]: "proposal.kind.bookmark",
	[ProposeKind.Contact]: "proposal.kind.contact",
};

const KIND_ICON: Record<ChannelProposalKind, IconName> = {
	[ProposeKind.Note]: IconName.KindFile,
	[ProposeKind.Task]: IconName.CheckCircle,
	[ProposeKind.Event]: IconName.KindDate,
	[ProposeKind.Bookmark]: IconName.KindLink,
	[ProposeKind.Contact]: IconName.AddressBook,
};

/** Every field name the five channel-proposal descriptors can produce. A key
 *  outside this table cannot come from the sanctioned propose path, so it falls
 *  back to the raw key — data, not chrome — rather than rendering blank. */
const FIELD_LABEL: Record<string, ChatMessageId> = {
	title: "proposal.field.title",
	body: "proposal.field.body",
	dueDate: "proposal.field.dueDate",
	status: "proposal.field.status",
	notes: "proposal.field.notes",
	start: "proposal.field.start",
	end: "proposal.field.end",
	location: "proposal.field.location",
	url: "proposal.field.url",
	note: "proposal.field.note",
	name: "proposal.field.name",
	email: "proposal.field.email",
	phone: "proposal.field.phone",
	company: "proposal.field.company",
};

const FAILURE_MESSAGE: Record<ProposalDecisionFailure, ChatMessageId> = {
	[ProposalDecisionFailure.NotFound]: "proposal.error.notFound",
	[ProposalDecisionFailure.NotAProposal]: "proposal.error.notAProposal",
	[ProposalDecisionFailure.AlreadyDecided]: "proposal.error.alreadyDecided",
	[ProposalDecisionFailure.UntrustedAgent]: "proposal.error.untrustedAgent",
	[ProposalDecisionFailure.Unavailable]: "proposal.error.unavailable",
};

function fieldLabel(key: string): string {
	const id = FIELD_LABEL[key];
	return id ? t(id) : key;
}

function failureMessage(reason: string): string {
	const id = FAILURE_MESSAGE[reason as ProposalDecisionFailure];
	return id ? t(id) : t("proposal.error.generic");
}

export function ProposalCard({
	messageId,
	proposal,
	host,
}: {
	messageId: string;
	proposal: ChannelProposal;
	host: ProposalHost;
}): ReactElement {
	// `busy` deliberately stays true after a SUCCESSFUL decision: the settled
	// card arrives with the next vault snapshot, and re-enabling the buttons in
	// that gap would invite a second (doomed) write on the same card.
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { artifact, status } = proposal;
	const pending = status === ChannelProposalStatus.Pending;

	const decide = async (decision: ProposalDecision): Promise<void> => {
		if (busy || !host.canDecide) return;
		setError(null);
		setBusy(true);
		const result = await host.decide(messageId, decision);
		if (!result.ok) {
			setError(failureMessage(result.reason));
			setBusy(false);
		}
	};

	return (
		<section
			className="chat__proposal"
			data-status={status}
			data-testid="chat-proposal"
			aria-label={t("proposal.aria", {
				kind: t(KIND_LABEL[artifact.kind]),
				summary: artifact.summary,
			})}
		>
			<header className="chat__proposal-head">
				<span className="chat__proposal-eyebrow">
					<Icon name={IconName.Sparkle} size={12} />
					{t("proposal.eyebrow")}
				</span>
				<span className="chat__proposal-kind" data-testid="chat-proposal-kind">
					<Icon name={KIND_ICON[artifact.kind]} size={12} />
					{t(KIND_LABEL[artifact.kind])}
				</span>
			</header>

			<p className="chat__proposal-summary">{artifact.summary}</p>

			<dl className="chat__proposal-fields" data-testid="chat-proposal-fields">
				{proposalFieldRows(artifact).map((row) => (
					<div key={row.key} className="chat__proposal-field">
						<dt className="chat__proposal-field-label">{fieldLabel(row.key)}</dt>
						<dd className="chat__proposal-field-value">{row.value}</dd>
					</div>
				))}
			</dl>

			{pending ? (
				<div className="chat__proposal-actions">
					<button
						type="button"
						className="bs-btn"
						data-bs-primary=""
						data-testid="chat-proposal-approve"
						disabled={busy || !host.canDecide}
						// A disabled control fires no pointer events, so the native title is
						// the only explanation a blocked user can get.
						{...(host.canDecide ? {} : { title: t("proposal.unavailable") })}
						onClick={() => void decide(ProposalDecision.Approve)}
					>
						{busy ? t("proposal.deciding") : t("proposal.approve")}
					</button>
					<button
						type="button"
						className="bs-btn"
						data-testid="chat-proposal-discard"
						disabled={busy || !host.canDecide}
						{...(host.canDecide ? {} : { title: t("proposal.unavailable") })}
						onClick={() => void decide(ProposalDecision.Discard)}
					>
						{t("proposal.discard")}
					</button>
					{host.canDecide ? null : (
						<span className="chat__proposal-hint" data-testid="chat-proposal-unavailable">
							{t("proposal.unavailable")}
						</span>
					)}
				</div>
			) : (
				<div className="chat__proposal-actions">
					<span className="chat__proposal-outcome" data-testid="chat-proposal-outcome">
						<Icon
							name={status === ChannelProposalStatus.Approved ? IconName.CheckCircle : IconName.Close}
							size={13}
						/>
						{status === ChannelProposalStatus.Approved ? t("proposal.approved") : t("proposal.discarded")}
					</span>
					{status === ChannelProposalStatus.Approved && proposal.createdEntityId ? (
						<button
							type="button"
							className="bs-btn"
							data-testid="chat-proposal-open"
							onClick={() => host.open(proposal.createdEntityId ?? "", artifact.entityType)}
						>
							{t("proposal.open")}
						</button>
					) : null}
				</div>
			)}

			{error ? (
				<p className="chat__proposal-error" role="alert" data-testid="chat-proposal-error">
					{error}
				</p>
			) : null}
		</section>
	);
}
