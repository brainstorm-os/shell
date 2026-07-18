/** Renders a message body in a sandboxed iframe with remote content blocked
 *  by default (doc 53 §security). HTML bodies go through `buildFrameSrcDoc`
 *  (own CSP, no scripts); plain-text-only bodies render as escaped text. */

import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { t } from "../i18n";
import { buildFrameSrcDoc, hasRemoteContent } from "../logic/remote-content";

export type MailBodyProps = {
	bodyHtmlSafe: string;
	bodyText: string;
	/** Reset the "show remote" toggle when the open message changes. */
	resetKey: string;
};

export function MailBody({ bodyHtmlSafe, bodyText, resetKey }: MailBodyProps): ReactElement {
	const [showRemote, setShowRemote] = useState(false);
	// New message → re-block remote content (state is keyed by resetKey).
	const [forKey, setForKey] = useState(resetKey);
	if (forKey !== resetKey) {
		setForKey(resetKey);
		setShowRemote(false);
	}

	const hasHtml = bodyHtmlSafe.trim().length > 0;
	const hasRemote = useMemo(
		() => (hasHtml ? hasRemoteContent(bodyHtmlSafe) : false),
		[hasHtml, bodyHtmlSafe],
	);
	const srcDoc = useMemo(
		() => (hasHtml ? buildFrameSrcDoc(bodyHtmlSafe, showRemote) : ""),
		[hasHtml, bodyHtmlSafe, showRemote],
	);

	if (!hasHtml && bodyText.trim().length === 0) {
		return <p className="mb-body__empty">{t("body.empty")}</p>;
	}

	return (
		<div className="mb-body">
			{hasRemote && !showRemote ? (
				<div className="mb-body__remote-banner">
					<span>{t("body.remote.blocked")}</span>
					<button
						type="button"
						className="bs-btn bs-btn--sm bs-btn--secondary mb-body__remote-show"
						onClick={() => setShowRemote(true)}
					>
						{t("body.remote.show")}
					</button>
				</div>
			) : null}
			{hasHtml ? (
				<iframe
					className="mb-body__frame"
					title={t("body.frameTitle")}
					sandbox="allow-popups allow-popups-to-escape-sandbox"
					referrerPolicy="no-referrer"
					srcDoc={srcDoc}
				/>
			) : (
				<pre className="mb-body__text">{bodyText}</pre>
			)}
		</div>
	);
}
