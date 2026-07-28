/**
 * Reader mode (Browser-5) — the clean article surface.
 *
 * Presentational only: the extract round-trip lives in `app.tsx` (on the
 * user's toggle gesture) and the state decisions in `logic/reader.ts`. This
 * renders the three states — extracting, an article, or why there isn't one.
 *
 * SECURITY / CSP: everything on this sheet is a plain string from the shell's
 * reader projection, rendered as React text nodes. No page HTML is injected
 * (no `dangerouslySetInnerHTML`, no `srcdoc` — a sandboxed app's iframe
 * inherits the parent page CSP anyway, F-439), and no remote images are
 * referenced, so the app-page CSP holds unchanged.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import { t } from "./i18n";
import { ReaderPhase, type ReaderState, readerParagraphs } from "./logic/reader";

export type ReaderViewProps = {
	state: ReaderState;
	onClose: () => void;
};

export function ReaderView({ state, onClose }: ReaderViewProps): ReactElement {
	const article = state.phase === ReaderPhase.Ready ? state.article : null;
	return (
		<section
			className="browser__reader"
			aria-label={t("reader.aria")}
			data-testid="browser-reader"
			data-phase={state.phase}
		>
			<header className="browser__reader-head">
				<span className="browser__reader-badge">
					<Icon name={IconName.View} size={13} />
					{t("reader.badge")}
				</span>
				<button
					type="button"
					className="browser__navbtn"
					aria-label={t("reader.exit")}
					data-bs-tooltip={t("reader.exit")}
					onClick={onClose}
				>
					<Icon name={IconName.Close} size={14} />
				</button>
			</header>
			<div className="browser__reader-scroll">
				{state.phase === ReaderPhase.Loading && (
					<p className="browser__reader-note" role="status">
						{t("reader.loading")}
					</p>
				)}
				{state.phase === ReaderPhase.Empty && (
					<p className="browser__reader-note" role="status">
						{t("reader.empty")}
					</p>
				)}
				{article && (
					<article className="browser__reader-article">
						<h1 className="browser__reader-title">{article.title}</h1>
						{article.byline && <p className="browser__reader-byline">{article.byline}</p>}
						{readerParagraphs(article.text).map((paragraph, index) => (
							// Paragraphs are display-only positional text with no identity
							// of their own; the list only ever renders once per article.
							// biome-ignore lint/suspicious/noArrayIndexKey: static positional list
							<p key={index}>{paragraph}</p>
						))}
						{article.truncated && <p className="browser__reader-note">{t("reader.truncated")}</p>}
					</article>
				)}
			</div>
		</section>
	);
}
