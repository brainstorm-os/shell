import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";
import { $collectOutline, type OutlineEntry, sameOutline } from "./outline";

/** Recompute cadence — headings change on typing, but the panel only needs
 *  to settle, not track every keystroke. */
const OUTLINE_DEBOUNCE_MS = 120;

export function OutlinePlugin({
	onChange,
}: {
	onChange: (entries: OutlineEntry[]) => void;
}): null {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		let last: OutlineEntry[] = [];
		let timer: ReturnType<typeof setTimeout> | null = null;
		const publish = (): void => {
			timer = null;
			const next = editor.getEditorState().read($collectOutline);
			if (sameOutline(last, next)) return;
			last = next;
			onChange(next);
		};
		publish();
		const unregister = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
			if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
			if (timer === null) timer = setTimeout(publish, OUTLINE_DEBOUNCE_MS);
		});
		return () => {
			unregister();
			if (timer !== null) clearTimeout(timer);
			onChange([]);
		};
	}, [editor, onChange]);
	return null;
}
