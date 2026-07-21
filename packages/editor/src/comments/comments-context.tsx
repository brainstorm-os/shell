/**
 * Comments context — holds the live comment list (driven by the adapter's
 * subscription) and exposes the mutation verbs the shared panel + (later) the
 * in-editor gutter consume. One provider per open document; every editor app
 * wires the same provider so the comments surface behaves identically.
 *
 * Like the transclusion render context, this sits wherever the host mounts it
 * (it does not need to be above `<BrainstormEditor>` because the panel renders
 * as a sibling surface, not a Lexical decorator; when the gutter decorator
 * lands it will mount the provider above the editor).
 */

import {
	type CommentAnchor,
	type CommentDef,
	type CommentThread,
	buildThreads,
	openThreadCount,
} from "@brainstorm-os/sdk-types";
import type { ComposerContextHost } from "@brainstorm-os/sdk/composer-context";
import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { AddCommentInput, CommentsAdapter } from "./comments-adapter";

export type CommentsContextValue = {
	comments: CommentDef[];
	threads: CommentThread[];
	openCount: number;
	/** Display name stamped on comments this user authors (denormalized). */
	authorName: string | undefined;
	/** Roster-backed @-mention search for the comment composer (Collab-C6), or
	 *  null when the host wired no roster (mentions disabled). */
	mentionHost: ComposerContextHost | null;
	add(input: AddCommentInput): Promise<void>;
	/** Reply to a thread — reuses the root's anchor + id as the parent.
	 *  `richBody` carries the serialized Lexical state when authored rich. */
	reply(thread: CommentThread, body: string, richBody?: string): Promise<void>;
	resolve(id: string): Promise<void>;
	reopen(id: string): Promise<void>;
	remove(id: string): Promise<void>;
};

const CommentsContext = createContext<CommentsContextValue | null>(null);

export type CommentsProviderProps = {
	adapter: CommentsAdapter;
	/** The display name stamped on authored comments. */
	authorName?: string;
	/** The author's sovereign pubkey, stamped so a mention can be attributed +
	 *  self-mentions suppressed by the notifier (Collab-C6). */
	authorPubkey?: string;
	/** Roster-backed @-mention search for the composer (Collab-C6). */
	mentionHost?: ComposerContextHost | null;
	children: ReactNode;
};

export function CommentsProvider({
	adapter,
	authorName,
	authorPubkey,
	mentionHost,
	children,
}: CommentsProviderProps): ReactNode {
	const [comments, setComments] = useState<CommentDef[]>(() => adapter.list());

	useEffect(() => {
		setComments(adapter.list());
		return adapter.subscribe(() => setComments(adapter.list()));
	}, [adapter]);

	const add = useCallback(
		(input: AddCommentInput) =>
			adapter.add({
				...(authorName !== undefined ? { authorName } : {}),
				...(authorPubkey ? { authorPubkey } : {}),
				...input,
			}),
		[adapter, authorName, authorPubkey],
	);

	const reply = useCallback(
		(thread: CommentThread, body: string, richBody?: string) => {
			const anchor: CommentAnchor = thread.root.anchor;
			return add(
				richBody !== undefined
					? { anchor, body, richBody, parentId: thread.root.id }
					: { anchor, body, parentId: thread.root.id },
			);
		},
		[add],
	);

	const value = useMemo<CommentsContextValue>(
		() => ({
			comments,
			threads: buildThreads(comments),
			openCount: openThreadCount(comments),
			authorName,
			mentionHost: mentionHost ?? null,
			add,
			reply,
			resolve: (id) => adapter.resolve(id),
			reopen: (id) => adapter.reopen(id),
			remove: (id) => adapter.remove(id),
		}),
		[comments, authorName, mentionHost, add, reply, adapter],
	);

	return <CommentsContext.Provider value={value}>{children}</CommentsContext.Provider>;
}

/** Read the comments context. Throws if used outside a `CommentsProvider` so a
 *  mis-mount is a loud failure, not a silent no-op. */
export function useComments(): CommentsContextValue {
	const ctx = useContext(CommentsContext);
	if (ctx === null) throw new Error("useComments must be used within a CommentsProvider");
	return ctx;
}
