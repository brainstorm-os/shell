/**
 * What a transclusion body needs from the Notes app to be edited in place
 * (B11.22): whether Notes holds the source (only an object Notes has loaded
 * can have its body edited here, so its denormalised title / snippet / refs
 * can follow), whether the source is read-only-locked, and where a body edit
 * lands for denormalisation.
 *
 * Provided ABOVE `<BrainstormEditor>` (decorators only see providers above the
 * composer — see `transclusion-render-context.tsx`). Absent ⇒ every
 * transclusion stays read-only.
 */

import type { SerializedEditorState } from "lexical";
import { createContext, useContext } from "react";

export type TransclusionEditHost = {
	canEdit: (entityId: string) => boolean;
	isLocked: (entityId: string) => boolean;
	onSourceChange: (entityId: string, state: SerializedEditorState) => void;
};

const TransclusionEditContext = createContext<TransclusionEditHost | null>(null);

export const TransclusionEditProvider = TransclusionEditContext.Provider;

export function useTransclusionEditHost(): TransclusionEditHost | null {
	return useContext(TransclusionEditContext);
}
