/** Right column: the open message — header (sender, recipients, date,
 *  subject), the sandboxed body, and the flag / read / reply actions.
 *  Received mail is immutable; the only mutations are flags (server state)
 *  and reply/forward dispatch as intents. */

import { Icon, IconName } from "@brainstorm/sdk/icon";
import type { ReactElement } from "react";
import { t } from "../i18n";
import { messageDateLabel } from "../logic/format";
import { recipientSummary, senderLabel } from "../logic/mail-view";
import type { MessageView } from "../types/mail-view";
import { MailBody } from "./mail-body";

export type ReadingPaneProps = {
	message: MessageView | null;
	now: number;
	/** Shown on the narrow layout so the user can return to the list. */
	showBack: boolean;
	onBack: () => void;
	onToggleRead: () => void;
	onToggleFlag: () => void;
	/** Absent ⇒ sending unavailable (demo mode) — the buttons hide. */
	onReply?: () => void;
	onForward?: () => void;
};

export function ReadingPane({
	message,
	now,
	showBack,
	onBack,
	onToggleRead,
	onToggleFlag,
	onReply,
	onForward,
}: ReadingPaneProps): ReactElement {
	if (!message) {
		return (
			<div className="mb-reading mb-reading--empty">
				<div className="mb-reading__placeholder">
					<Icon name={IconName.KindEmail} className="mb-reading__placeholder-icon" />
					<p className="mb-reading__placeholder-title">{t("reading.empty.title")}</p>
					<p className="mb-reading__placeholder-blurb">{t("reading.empty.blurb")}</p>
				</div>
			</div>
		);
	}

	const sender = senderLabel(message) || t("list.noSender");
	const toLine = recipientSummary(message.to);
	const ccLine = recipientSummary(message.cc);

	return (
		<div className="mb-reading">
			<div className="mb-reading__head">
				<div className="mb-reading__titlerow">
					{showBack ? (
						<button type="button" className="mb-iconbtn" onClick={onBack} aria-label={t("reading.back")}>
							<Icon name={IconName.CaretLeft} />
						</button>
					) : null}
					<h2 className="mb-reading__subject">{message.subject || t("list.noSubject")}</h2>
					<div className="mb-reading__actions">
						{onReply ? (
							<button type="button" className="bs-btn bs-btn--sm bs-btn--secondary" onClick={onReply}>
								{t("reading.reply")}
							</button>
						) : null}
						{onForward ? (
							<button type="button" className="bs-btn bs-btn--sm bs-btn--secondary" onClick={onForward}>
								{t("reading.forward")}
							</button>
						) : null}
						<button
							type="button"
							className={`mb-iconbtn${message.flagged ? " is-on" : ""}`}
							onClick={onToggleFlag}
							aria-pressed={message.flagged}
							aria-label={message.flagged ? t("reading.unflag") : t("reading.flag")}
						>
							<Icon name={IconName.Star} />
						</button>
						<button
							type="button"
							className="mb-iconbtn"
							onClick={onToggleRead}
							aria-label={message.unread ? t("reading.markRead") : t("reading.markUnread")}
						>
							<Icon name={IconName.Read} />
						</button>
					</div>
				</div>
				<div className="mb-reading__meta">
					<span className="mb-reading__sender">{sender}</span>
					<span className="mb-reading__date">{messageDateLabel(message.receivedAt, now)}</span>
				</div>
				{toLine ? (
					<div className="mb-reading__recipients">
						<span className="mb-reading__reclabel">{t("reading.to")}</span> {toLine}
					</div>
				) : null}
				{ccLine ? (
					<div className="mb-reading__recipients">
						<span className="mb-reading__reclabel">{t("reading.cc")}</span> {ccLine}
					</div>
				) : null}
			</div>

			<MailBody
				bodyHtmlSafe={message.bodyHtmlSafe}
				bodyText={message.bodyText}
				resetKey={message.id}
			/>
		</div>
	);
}
