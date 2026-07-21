/**
 * Help-1 — privileged shell Help center, peer to Settings / Marketplace.
 *
 * Three-pane layout:
 *
 *   - Sidebar (left): section/topic tree from the bundled corpus.
 *   - Toolbar (top of main): search input + per-article header.
 *   - Body (right): rendered article (Markdown → safe React tree).
 *
 * The corpus and topic list arrive through `window.brainstorm.help`;
 * articles are fetched lazily by topicId. Escape closes via the shared
 * `<Popover>` chord wiring; `CmdOrCtrl+F` re-focuses the search input
 * (component-scoped through the shortcut registry, never raw `e.key`).
 */

import { useFocusTrap } from "@brainstorm-os/sdk/a11y";
import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HelpArticle as HelpArticleType, HelpHit } from "../../preload";
import { FeedbackDialog } from "../feedback/feedback-dialog";
import { t } from "../i18n/t";
import { useShortcut } from "../shortcuts/use-shortcut";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Icon, IconName } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { HelpArticle } from "./help-article";
import "./help.css";
import { HelpSearchbar } from "./help-searchbar";
import { HelpSidebar } from "./help-sidebar";
import { useHelpRoute } from "./use-help-route";

/** Public tracker for the zero-infra feedback path — opens through the
 *  external-link ladder (`wireExternalLinkRouting` denies the popup and
 *  routes the URL), so the user lands on the prefilled issue templates. */
const GITHUB_ISSUES_URL = "https://github.com/brainstorm-os/shell/issues/new/choose";

export type HelpProps = {
	readonly onClose: () => void;
	readonly initialTopicId?: string | null;
	/** Wired by the dashboard to bump `WhatsNewPopover`'s `manualOpenSignal`.
	 *  The Help header surfaces a "See what's new" button when supplied;
	 *  omit in tests / standalone use to hide the entry point. */
	readonly onOpenWhatsNew?: () => void;
	readonly fetchArticle?: (topicId: string) => Promise<HelpArticleType | null>;
	readonly fetchCorpus?: () => Promise<{ articles: readonly HelpArticleType[] }>;
	readonly search?: (text: string, limit?: number) => Promise<HelpHit[]>;
};

export function Help({
	onClose,
	initialTopicId = null,
	onOpenWhatsNew,
	fetchArticle,
	fetchCorpus,
	search,
}: HelpProps) {
	const { topicId, setTopicId } = useHelpRoute(initialTopicId ?? null);
	const [articles, setArticles] = useState<readonly HelpArticleType[]>([]);
	const [article, setArticle] = useState<HelpArticleType | null>(null);
	const [loadingCorpus, setLoadingCorpus] = useState(true);
	const [loadingArticle, setLoadingArticle] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const searchInputRef = useRef<HTMLInputElement>(null);

	const corpusFetcher = useMemo(
		() => fetchCorpus ?? (async () => window.brainstorm.help.getCorpus()),
		[fetchCorpus],
	);
	const articleFetcher = useMemo(
		() => fetchArticle ?? (async (id: string) => window.brainstorm.help.getTopic(id)),
		[fetchArticle],
	);
	const searcher = useMemo(
		() =>
			search ?? (async (text: string, limit?: number) => window.brainstorm.help.search(text, limit)),
		[search],
	);

	// KBN-S-help: the overlay is a focus-trapped dialog — Tab stays inside,
	// Escape unwinds via the shared stack (the trap replaces the bare
	// useEscapeStackEntry), and close restores focus to the opener.
	const [opener] = useState<HTMLElement | null>(() => {
		if (typeof document === "undefined") return null;
		return (document.activeElement as HTMLElement | null) ?? null;
	});
	const { containerProps: trapProps } = useFocusTrap({
		enabled: true,
		onEscape: onClose,
		restoreFocusTo: opener,
		openerLabel: "help",
	});
	useShortcut("shell/help.search", () => {
		searchInputRef.current?.focus();
		searchInputRef.current?.select();
	});

	useEffect(() => {
		let cancelled = false;
		setLoadingCorpus(true);
		corpusFetcher()
			.then((corpus) => {
				if (cancelled) return;
				setArticles(corpus.articles);
				setErrorMessage(null);
				if (!topicId && corpus.articles.length > 0) {
					const first = corpus.articles[0];
					if (first) setTopicId(first.topicId);
				}
			})
			.catch(() => {
				if (cancelled) return;
				setArticles([]);
				setErrorMessage(t("shell.help.error"));
			})
			.finally(() => {
				if (cancelled) return;
				setLoadingCorpus(false);
			});
		return () => {
			cancelled = true;
		};
	}, [corpusFetcher, setTopicId, topicId]);

	useEffect(() => {
		if (!topicId) {
			setArticle(null);
			return;
		}
		let cancelled = false;
		setLoadingArticle(true);
		articleFetcher(topicId)
			.then((next) => {
				if (cancelled) return;
				setArticle(next);
			})
			.catch(() => {
				if (cancelled) return;
				setArticle(null);
				setErrorMessage(t("shell.help.error"));
			})
			.finally(() => {
				if (cancelled) return;
				setLoadingArticle(false);
			});
		return () => {
			cancelled = true;
		};
	}, [topicId, articleFetcher]);

	const onPickHit = useCallback(
		(hit: HelpHit) => {
			setTopicId(hit.topicId);
		},
		[setTopicId],
	);

	const loading = loadingCorpus || loadingArticle;
	const [feedbackOpen, setFeedbackOpen] = useState(false);

	return (
		<div
			className="help"
			role="dialog"
			aria-modal="true"
			aria-labelledby="help-title"
			data-testid="help"
		>
			<button
				type="button"
				className="help__backdrop"
				onClick={onClose}
				aria-label={t("shell.actions.close")}
				tabIndex={-1}
			/>
			<motion.div
				{...trapProps}
				className="help__panel glass--strong"
				initial={{ x: "100%" }}
				animate={{ x: 0 }}
				exit={{ x: "100%" }}
				transition={{ type: "spring", stiffness: 360, damping: 36 }}
			>
				<aside className="help__sidebar" aria-label={t("shell.help.nav")}>
					<header className="help__sidebar-header">
						<span className="help__title-icon" aria-hidden="true">
							<Icon name={IconName.Question} size={18} />
						</span>
						<h2 id="help-title" className="help__title">
							{t("shell.help.title")}
						</h2>
					</header>
					<div className="help__sidebar-body">
						<HelpSidebar articles={articles} activeTopicId={topicId} onSelect={setTopicId} />
					</div>
				</aside>
				<div className="help__main">
					<header className="help__main-header">
						<HelpSearchbar onPick={onPickHit} search={searcher} inputRef={searchInputRef} />
						{onOpenWhatsNew && (
							<Button
								variant={ButtonVariant.Ghost}
								size={ButtonSize.Md}
								iconLeft={IconName.Sparkle}
								onClick={onOpenWhatsNew}
								data-testid="help-open-whats-new"
							>
								{t("shell.help.openWhatsNew")}
							</Button>
						)}
						<Button
							variant={ButtonVariant.Ghost}
							size={ButtonSize.Md}
							iconLeft={IconName.ArrowUpRight}
							onClick={() => window.open(GITHUB_ISSUES_URL)}
							data-testid="help-report-github"
						>
							{t("shell.help.reportOnGithub")}
						</Button>
						<Button
							variant={ButtonVariant.Ghost}
							size={ButtonSize.Md}
							onClick={() => setFeedbackOpen(true)}
							data-testid="help-send-feedback"
						>
							{t("shell.help.sendFeedback")}
						</Button>
						<IconButton icon={IconName.Close} label={t("shell.actions.close")} onClick={onClose} />
					</header>
					<div className="help__body">
						<div className="help__body-inner">
							<HelpArticle
								article={article}
								loading={loading}
								errorMessage={errorMessage}
								corpus={articles}
								onOpenTopic={setTopicId}
							/>
						</div>
					</div>
				</div>
			</motion.div>
			{feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
		</div>
	);
}
