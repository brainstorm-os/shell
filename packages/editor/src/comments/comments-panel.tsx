/**
 * Shared comments panel — the one comments UI every editor app renders, so the
 * surface is identical across Notes / Journal / Tasks / Bookmarks. It consumes
 * the comments context (live list + mutation verbs) and renders threads via the
 * shared `buildThreads`: a quote-context line, the root comment, its replies, a
 * reply composer on open threads, and resolve/reopen/delete actions. A
 * document-level new-comment composer sits at the top (block-anchored creation
 * from an editor text selection is the next rung — it reuses `add`).
 *
 * Landmark + native controls only (a `region` with `<article>` threads and real
 * `<button>`s / `<textarea>`s) — no composite-keyboard roles, so native focus
 * order carries it.
 */

import {
	AttachmentKind,
	type CommentAnchor,
	type CommentDef,
	CommentKind,
	CommentStatus,
	type CommentThread,
} from "@brainstorm-os/sdk-types";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
	CompactEditor,
	type CompactEditorHandle,
	type CompactEditorPayload,
} from "../compact-editor";
import { useEditorT } from "../i18n";
import { MentionComposerPlugin } from "../mention-composer-plugin";
import { renderEditorState } from "../preview";
import { useComments } from "./comments-context";

const EMPTY_DRAFT: CompactEditorPayload = { state: "", text: "", html: "", isEmpty: true };

/** Sentinel block id for a comment anchored to the document as a whole (the
 *  panel's new-comment box), distinct from a block-anchored comment. */
export const DOCUMENT_BLOCK_ID = "__document";

/** Click-to-thread (B11.9): a request to scroll the panel to a block's thread.
 *  The `nonce` distinguishes repeat clicks on the same block, so the host just
 *  bumps it instead of clearing state between requests. */
export type CommentsFocusRequest = {
	blockId: string;
	nonce: number;
};

/** How long the focused thread keeps its highlight pulse. */
const FOCUS_PULSE_MS = 1600;

export type CommentsPanelProps = {
	/** The host document entity id — the anchor for panel-level new comments. */
	documentId: string;
	className?: string;
	/** A pending comment-on-selection anchor from the editor (B11.9). When set,
	 *  the composer targets this block (showing its quote) instead of the whole
	 *  document, and `onClearPending` fires on submit / cancel. */
	pendingAnchor?: CommentAnchor;
	onClearPending?: () => void;
	/** Click-to-thread (B11.9): scrolls the first thread anchored to the
	 *  requested block into view and pulses it. */
	focusRequest?: CommentsFocusRequest | null;
	/** Suggestion apply (B11.9): the host applies the proposed edit to its
	 *  editor (via `applySuggestionInEditor`) and returns whether it landed —
	 *  `true` resolves the thread; `false` leaves it open and the panel shows
	 *  a stale-anchor note. Absent → suggestion threads offer Reject only. */
	onApplySuggestion?: (comment: CommentDef) => boolean | Promise<boolean>;
};

export function CommentsPanel({
	documentId,
	className,
	pendingAnchor,
	onClearPending,
	focusRequest,
	onApplySuggestion,
}: CommentsPanelProps): ReactNode {
	const t = useEditorT();
	const { threads, add, mentionHost } = useComments();
	const [draft, setDraft] = useState<CompactEditorPayload>(EMPTY_DRAFT);
	// People @-mentioned in the current draft (Collab-C6), pubkey → inserted name.
	// Accumulated as rows commit, drained onto the comment on submit (filtered to
	// those whose `@Name` run survives in the text) so the mentioned people get
	// notified. Cleared on send/cancel.
	const mentionsRef = useRef<Map<string, string>>(new Map());
	// Suggest-a-change mode on the selection-anchored composer: the comment
	// body stays the rationale; `replacementDraft` is the proposed new text.
	const [suggesting, setSuggesting] = useState(false);
	const [replacementDraft, setReplacementDraft] = useState("");
	const editorRef = useRef<CompactEditorHandle | null>(null);
	const threadsRef = useRef<HTMLOListElement | null>(null);
	const [pulseBlockId, setPulseBlockId] = useState<string | null>(null);

	// Focus the composer the moment a comment-on-selection is pending so the
	// user can type the body immediately (the editor switched focus here).
	useEffect(() => {
		if (pendingAnchor) editorRef.current?.focus();
	}, [pendingAnchor]);

	// Click-to-thread: scroll the requested block's thread into view + pulse it.
	useEffect(() => {
		if (!focusRequest) return;
		// Attribute scan, not a selector — the block id is caller data and CSS
		// string escaping isn't worth a dependency for a list this small.
		const thread = [...(threadsRef.current?.querySelectorAll("[data-block-id]") ?? [])].find(
			(el) => el.getAttribute("data-block-id") === focusRequest.blockId,
		);
		thread?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
		setPulseBlockId(focusRequest.blockId);
		const timer = setTimeout(() => setPulseBlockId(null), FOCUS_PULSE_MS);
		return () => clearTimeout(timer);
	}, [focusRequest]);

	// A suggestion needs the quoted selection to anchor its edit, so the
	// toggle only shows on a selection-anchored draft.
	const canSuggest = Boolean(pendingAnchor?.quote);
	const suggestionActive = suggesting && canSuggest;

	// Shared commit for both the Enter key (CompactEditor's `onSubmit`) and the
	// Send button. Returns early (keeping the draft) when validation fails;
	// clears the surface only after a successful add.
	const commitNew = (payload: CompactEditorPayload): void => {
		const body = payload.text.trim();
		if (body.length === 0) return;
		if (suggestionActive && replacementDraft.trim().length === 0) return;
		const anchor: CommentAnchor = pendingAnchor ?? {
			entityId: documentId,
			blockId: DOCUMENT_BLOCK_ID,
		};
		// Only keep mentions whose `@Name` run still survives in the committed text
		// (a mention the author typed then deleted shouldn't notify anyone).
		const mentions = [...mentionsRef.current.entries()]
			.filter(([, name]) => body.includes(`@${name}`))
			.map(([pubkey]) => pubkey);
		void add({
			anchor,
			body,
			richBody: payload.state,
			...(mentions.length > 0 ? { mentions } : {}),
			...(suggestionActive
				? { kind: CommentKind.Suggestion, suggestion: { replacement: replacementDraft } }
				: {}),
		});
		editorRef.current?.clear();
		mentionsRef.current = new Map();
		setReplacementDraft("");
		setSuggesting(false);
		onClearPending?.();
	};

	const submitNew = (e: FormEvent): void => {
		e.preventDefault();
		editorRef.current?.submit();
	};

	const cancelPending = (): void => {
		editorRef.current?.clear();
		mentionsRef.current = new Map();
		setReplacementDraft("");
		setSuggesting(false);
		onClearPending?.();
	};

	return (
		<section
			className={className ? `bs-comments ${className}` : "bs-comments"}
			aria-label={t("editor.comments.region")}
		>
			<form className="bs-comments__composer" onSubmit={submitNew}>
				{pendingAnchor?.quote ? (
					<div className="bs-comments__pending">
						<blockquote className="bs-comments__quote">{pendingAnchor.quote}</blockquote>
						<button type="button" className="bs-comments__pending-cancel" onClick={cancelPending}>
							{t("editor.comments.pending.cancel")}
						</button>
					</div>
				) : null}
				<CompactEditor
					ref={editorRef}
					className="bs-comments__input bs-comments__input--rich"
					onChange={setDraft}
					onSubmit={commitNew}
					placeholder={t("editor.comments.new.placeholder")}
					ariaLabel={t("editor.comments.new.placeholder")}
				>
					{mentionHost ? (
						<MentionComposerPlugin
							host={mentionHost}
							ariaLabel={t("editor.comments.mention.search")}
							emptyLabel={t("editor.comments.mention.empty")}
							tokenText={(candidate) => `@${candidate.label} `}
							onSelect={(candidate) => {
								if (candidate.kind === AttachmentKind.Person) {
									mentionsRef.current.set(candidate.id, candidate.label);
								}
							}}
						/>
					) : null}
				</CompactEditor>
				{canSuggest ? (
					<label className="bs-comments__suggest-toggle">
						<input
							type="checkbox"
							checked={suggesting}
							onChange={(e) => setSuggesting(e.target.checked)}
						/>
						{t("editor.comments.suggest.toggle")}
					</label>
				) : null}
				{suggestionActive ? (
					<textarea
						className="bs-comments__input bs-comments__input--replacement"
						value={replacementDraft}
						onChange={(e) => setReplacementDraft(e.target.value)}
						placeholder={t("editor.comments.suggest.placeholder")}
						aria-label={t("editor.comments.suggest.placeholder")}
					/>
				) : null}
				<button
					type="submit"
					className="bs-comments__submit"
					disabled={draft.isEmpty || (suggestionActive && replacementDraft.trim().length === 0)}
				>
					{t("editor.comments.new.submit")}
				</button>
			</form>

			{threads.length === 0 ? (
				<p className="bs-comments__empty">{t("editor.comments.empty")}</p>
			) : (
				<ol className="bs-comments__threads" ref={threadsRef}>
					{threads.map((thread) => (
						<li key={thread.root.id}>
							<CommentThreadView
								thread={thread}
								pulse={pulseBlockId !== null && thread.root.anchor.blockId === pulseBlockId}
								{...(onApplySuggestion ? { onApplySuggestion } : {})}
							/>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

function authorLabel(comment: CommentDef, anonymous: string): string {
	return comment.authorName && comment.authorName.length > 0 ? comment.authorName : anonymous;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Compact relative age for the meta row ("just now" / "5m" / "3h" / "2d"),
 *  falling back to an absolute date past a week — a comment's exact moment
 *  matters less the older it gets, and the full datetime stays on `title`.
 *  `nowMs` is injectable for tests. */
export function commentTimeLabel(
	t: ReturnType<typeof useEditorT>,
	createdAt: number,
	nowMs: number = Date.now(),
): string {
	const delta = Math.max(0, nowMs - createdAt);
	if (delta < MINUTE_MS) return t("editor.comments.time.justNow");
	if (delta < HOUR_MS)
		return t("editor.comments.time.minutes", { count: Math.floor(delta / MINUTE_MS) });
	if (delta < DAY_MS) return t("editor.comments.time.hours", { count: Math.floor(delta / HOUR_MS) });
	if (delta < 7 * DAY_MS)
		return t("editor.comments.time.days", { count: Math.floor(delta / DAY_MS) });
	const created = new Date(createdAt);
	const sameYear = created.getFullYear() === new Date(nowMs).getFullYear();
	return created.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
	});
}

function CommentThreadView({
	thread,
	pulse,
	onApplySuggestion,
}: {
	thread: CommentThread;
	pulse?: boolean;
	onApplySuggestion?: (comment: CommentDef) => boolean | Promise<boolean>;
}): ReactNode {
	const t = useEditorT();
	const { reply, resolve, reopen, remove } = useComments();
	const [replyDraft, setReplyDraft] = useState<CompactEditorPayload>(EMPTY_DRAFT);
	const replyRef = useRef<CompactEditorHandle | null>(null);
	const [applyFailed, setApplyFailed] = useState(false);
	const resolved = thread.status === CommentStatus.Resolved;
	const isSuggestion = thread.root.kind === CommentKind.Suggestion;
	const anonymous = t("editor.comments.anonymous");

	const commitReply = (payload: CompactEditorPayload): void => {
		const body = payload.text.trim();
		if (body.length === 0) return;
		void reply(thread, body, payload.state);
		replyRef.current?.clear();
	};

	const submitReply = (e: FormEvent): void => {
		e.preventDefault();
		replyRef.current?.submit();
	};

	// Apply-then-resolve: the thread only resolves when the host confirms the
	// edit landed; a stale anchor (false) keeps it open + flags it.
	const applySuggestion = async (): Promise<void> => {
		if (!onApplySuggestion) return;
		const applied = await onApplySuggestion(thread.root);
		if (applied) {
			setApplyFailed(false);
			void resolve(thread.root.id);
		} else {
			setApplyFailed(true);
		}
	};

	return (
		<article
			className="bs-comments__thread"
			data-resolved={resolved ? "true" : undefined}
			data-block-id={thread.root.anchor.blockId}
			data-pulse={pulse ? "true" : undefined}
		>
			{thread.root.anchor.quote ? (
				<blockquote className="bs-comments__quote">{thread.root.anchor.quote}</blockquote>
			) : null}

			<CommentBody comment={thread.root} anonymous={anonymous} />
			{thread.replies.map((r) => (
				<CommentBody key={r.id} comment={r} anonymous={anonymous} isReply />
			))}

			{applyFailed ? (
				<p className="bs-comments__apply-failed" role="status">
					{t("editor.comments.applyFailed")}
				</p>
			) : null}

			<div className="bs-comments__actions">
				{resolved ? (
					<button
						type="button"
						className="bs-comments__action"
						onClick={() => void reopen(thread.root.id)}
					>
						{t("editor.comments.reopen")}
					</button>
				) : isSuggestion ? (
					<>
						{onApplySuggestion ? (
							<button
								type="button"
								className="bs-comments__action bs-comments__action--apply"
								onClick={() => void applySuggestion()}
							>
								{t("editor.comments.apply")}
							</button>
						) : null}
						<button
							type="button"
							className="bs-comments__action"
							onClick={() => void resolve(thread.root.id)}
						>
							{t("editor.comments.reject")}
						</button>
					</>
				) : (
					<button
						type="button"
						className="bs-comments__action"
						onClick={() => void resolve(thread.root.id)}
					>
						{t("editor.comments.resolve")}
					</button>
				)}
				<button
					type="button"
					className="bs-comments__action bs-comments__action--danger"
					onClick={() => void remove(thread.root.id)}
				>
					{t("editor.comments.delete")}
				</button>
			</div>

			{resolved ? null : (
				<form className="bs-comments__reply" onSubmit={submitReply}>
					<CompactEditor
						ref={replyRef}
						className="bs-comments__input bs-comments__input--rich"
						onChange={setReplyDraft}
						onSubmit={commitReply}
						placeholder={t("editor.comments.reply.placeholder")}
						ariaLabel={t("editor.comments.reply.placeholder")}
					/>
					{/* Type-to-reveal: an always-on Reply button under every open
					    thread is pure clutter; it appears once there's a draft. */}
					{!replyDraft.isEmpty ? (
						<button type="submit" className="bs-comments__submit">
							{t("editor.comments.reply.submit")}
						</button>
					) : null}
				</form>
			)}
		</article>
	);
}

function CommentBody({
	comment,
	anonymous,
	isReply,
}: {
	comment: CommentDef;
	anonymous: string;
	isReply?: boolean;
}): ReactNode {
	const t = useEditorT();
	return (
		<div
			className={isReply ? "bs-comments__comment bs-comments__comment--reply" : "bs-comments__comment"}
		>
			<div className="bs-comments__meta">
				<span className="bs-comments__author">{authorLabel(comment, anonymous)}</span>
				<time
					className="bs-comments__time"
					dateTime={new Date(comment.createdAt).toISOString()}
					title={new Date(comment.createdAt).toLocaleString()}
				>
					{commentTimeLabel(t, comment.createdAt)}
				</time>
				{comment.kind === CommentKind.Suggestion ? (
					<span className="bs-comments__tag">{t("editor.comments.suggestion")}</span>
				) : null}
				{comment.resolvedAt !== null && !isReply ? (
					<span className="bs-comments__tag bs-comments__tag--resolved">
						{t("editor.comments.resolved")}
					</span>
				) : null}
			</div>
			{comment.richBody ? (
				<div className="bs-comments__text bs-comments__text--rich bs-editor bs-editor--readonly">
					{renderEditorState(comment.richBody)}
				</div>
			) : (
				<p className="bs-comments__text">{comment.body}</p>
			)}
			{comment.kind === CommentKind.Suggestion && comment.suggestion ? (
				<p className="bs-comments__suggestion">→ {comment.suggestion.replacement}</p>
			) : null}
		</div>
	);
}
