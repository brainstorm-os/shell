/**
 * NoteContext — read + write access to the currently-open note from
 * inside the Lexical editor tree.
 *
 * The editor's built-in nodes (paragraph, heading, list…) don't need
 * the note context because their state lives in the Lexical tree
 * itself. PropertyBlockNode / PropertyListBlockNode are different:
 * they hold only a ref to a property key, and the actual value lives
 * on `StoredNote.values[propertyKey]`. Decorator components reach for
 * it through this context so the bridge isn't a prop drilled through
 * Lexical's render seams.
 *
 * Provider lives just inside `<Editor>`; the app shell hands it
 * `noteId`, the current `values` map, and a kind-narrowed `setValue`
 * callback (typically `useNotes().setValue` curried by `noteId`).
 */

import type { SelectionCommentAnchor } from "@brainstorm-os/editor";
import type { PropertyDef, PropertyValueByValueType, ValueType } from "@brainstorm-os/sdk-types";
import type { ValuesMap } from "@brainstorm-os/sdk/property-ui/pure";
import { type ReactNode, createContext, useContext, useMemo } from "react";

export type NoteContextValue = {
	noteId: string;
	values: ValuesMap;
	setValue: <V extends ValueType>(
		def: PropertyDef & { valueType: V },
		next: PropertyValueByValueType[V],
	) => void;
	/** Comment-on-selection (B11.9). The inline toolbar's "Comment" row hands
	 *  the enclosing block id + quoted text here; the app opens the Comments
	 *  tab with the composer pre-anchored. Absent when the open note has no
	 *  comments adapter (older shell). */
	onCommentSelection?: (anchor: SelectionCommentAnchor) => void;
	/** Session block ids (B11.9) with an open comment thread — the editor's
	 *  `CommentHighlightPlugin` marks these blocks. */
	commentedBlockIds?: readonly string[];
	/** Click-to-thread (B11.9). The highlight plugin's hover chip hands the
	 *  clicked block id here; the app opens the Comments tab scrolled to that
	 *  block's thread. */
	onCommentBlockClick?: (blockId: string) => void;
};

const NoteContext = createContext<NoteContextValue | null>(null);

export type NoteContextProviderProps = NoteContextValue & { children: ReactNode };

export function NoteContextProvider(props: NoteContextProviderProps) {
	const {
		noteId,
		values,
		setValue,
		onCommentSelection,
		commentedBlockIds,
		onCommentBlockClick,
		children,
	} = props;
	const value = useMemo<NoteContextValue>(
		() => ({
			noteId,
			values,
			setValue,
			...(onCommentSelection ? { onCommentSelection } : {}),
			...(commentedBlockIds ? { commentedBlockIds } : {}),
			...(onCommentBlockClick ? { onCommentBlockClick } : {}),
		}),
		[noteId, values, setValue, onCommentSelection, commentedBlockIds, onCommentBlockClick],
	);
	return <NoteContext.Provider value={value}>{children}</NoteContext.Provider>;
}

export function useNoteContext(): NoteContextValue {
	const ctx = useContext(NoteContext);
	if (!ctx) {
		throw new Error("useNoteContext: missing <NoteContextProvider>");
	}
	return ctx;
}

/** Non-throwing variant — returns `null` outside a provider. Decorator
 *  fallbacks use this so they can render a degraded view (read-only
 *  preview) when mounted in a tree without a note (e.g. in tests that
 *  exercise just the node serialization layer). */
export function useNoteContextOptional(): NoteContextValue | null {
	return useContext(NoteContext);
}
