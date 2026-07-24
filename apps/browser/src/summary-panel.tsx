/**
 * Browser-8 — the page-summary panel.
 *
 * Presentational only: the extract → transform round-trip lives in `app.tsx`
 * (so the `ai.use` call sits on the user's menu gesture) and the decisions live
 * in `logic/summarize.ts`. This renders the four states the user can be in —
 * reading the page, waiting on the model, a summary, or a reason it couldn't.
 *
 * It is a dismissible notice over the content area, like the download tray: a
 * summary is a glance, not a mode, so it never resizes the page or takes focus
 * away from browsing.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import { t } from "./i18n";
import { SummaryFailure, SummaryPhase } from "./logic/summarize";

function failureText(reason: SummaryFailure | null): string {
	switch (reason) {
		case SummaryFailure.NoContent:
			return t("summary.failed.noContent");
		case SummaryFailure.NoModel:
			return t("summary.failed.noModel");
		default:
			return t("summary.failed.generic");
	}
}

export type SummaryPanelProps = {
	phase: SummaryPhase;
	/** The page title the summary belongs to — a summary with no subject is a
	 *  floating claim, especially once the user has switched tabs. */
	title: string;
	summary: string;
	failure: SummaryFailure | null;
	onDismiss: () => void;
};

export function SummaryPanel({
	phase,
	title,
	summary,
	failure,
	onDismiss,
}: SummaryPanelProps): ReactElement | null {
	if (phase === SummaryPhase.Idle) return null;
	const busy = phase === SummaryPhase.Reading || phase === SummaryPhase.Summarizing;

	return (
		<section
			className="browser__summary"
			aria-label={t("summary.title")}
			data-testid="browser-summary"
			data-phase={phase}
		>
			<header className="browser__summary-head">
				<span className="browser__summary-title">
					<Icon name={IconName.Sparkle} size={13} />
					{t("summary.title")}
				</span>
				<button
					type="button"
					className="browser__navbtn"
					aria-label={t("summary.dismiss")}
					data-bs-tooltip={t("summary.dismiss")}
					onClick={onDismiss}
					data-testid="browser-summary-dismiss"
				>
					<Icon name={IconName.Close} size={13} />
				</button>
			</header>
			<p className="browser__summary-source">{title}</p>
			{busy ? (
				<p className="browser__summary-body" role="status">
					{phase === SummaryPhase.Reading ? t("summary.reading") : t("summary.summarizing")}
				</p>
			) : phase === SummaryPhase.Failed ? (
				<p className="browser__summary-body browser__summary-body--failed" role="alert">
					{failureText(failure)}
				</p>
			) : (
				<p className="browser__summary-body" data-testid="browser-summary-text">
					{summary}
				</p>
			)}
			{phase === SummaryPhase.Ready ? (
				<p className="browser__summary-note">{t("summary.note")}</p>
			) : null}
		</section>
	);
}
