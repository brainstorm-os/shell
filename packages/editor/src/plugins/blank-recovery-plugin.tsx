/**
 * BlankRecoveryPlugin — last-line defense against the "doc has content but the
 * editor rendered blank" race.
 *
 * `@lexical/yjs` populates Lexical from Yjs ONLY through `observeDeep` events
 * fired by the snapshot apply. The resolver carefully applies AFTER the
 * binding registers `observeDeep` (see `local-provider.ts` / `resolver.ts`),
 * but a concurrent non-binding consumer that triggers the apply early (the
 * boot-time body migration), or a cold-start timing hiccup, can land the
 * snapshot before this binding is listening — the events fire into a void and
 * the editor shows zero blocks even though the Y.Doc is full.
 *
 * Detection is unambiguous and safe: the Y.Doc's universal body has top-level
 * blocks (`length > 0`) while the Lexical root has NONE. We never seed in this
 * state (bootstrap + NormalizeEmptyDocPlugin are both gated on an EMPTY Y.Doc,
 * so neither can clobber the content), we ask the host to remount the editor.
 * A remount re-resolves the doc through the resolver's revival path (fresh
 * replica, re-applied after the new binding's `observeDeep`), which reliably
 * hydrates. The host caps remounts so a genuinely unhydratable doc can't loop.
 */

import { universalBodyBlockCount } from "@brainstorm-os/react-yjs";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot } from "lexical";
import { useEffect } from "react";
import type { Doc } from "yjs";

/** Pure predicate: the Y.Doc body has blocks but Lexical rendered none. */
export function isBlankWithContent(yjsBlocks: number, lexicalBlocks: number): boolean {
	return yjsBlocks > 0 && lexicalBlocks === 0;
}

export type BlankRecoveryPluginProps = {
	doc: Doc;
	whenLoaded?: Promise<void> | undefined;
	/** Ask the host to remount this editor (key bump). Capped host-side. */
	onRecover: () => void;
	/** Signal that the doc hydrated cleanly (content present on both sides) so
	 *  the host can release this note's spent remount budget — only a genuinely
	 *  unhydratable doc keeps the cap. */
	onHydrated?: (() => void) | undefined;
};

export function BlankRecoveryPlugin({
	doc,
	whenLoaded,
	onRecover,
	onHydrated,
}: BlankRecoveryPluginProps): null {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		let settled = false;
		const check = (): void => {
			if (settled) return;
			let yjsBlocks = 0;
			try {
				yjsBlocks = universalBodyBlockCount(doc);
			} catch {
				return;
			}
			const lexicalBlocks = editor.getEditorState().read(() => $getRoot().getChildrenSize());
			if (isBlankWithContent(yjsBlocks, lexicalBlocks)) {
				settled = true;
				onRecover();
			} else if (yjsBlocks > 0 && lexicalBlocks > 0) {
				settled = true;
				onHydrated?.();
			}
		};
		// Check once the binding has had its chance to sync: two frames past the
		// resolver's load promise (the apply fires synchronously before it
		// resolves), plus a fallback timeout for a slow first paint.
		const schedule = (): void => {
			requestAnimationFrame(() => requestAnimationFrame(check));
		};
		if (whenLoaded) whenLoaded.then(schedule, schedule);
		else schedule();
		const timer = setTimeout(check, 1000);
		return () => {
			settled = true;
			clearTimeout(timer);
		};
	}, [editor, doc, whenLoaded, onRecover, onHydrated]);
	return null;
}
