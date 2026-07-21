/**
 * `useComposerContext` — the draft-attachments state for a composer. Holds the
 * list the user is building for the NEXT turn (add on pick, remove by ref, clear
 * after send), deduped by `ref` so attaching the same document twice is a no-op.
 * Pure React state — no services — so the host wires its own search/upload.
 */

import type { MessageAttachment } from "@brainstorm-os/sdk-types";
import { useCallback, useMemo, useState } from "react";
import { attachmentKey } from "./types";

export type ComposerContextState = {
	/** The current draft attachments, in add order. */
	attachments: MessageAttachment[];
	/** Add an attachment; a duplicate `ref` is ignored (returns false). */
	add(att: MessageAttachment): boolean;
	/** Remove the attachment with this `ref`. */
	remove(ref: string): void;
	/** Drop every draft (call after a turn sends). */
	clear(): void;
	/** Whether a `ref` is already attached. */
	has(ref: string): boolean;
};

export function useComposerContext(): ComposerContextState {
	const [attachments, setAttachments] = useState<MessageAttachment[]>([]);

	const refs = useMemo(() => new Set(attachments.map(attachmentKey)), [attachments]);

	const add = useCallback((att: MessageAttachment): boolean => {
		let added = false;
		setAttachments((prev) => {
			if (prev.some((a) => attachmentKey(a) === attachmentKey(att))) return prev;
			added = true;
			return [...prev, att];
		});
		return added;
	}, []);

	const remove = useCallback((ref: string) => {
		setAttachments((prev) => prev.filter((a) => attachmentKey(a) !== ref));
	}, []);

	const clear = useCallback(() => setAttachments([]), []);

	const has = useCallback((ref: string) => refs.has(ref), [refs]);

	return { attachments, add, remove, clear, has };
}
